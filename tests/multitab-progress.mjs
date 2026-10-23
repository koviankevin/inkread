import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {browserType,browserName,compatibility} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';

const root=process.cwd(),output=path.join(root,'test-results','multitab-progress');await mkdir(output,{recursive:true});
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const temporary=await mkdtemp(path.join(os.tmpdir(),'irmtabs-')),profile=path.join(temporary,'profile'),folder=path.join(temporary,'books');await mkdir(folder);
const books=[{name:'image-A',image:true,color:'green',pixel:[0,128,0,255],paragraph:6},{name:'diagram-B',graph:true,paragraph:8},{name:'formula-C',math:7,paragraph:10},{name:'mixed-D',image:true,graph:true,math:9,color:'blue',pixel:[0,0,255,255],paragraph:12}];
const body=Array.from({length:24},(_,i)=>`PARA-${String(i).padStart(3,'0')} ${'多個分頁各自閱讀不同文件，圖片圖表公式與閱讀進度都要獨立保留，離線重開仍停在自己的段落。'.repeat(8)}`).join('\n\n');
for(const b of books){
 const parts=['# '+b.name];
 if(b.image){await writeFile(path.join(folder,b.name+'.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="600"><title>${b.name}</title><rect width="720" height="600" fill="${b.color}"/></svg>`);parts.push(`![${b.name}](${b.name}.svg)`);}
 if(b.graph)parts.push('```mermaid\nflowchart TB\n A['+b.name+'] --> B[獨立進度] --> C[離線恢復]\n```');
 if(b.math)parts.push('$$\\displaystyle\\sum_{n=1}^{'+b.math+'}\\frac{1}{n^2}$$');
 parts.push(body);await writeFile(path.join(folder,b.name+'.md'),parts.join('\n\n'));
}
const server=await serveSites({reader:process.env.INKREAD_TEST_DIST||path.join(root,'dist')});const url=process.env.INKREAD_TEST_SITE||server.origin+'/reader/';
const expected={},results=[],evidence=[],errors=[],live=[],addresses={};let context,pages=[];
const options={headless:true,viewport:{width:1440,height:900},...(!compatibility&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})};
const file=(p,name)=>p.locator('#user-files button').filter({hasText:new RegExp('^'+name+'\\.md$')});
const point=p=>p.evaluate(()=>{const e=[...document.querySelectorAll('#document p')].find(e=>/^PARA-/.test(e.textContent)&&e.getBoundingClientRect().top<=150&&e.getBoundingClientRect().bottom>150),r=e?.getBoundingClientRect();return {paragraph:e?.textContent.match(/^PARA-\d+/)?.[0],fraction:r?(150-r.top)/r.height:null};});
async function launch(offline=false){context=await browserType.launchPersistentContext(profile,options);context.setDefaultTimeout(45000);context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));if(offline)await context.setOffline(true);}
async function page(offline=false){const p=await context.newPage();await p.goto(url,{waitUntil:'domcontentloaded'});await p.locator('#app:not([hidden])').waitFor();assert((await p.locator('.version').textContent()).includes('v'+version));if(offline)assert.equal(await p.evaluate(()=>navigator.onLine),false);return p;}
async function saved(p){await p.locator('#library-status[data-state=saved]').waitFor();}
async function media(p,b){
 assert.equal(await p.locator('#document h1').textContent(),b.name);
 if(b.image){const i=p.locator('#document img');await i.evaluate(e=>e.decode());assert((await i.getAttribute('src')).startsWith('blob:'));assert.equal(await i.getAttribute('alt'),b.name);assert(await i.evaluate(e=>e.naturalWidth===720&&e.naturalHeight===600));assert.deepEqual(await i.evaluate(e=>{const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');g.drawImage(e,0,0);return [...g.getImageData(0,0,1,1).data];}),b.pixel);}
 if(b.graph){await p.locator('.mermaid-container svg').waitFor();assert((await p.locator('.mermaid-container svg').textContent()).includes(b.name));}
 if(b.math){await p.locator('.katex').waitFor();assert((await p.locator('.katex').textContent()).includes(String(b.math)));assert.equal(await p.locator('#document [data-math-index]').count(),0);await p.waitForFunction(()=>[...document.fonts].some(f=>f.family.startsWith('KaTeX')&&f.status==='loaded'));}
 await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
}
async function select(p,b){await p.bringToFront();await file(p,b.name).click();await media(p,b);await saved(p);}
function same(actual,wanted,label){assert.equal(actual.paragraph,wanted.paragraph,label+' paragraph');assert(Math.abs(actual.fraction-wanted.fraction)<.035,label+' internal fraction');}
async function move(p,b,n,wait=true){
 await p.bringToFront();await p.evaluate(()=>{window.__qaTabWheel=false;addEventListener('wheel',()=>window.__qaTabWheel=true,{once:true});});await p.mouse.move(1000,700);await p.mouse.wheel(0,1);await p.waitForFunction(()=>window.__qaTabWheel);
 await p.locator('#document p').filter({hasText:new RegExp('^PARA-'+String(n).padStart(3,'0')+' ')}).evaluate(e=>scrollTo({top:scrollY+e.getBoundingClientRect().top+e.getBoundingClientRect().height*.35-150,behavior:'instant'}));
 await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const actual=await point(p);assert.equal(actual.paragraph,'PARA-'+String(n).padStart(3,'0'));expected[b.name]=actual;
 if(wait){await p.waitForTimeout(650);await saved(p);}return actual;
}
// Keep actual IDB writes queued during simultaneous shutdown. An empty popup
// inherits the reader's origin and holds a readwrite transaction using GET only.
// It never changes records, supplies reader HTML, or calls application save.
// Close the readers first, then the browser (including this gate), so the test
// deterministically exercises shutdown recovery before queued writes can finish.
async function holdStorage(p){
 const opened=context.waitForEvent('page');await p.evaluate(()=>window.open('about:blank','inkread-qa-storage-gate'));
 const gate=await opened;const name='inkread-library:'+new URL('./',url).href;
 await gate.evaluate(async name=>{
  const request=indexedDB.open(name,1);
  const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const tx=db.transaction('positions','readwrite');
  await new Promise((resolve,reject)=>{
   let started=false;const read=()=>{
    const r=tx.objectStore('positions').get('__qa_storage_gate_read_only__');
    r.onsuccess=()=>{if(!started){started=true;resolve();}read();};r.onerror=()=>reject(r.error);
   };tx.onabort=()=>reject(tx.error);read();
  });
 },name);
}
async function closePage(p){const done=p.waitForEvent('close');await p.close({runBeforeUnload:true});await done;}
async function closeAll(order){if(order==='simultaneous')await Promise.all(pages.map(closePage));else for(const i of order)await closePage(pages[i]);for(let i=0;i<pages.length;i++)addresses[books[i].name]=pages[i].url();pages=[];await context.close();context=undefined;}
async function verifyRecovery(phase){
 await launch(true);pages=[];
 for(const b of books){
  // Reopen the real URL retained by this tab, without clicking a library file.
  const p=await context.newPage();await p.goto(addresses[b.name],{waitUntil:'domcontentloaded'});
  await p.locator('#app:not([hidden])').waitFor();assert((await p.locator('.version').textContent()).includes('v'+version));
  assert.equal(await p.evaluate(()=>navigator.onLine),false);await media(p,b);await saved(p);
  const actual=await point(p);same(actual,expected[b.name],phase+' automatic '+b.name);
  pages.push(p);results.push(phase+': '+b.name);evidence.push({phase,name:b.name,url:p.url(),expected:expected[b.name],actual});
  console.log('PASS '+results.at(-1));await p.screenshot({path:path.join(output,browserName+'-'+phase+'-'+b.name+'.png')});
 }
}
try{
 await launch();const p=await page();await p.locator('#offline-status[data-state=ready]').waitFor({timeout:120000});await p.locator('#folder-input').setInputFiles(folder);await p.waitForFunction(()=>document.querySelectorAll('#user-files button').length===4);
 pages=[p];for(let i=0;i<books.length;i++){const q=i?await page():p;if(i)pages.push(q);await select(q,books[i]);await move(q,books[i],books[i].paragraph);console.log('SEED '+books[i].name);}
 for(const [phase,order]of [['oldest-first',[0,1,2,3]],['oldest-last',[3,2,1,0]],['simultaneous','simultaneous']]){
  console.log('START '+phase);
  if(phase==='simultaneous')await holdStorage(pages[0]);
  for(let i=0;i<books.length;i++){
   // In oldest-last, leave the older first tab untouched while newer tabs save.
   if(!(phase==='oldest-last'&&i===0))await move(pages[i],books[i],books[i].paragraph+(phase==='oldest-first'?1:phase==='oldest-last'?2:3),phase!=='simultaneous');
   for(let j=0;j<i;j++)same(await point(pages[j]),expected[books[j].name],phase+' live '+books[j].name);
  }
  const before=await Promise.all(pages.map(async(q,i)=>({name:books[i].name,point:await point(q),state:await q.locator('#library-status').getAttribute('data-state'),visibility:await q.evaluate(()=>document.visibilityState)})));
  for(const x of before)same(x.point,expected[x.name],phase+' before close '+x.name);live.push({phase,pages:before});
  if(phase==='simultaneous')assert(before.every(x=>x.state==='saving'),'All four document saves must still be queued at concurrent closure');
  for(let i=0;i<books.length;i++)addresses[books[i].name]=pages[i].url();
  await closeAll(order);await verifyRecovery(phase);
 }
 assert.equal(results.length,12);assert.deepEqual(errors,[]);
 await writeFile(path.join(output,browserName+'-results.json'),JSON.stringify({browser:browserName,version,site:url,passed:results.length,results,evidence,live,errors,tabs:4,offlineMethod:'native context.setOffline(true) before navigation after full persistent browser restart',note:'No app storage writes or save calls from test hooks; the simultaneous phase holds a real IDB transaction with GET requests only, keeping periodic writes queued until all reader pages close. Input acknowledgment is observation only. Each recovery reopens the actual URL retained by each tab; no library-file selection or application-storage injection occurs after restart.'},null,2));
}catch(e){await writeFile(path.join(output,browserName+'-failure.json'),JSON.stringify({error:e.stack,results,evidence,live,errors,expected},null,2));await context?.pages().at(-1)?.screenshot({path:path.join(output,browserName+'-failure.png')}).catch(()=>{});throw e;}
finally{await context?.close();await server.close();assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
