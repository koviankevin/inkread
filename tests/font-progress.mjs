import {browserType,browserName,compatibility} from './browser-compat.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveSites} from './site-server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'test-results',...(compatibility?[browserName]:[]));
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'font-progress-'));
const profile=path.join(temporary,'profile'),results=[],errors=[],points={};
let unavailable=false,context;
const server=await serveSites({reader:process.env.INKREAD_TEST_DIST||path.join(root,'dist')},{intercept:pathname=>unavailable?{status:503}:pathname==='/observer/'?{body:'<!doctype html><title>Library observer</title>',headers:{'Content-Type':'text/html'}}:undefined});
const url=server.origin+'/reader/';
const options={executablePath:!compatibility?process.env.CHROMIUM_PATH||undefined:undefined,headless:true,viewport:{width:1440,height:900}};
const pass=name=>{results.push(name);console.log('PASS '+name);};
async function launch(offline=false){
  context=await browserType.launchPersistentContext(profile,options);
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  await context.route('**/*',r=>r.request().url().startsWith(server.origin+'/')||/^(blob:|data:)/.test(r.request().url())?r.continue():r.abort());
  if(offline&&!compatibility)await context.setOffline(true);
  const p=await context.newPage();await p.goto(url);await p.locator('#app:not([hidden])').waitFor();return p;
}
async function saved(p){
  await p.locator('#library-status[data-state=saved]').waitFor();
  await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
}
async function point(p){return p.evaluate(()=>{
  const paras=[...document.querySelectorAll('#document p')].filter(p=>/^PARA-\d+/.test(p.textContent));
  const el=paras.find(p=>{const r=p.getBoundingClientRect();return r.top<=150&&r.bottom>150;});
  const r=el?.getBoundingClientRect();return {paragraph:el?.textContent.match(/^PARA-\d+/)?.[0],fraction:r?(150-r.top)/r.height:null,font:document.getElementById('font-size').textContent};
});}
async function at(p,id){
  await p.locator('#document p').filter({hasText:new RegExp('^'+id+' ')}).evaluate(el=>scrollTo({top:scrollY+el.getBoundingClientRect().top+el.getBoundingClientRect().height*.35-150,behavior:'instant'}));
  // The scroll handler and its real 500ms persistence timer must run.
  await p.waitForTimeout(650);await saved(p);return point(p);
}
async function samePoint(p,expected){
  await saved(p);const actual=await point(p);
  assert.equal(actual.paragraph,expected.paragraph,'Reflow must preserve the actual paragraph');
  assert(Math.abs(actual.fraction-expected.fraction)<.035,'Reflow must preserve the place within the paragraph');
  return actual;
}
try{
  let page=await launch();await page.locator('#font-minus').click();await page.locator('#font-minus').click();
  const width=await page.locator('#document').evaluate(el=>el.clientWidth);
  const short='閱讀內容需要保留相同段落。'.repeat(8).slice(0,Math.floor(width/16)-10);
  const long='調整字級之後，文字換行會改變，但我們希望繼續閱讀同一段內容。'.repeat(6);
  const body=Array.from({length:100},(_,i)=>`PARA-${String(i).padStart(3,'0')} ${i<50?short:long}`).join('\n\n');
  for(const name of ['one','two']){
    await page.locator('#file-input').setInputFiles({name:name+'.md',mimeType:'text/markdown',buffer:Buffer.from('# '+name+'\n\n## 長章節\n\n'+body)});await saved(page);
    points[name]=await at(page,name==='one'?'PARA-065':'PARA-070');
  }
  await page.locator('#user-files button').filter({hasText:'one.md'}).click();await samePoint(page,points.one);
  await page.locator('#offline-status[data-state=ready]').waitFor({timeout:90000});
  await page.goto(server.origin+'/observer/');
  // Recreate the exact legacy schema after unloading the reader, so pagehide
  // cannot add the new optional field back before the next startup.
  await page.evaluate(async url=>{
    const name=`inkread-library:${url}`,r=indexedDB.open(name,1);
    const db=await new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const tx=db.transaction('positions','readwrite'),rows=tx.objectStore('positions').getAll();
    rows.onsuccess=()=>{for(const row of rows.result){delete row.fontSize;delete row.block;tx.objectStore('positions').put(row);}};
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    const key=name+':checkpoint',checkpoint=JSON.parse(localStorage.getItem(key)||'null');
    if(checkpoint?.position){delete checkpoint.position.fontSize;delete checkpoint.position.block;localStorage.setItem(key,JSON.stringify(checkpoint));}
    localStorage.removeItem('inkread-font-size-choice');
    if(localStorage.getItem('inkread-font-size')!=='16')throw Error('Legacy seed must be 16px');
  },url);
  await context.close();context=undefined;unavailable=true;
  page=await launch(true);assert.equal(await page.locator('#font-size').textContent(),'18');
  points.upgrade=await samePoint(page,points.one);
  pass('Legacy progress without font metadata keeps the same paragraph and place after 16 to 18 offline migration');
  await context.close();context=undefined;page=await launch(true);
  points.restart=await samePoint(page,points.one);
  pass('A second offline browser restart preserves the migrated reading paragraph');
  await page.locator('#user-files button').filter({hasText:'two.md'}).click();
  points.other=await samePoint(page,points.two);
  pass('Unopened legacy documents retain their original font metadata across the first migration and browser restart');
  for(const [name,viewport] of [['portrait18',{width:390,height:844}],['landscape18',{width:844,height:390}]]){
    await page.setViewportSize(viewport);await page.waitForTimeout(800);
    points[name]=await samePoint(page,points.other);
    pass(name+' viewport preserves the migrated 18px paragraph');
  }
  await page.locator('#font-minus').click();await page.locator('#font-minus').click();
  // Establish the saved 16px checkpoint for this legacy-schema regression.
  // reading-controls.mjs separately verifies changes without repositioning.
  points.manual=await at(page,points.two.paragraph);assert.equal(points.manual.font,'16');
  pass('Progress saved after choosing 16px records its actual reading font');
  await context.close();context=undefined;page=await launch(true);
  points.manualRestart=await samePoint(page,points.manual);assert.equal(points.manualRestart.font,'16');
  pass('Manual 16px and its paragraph survive a complete offline browser restart');
  for(const [name,viewport] of [['desktopNarrow',{width:1000,height:700}],['portrait',{width:390,height:844}],['landscape',{width:844,height:390}],['portraitAgain',{width:390,height:844}]]){
    await page.setViewportSize(viewport);await page.waitForTimeout(800);
    points[name]=await samePoint(page,points.manual);
    pass(name+' viewport reflow preserves the actual paragraph and its internal position');
  }
  await context.close();context=undefined;options.viewport={width:844,height:390};page=await launch(true);
  points.resizedRestart=await samePoint(page,points.manual);
  pass('Offline browser restart in another orientation restores the same paragraph');
  for(const viewport of [{width:1100,height:600},{width:700,height:900},{width:1440,height:600}]) await page.setViewportSize(viewport);
  await page.waitForTimeout(800);points.rapidResize=await samePoint(page,points.manual);
  pass('Rapid consecutive width and height changes preserve the same paragraph');
  await page.setViewportSize({width:390,height:844});
  await page.goto(server.origin+'/observer/').catch(()=>{});
  await context.close();context=undefined;options.viewport={width:1000,height:700};page=await launch(true);
  points.checkpointRestart=await samePoint(page,points.manual);
  pass('Closing immediately after resize checkpoints the paragraph for offline restart');
  await page.evaluate(()=>scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
  await page.waitForTimeout(650);await saved(page);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(800);
  await context.close();context=undefined;options.viewport={width:844,height:390};page=await launch(true);await saved(page);
  assert(await page.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-5));
  pass('End-of-document remains at the end after resize and offline restart');
  assert.deepEqual(errors,[]);
}catch(error){
  const page=context?.pages().findLast(p=>p.url().startsWith(url));
  const offlineStatus=page ? await page.locator('#offline-status').textContent().catch(()=>null) : null;
  await writeFile(path.join(output,'font-progress-failure.json'),JSON.stringify({error:String(error),points,actual:page?await point(page):null,offlineStatus,errors},null,2));
  if(page)await page.screenshot({path:path.join(output,'font-progress-failure.png')});
  throw error;
}finally{
  await writeFile(path.join(output,'font-progress-results.json'),JSON.stringify({browser:browserName,passed:results.length,results,points,offlineMethod:compatibility?'HTTP 503 origin':'context.setOffline',uncaughtErrors:errors},null,2));
  await context?.close();await server.close();
  if(!temporary.startsWith(output+path.sep))throw Error('Unsafe temporary cleanup');await rm(temporary,{recursive:true,force:true});
}
