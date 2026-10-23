import {browserType,browserName,compatibility} from './browser-compat.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveSites} from './site-server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'test-results',...(compatibility?[browserName]:[]));
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'reading-controls-'));
const profile=path.join(temporary,'profile'),extension=path.join(temporary,'zoom-extension');
const results=[],errors=[],points={},zooms=[];
let context,worker,unavailable=false;
const server=await serveSites({reader:process.env.INKREAD_TEST_DIST||path.join(root,'dist')},{intercept:()=>unavailable?{status:503}:undefined});
const url=server.origin+'/reader/';
if(!compatibility){
  await mkdir(extension);
  // No host, tabs, scripting or other permissions. Only this disposable profile
  // is launched with the QA extension, which exercises actual browser zoom.
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Inkread isolated zoom QA',version:'1.0',background:{service_worker:'background.js'}}));
  await writeFile(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});chrome.runtime.onStartup.addListener(()=>{});');
}
const options=compatibility ? {headless:true,viewport:{width:1440,height:900}} : {headless:true,channel:'chromium',viewport:null,args:['--window-size=1440,1000',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]};
const pass=name=>{results.push(name);console.log('PASS '+name);};
async function launch(offline=false){
  context=await browserType.launchPersistentContext(profile,options);
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  await context.route('**/*',r=>r.request().url().startsWith(server.origin+'/')||/^(blob:|data:)/.test(r.request().url())?r.continue():r.abort());
  if(offline&&!compatibility)await context.setOffline(true);
  if(!compatibility)worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension:')) || await context.waitForEvent('serviceworker',{predicate:w=>w.url().startsWith('chrome-extension:')});
  const p=await context.newPage();await p.goto(url);await p.locator('#app:not([hidden])').waitFor();return p;
}
async function saved(p){await p.locator('#library-status[data-state=saved]').waitFor();await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});}
async function point(p){return p.evaluate(()=>{
  const el=[...document.querySelectorAll('#document p')].find(el=>{const r=el.getBoundingClientRect();return r.top<=150&&r.bottom>150;});
  const r=el?.getBoundingClientRect();return {paragraph:el?.textContent.match(/^PARA-\d+/)?.[0],fraction:r?(150-r.top)/r.height:null,font:Number(document.getElementById('font-size').textContent),width:innerWidth,dpr:devicePixelRatio};
});}
async function same(p,expected){
  await saved(p);const actual=await point(p);
  assert.equal(actual.paragraph,expected.paragraph,'Control must preserve the actual paragraph');
  assert(Math.abs(actual.fraction-expected.fraction)<.035,`Control must preserve within-paragraph position: ${JSON.stringify({expected,actual})}`);
  return actual;
}
async function font(p,size,expected){
  while(Number(await p.locator('#font-size').textContent())!==size){
    const before=Number(await p.locator('#font-size').textContent()),button=p.locator(before<size?'#font-plus':'#font-minus');
    const rect=await button.boundingBox();assert(rect && rect.y>=0 && rect.y+rect.height<=(await p.evaluate(()=>innerHeight)),'Font control must remain visible at the original paragraph');
    await button.click();await p.waitForTimeout(100);
    assert.equal(Number(await p.locator('#font-size').textContent()),before+(before<size?1:-1));
    await same(p,expected);
  }
  await p.waitForTimeout(650);return same(p,expected);
}
async function zoom(p,factor){
  await p.bringToFront();
  const actual=await worker.evaluate(async factor=>{const[t]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.tabs.setZoom(t.id,factor);return chrome.tabs.getZoom(t.id);},factor);
  assert(Math.abs(actual-factor)<1e-6);await p.waitForTimeout(700);
  const metrics=await point(p);zooms.push({factor:actual,...metrics});return metrics;
}
try{
  let page=await launch();
  await saved(page);await page.locator('#font-plus').click();await page.waitForTimeout(650);
  assert.equal(await page.evaluate(()=>scrollY),0,'Changing font at the page start must keep the page start');
  await page.locator('#font-minus').click();await page.waitForTimeout(650);await saved(page);
  pass('Font changes at the page start remain at the page start');
  const body=Array.from({length:100},(_,i)=>`PARA-${String(i).padStart(3,'0')} ${'調整字級之後，文字換行會改變，但我們希望繼續閱讀同一段內容。'.repeat(i<50?1:6)}`).join('\n\n');
  await page.locator('#file-input').setInputFiles({name:'controls.md',mimeType:'text/markdown',buffer:Buffer.from('# Reading\n\n## Chapter\n\n'+body)});await saved(page);
  await page.locator('#offline-status[data-state=ready]').waitFor({timeout:90000});
  await page.locator('#document p').filter({hasText:/^PARA-070 /}).evaluate(el=>scrollTo({top:scrollY+el.getBoundingClientRect().top+el.getBoundingClientRect().height*.35-150,behavior:'instant'}));
  await page.waitForTimeout(650);await saved(page);points.original=await point(page);
  // Native keyboard activation isolates font reflow from locator auto-scrolling.
  await page.locator('#font-plus').evaluate(el=>el.focus({preventScroll:true}));await page.keyboard.press('Space');await page.waitForTimeout(650);
  points.keyboard=await same(page,points.original);assert.equal(points.keyboard.font,19);
  pass('Keyboard font activation preserves the same paragraph and within-paragraph position');
  points.large=await font(page,22,points.original);pass('Visible font buttons preserve the paragraph while increasing to 22px');
  points.small=await font(page,13,points.original);pass('Visible font buttons preserve the paragraph while decreasing to 13px');
  points.normal=await font(page,18,points.original);pass('Repeated font changes do not accumulate reading-position drift');
  await context.close();context=undefined;unavailable=true;page=await launch(true);
  points.restart=await same(page,points.original);assert.equal(points.restart.font,18);pass('Manual font changes survive complete offline browser restart at the same paragraph');
  await font(page,22,points.original);await context.close();context=undefined;page=await launch(true);
  points.largeRestart=await same(page,points.original);assert.equal(points.largeRestart.font,22);pass('22px and the original paragraph survive offline browser restart');
  await font(page,13,points.original);await context.close();context=undefined;page=await launch(true);
  points.smallRestart=await same(page,points.original);assert.equal(points.smallRestart.font,13);pass('13px and the original paragraph survive offline browser restart');
  // Actual wheel input must replace the retained logical point after the user moves.
  const delta=await page.locator('#document p').filter({hasText:/^PARA-075 /}).evaluate(el=>el.getBoundingClientRect().top+el.getBoundingClientRect().height*.35-150);
  await page.mouse.move((await page.evaluate(()=>innerWidth))*.6,250);await page.mouse.wheel(0,delta);await page.waitForTimeout(800);await saved(page);
  points.userScroll=await point(page);assert.equal(points.userScroll.paragraph,'PARA-075');
  await font(page,18,points.userScroll);pass('Real user scrolling replaces the old position before the next font change');
  if(!compatibility){
    const base=await point(page);
    for(const factor of [.8,1.25,1.5,2,1]){
      const actual=await zoom(page,factor);assert(Math.abs(actual.width-base.width/factor)<4);assert(Math.abs(actual.dpr-base.dpr*factor)<.01);
      await same(page,points.userScroll);pass(`Real browser zoom ${factor*100}% preserves the paragraph and internal position`);
    }
    await zoom(page,1.5);await context.close();context=undefined;page=await launch(true);
    const persisted=await worker.evaluate(async()=>{const[t]=await chrome.tabs.query({active:true,currentWindow:true});return chrome.tabs.getZoom(t.id);});assert(Math.abs(persisted-1.5)<1e-6);
    points.zoomRestart=await same(page,points.userScroll);pass('Browser zoom persists at 150% across offline browser restart with the same paragraph');
    await font(page,22,points.userScroll);await zoom(page,.8);await font(page,13,points.userScroll);await zoom(page,2);await zoom(page,1);
    await context.close();context=undefined;page=await launch(true);points.combinedRestart=await same(page,points.userScroll);assert.equal(points.combinedRestart.font,13);
    pass('Combined font and real browser zoom changes preserve progress after another offline restart');
  }
  const checkpoint=await page.evaluate(()=>{
    document.querySelector('.offline-state').style.minHeight='200px';
    const el=[...document.querySelectorAll('#document p')].find(el=>el.textContent.startsWith('PARA-075 '));
    scrollTo({top:scrollY+el.getBoundingClientRect().top+el.getBoundingClientRect().height*.35-150,behavior:'instant'});
    window.dispatchEvent(new Event('pagehide'));
    const row=JSON.parse(localStorage.getItem('inkread-library:'+new URL('./',location.href).href+':checkpoint')).position;
    return {paragraph:document.getElementById('document').children[row.block.index].textContent.match(/^PARA-\d+/)?.[0],fraction:row.block.fraction};
  });
  assert.equal(checkpoint.paragraph,'PARA-075','Header-only same-frame reflow must checkpoint the actual paragraph');
  assert(Math.abs(checkpoint.fraction-.35)<.035);
  points.headerCheckpoint=await point(page);
  await context.close();context=undefined;page=await launch(true);points.headerRestart=await same(page,points.headerCheckpoint);
  pass('Header-only layout change checkpoints the real paragraph before observers and restores it offline');
  await page.evaluate(()=>scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));await page.waitForTimeout(650);await saved(page);
  for(let i=Number(await page.locator('#font-size').textContent());i<22;i++){await page.locator('#font-plus').click();await page.waitForTimeout(100);}
  if(!compatibility)await zoom(page,1.25);
  await page.waitForTimeout(650);await context.close();context=undefined;page=await launch(true);await saved(page);
  assert(await page.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-5));pass('Document end survives manual font changes, zoom and offline restart');
  assert.deepEqual(errors,[]);
}catch(error){
  const p=context?.pages().findLast(p=>p.url().startsWith(url));
  await writeFile(path.join(output,'reading-controls-failure.json'),JSON.stringify({error:String(error),points,actual:p?await point(p):null,zooms,errors},null,2));
  if(p)await p.screenshot({path:path.join(output,'reading-controls-failure.png')});throw error;
}finally{
  await writeFile(path.join(output,'reading-controls-results.json'),JSON.stringify({browser:browserName,passed:results.length,results,points,zooms,zoomMethod:compatibility?'Not run; browser zoom is Chromium-only':'chrome.tabs.setZoom in a permission-free disposable QA profile',offlineMethod:compatibility?'HTTP 503 origin':'context.setOffline',uncaughtErrors:errors},null,2));
  await context?.close();await server.close();if(!temporary.startsWith(output+path.sep))throw Error('Unsafe temporary cleanup');await rm(temporary,{recursive:true,force:true});
}
