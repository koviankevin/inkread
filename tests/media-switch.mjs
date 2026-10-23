import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {browserType,browserName,compatibility} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';

const root=process.cwd(),output=path.join(root,'test-results','media-switch');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(os.tmpdir(),'irswitch-'));
const profile=path.join(temporary,'profile'),folder=path.join(temporary,'books');
await mkdir(folder);
// Hold real requests at the local HTTP server. On a deployed site, a disposable
// browser's non-forwarding proxy does the same; no TLS interception or OS change.
const held=new Set(),sockets=new Set();
const server=await serveSites({reader:process.env.INKREAD_TEST_DIST||path.join(root,'dist')},{intercept:async pathname=>{
 if(pathname.startsWith('/reader/__qa_switch__/'))await new Promise(resolve=>held.add(resolve));
}});
const proxy=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const remote=process.env.INKREAD_TEST_SITE;
const url=remote||server.origin+'/reader/',origin=new URL(url).origin,pendingBase=new URL('__qa_switch__/',url).href;
const kinds=['image','diagram','formula','mixed'],images={},expected={};
const body=Array.from({length:14},(_,i)=>`PARA-${String(i).padStart(3,'0')} ${'在媒體還沒完成時切換文件，每份文件都應保有自己的圖片、公式與閱讀段落。'.repeat(9)}`).join('\n\n');
for(const kind of kinds)for(const side of ['A','B']){
 const name=kind+'-'+side;
 const image=`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="600"><title>${name}${'x'.repeat(Object.keys(images).length)}</title><rect width="720" height="600" fill="${side==='A'?'green':'blue'}"/></svg>`;
 images[name]=Buffer.byteLength(image);
 await writeFile(path.join(folder,name+'.svg'),image);
 const graph='```mermaid\nflowchart TB\n A['+name+'] --> B[閱讀] --> C[完成]\n```';
 const formula='$$\\displaystyle\\sum_{n=1}^{'+(side==='A'?'8':'9')+'}\\frac{1}{n^2}$$';
 const media=[...(kind==='image'||kind==='mixed'?[`![${name}](${name}.svg)`]:[]),...(kind==='diagram'||kind==='mixed'?[graph]:[]),...(kind==='formula'||kind==='mixed'?[formula]:[])].join('\n\n');
 await writeFile(path.join(folder,name+'.md'),'# '+name+'\n\n[切換文件]('+kind+'-'+(side==='A'?'B':'A')+'.md)\n\n'+media+'\n\n'+body);
}
await writeFile(path.join(folder,'hub.md'),'# hub\n\n選擇另一份文件。');
let context,inFlight;const results=[],evidence=[],errors=[],unloads=[];
const options={headless:true,viewport:{width:1440,height:900},...(!compatibility&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})};
async function launch(kind,offline=false,touch=false){
 context=await browserType.launchPersistentContext(profile,{...options,hasTouch:touch,...(kind&&remote?{proxy:{server:'http://127.0.0.1:'+proxy.address().port}}:{})});
 context.__pending=[];
 context.__pendingSeen=new Promise(resolve=>context.__notifyPending=resolve);
 context.on('page',p=>{
  p.on('pageerror',e=>errors.push(e.message));
  p.on('request',r=>{if(r.url().startsWith(pendingBase)){context.__pending.push(r.url());context.__notifyPending();}});
 });
 if(kind)await context.addInitScript(({kind,pendingBase,imageSize})=>{
  const retained=[],objectURLs=new Map();let holding=true;
  const descriptor=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');
  Object.defineProperty(HTMLScriptElement.prototype,'src',{...descriptor,set(value){
   const u=new URL(value,document.baseURI);
   if(holding&&((kind==='diagram'&&u.pathname.endsWith('/diagrams.js'))||((kind==='formula'||kind==='mixed')&&/\/(?:math|diagrams)\.js$/.test(u.pathname)))){
    retained.push({element:this,value,set:descriptor.set});value=pendingBase+u.pathname.split('/').at(-1);
   }
   descriptor.set.call(this,value);
  }});
  if(kind==='image'||kind==='mixed'){
   const original=URL.createObjectURL.bind(URL),d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
   URL.createObjectURL=blob=>{const value=original(blob);if(holding&&blob.type==='image/svg+xml'&&blob.size===imageSize){const pending=pendingBase+'picture-'+objectURLs.size+'.svg';objectURLs.set(pending,value);return pending;}return value;};
   Object.defineProperty(HTMLImageElement.prototype,'src',{...d,set(value){if(objectURLs.has(value))retained.push({element:this,value:objectURLs.get(value),set:d.set});d.set.call(this,value);}});
  }
  window.__qaRelease=()=>{
   holding=false;
   for(const {element,value,set}of retained){
    if(element instanceof HTMLScriptElement){
     // An already-started script does not reliably refetch when src changes.
     // Complete its original loader callbacks with the real cached engine.
     const replacement=document.createElement('script');replacement.async=true;
     replacement.onload=element.onload;replacement.onerror=element.onerror;
     set.call(replacement,value);element.replaceWith(replacement);
    }else set.call(element,value);
   }
  };
  window.__qaPending=()=>({images:[...document.querySelectorAll('#document img')].filter(i=>!i.complete||!i.naturalWidth).length,diagrams:document.querySelectorAll('#document [data-diagram-index]').length&&!document.querySelector('#document .mermaid-container svg'),formulas:document.querySelectorAll('#document [data-math-index]').length});
 },{kind,pendingBase,imageSize:images[kind+'-A']});
 // Firefox's routing/offline combination prevents SW navigation on a restarted
 // persistent context; native offline is tested without routing on that engine.
 if(!kind&&!(offline&&browserName==='firefox'))await context.route('**/*',route=>route.request().url().startsWith(origin+'/')||/^(blob:|data:)/.test(route.request().url())?route.continue():route.abort());
 if(offline)await context.setOffline(true);
 const p=await context.newPage();await p.goto(url,{waitUntil:'domcontentloaded'});await p.locator('#app:not([hidden])').waitFor();
 if(offline)assert.equal(await p.evaluate(()=>navigator.onLine),false);
 return p;
}
const button=(p,name)=>p.locator('#user-files button').filter({hasText:new RegExp('^'+name+'\\.md$')});
const point=p=>p.evaluate(()=>{const el=[...document.querySelectorAll('#document p')].find(e=>/^PARA-/.test(e.textContent)&&e.getBoundingClientRect().top<=150&&e.getBoundingClientRect().bottom>150),r=el?.getBoundingClientRect();return {paragraph:el?.textContent.match(/^PARA-\d+/)?.[0],fraction:r?(150-r.top)/r.height:null};});
async function at(p,n){await p.locator('#document p').filter({hasText:new RegExp('^PARA-'+String(n).padStart(3,'0')+' ')}).evaluate(e=>scrollTo({top:scrollY+e.getBoundingClientRect().top+e.getBoundingClientRect().height*.35-150,behavior:'instant'}));return point(p);}
async function media(p,name){
 const [kind,side]=name.split('-');assert.equal(await p.locator('#document h1').textContent(),name);
 if(kind==='image'||kind==='mixed'){
  const img=p.locator('#document img');await img.evaluate(i=>i.decode());
  assert((await img.getAttribute('src')).startsWith('blob:'));
  assert(await img.evaluate(i=>i.naturalWidth===720&&i.naturalHeight===600));
  assert.equal(await img.getAttribute('alt'),name);
  const pixel=await img.evaluate(i=>{const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');g.drawImage(i,0,0);return [...g.getImageData(0,0,1,1).data];});
  assert.deepEqual(pixel,side==='A'?[0,128,0,255]:[0,0,255,255],'Each document must retain its own image pixels');
 }
 if(kind==='diagram'||kind==='mixed'){await p.locator('.mermaid-container svg').waitFor();assert((await p.locator('.mermaid-container svg').textContent()).includes(name));}
 if(kind==='formula'||kind==='mixed'){await p.locator('.katex').waitFor();assert((await p.locator('.katex').textContent()).includes(side==='A'?'8':'9'));assert.equal(await p.locator('#document [data-math-index]').count(),0);await p.waitForFunction(()=>[...document.fonts].some(f=>f.family.startsWith('KaTeX')&&f.status==='loaded'));}
 await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
}
async function stable(p,name){
 await media(p,name);await p.locator('#library-status[data-state=saved]').waitFor();
 const actual=await point(p);assert.equal(actual.paragraph,expected[name].paragraph,name+' must keep its own paragraph');assert(Math.abs(actual.fraction-expected[name].fraction)<.035,name+' internal paragraph position');return actual;
}
async function pending(p,kind){
 await p.waitForFunction(kind=>{const s=window.__qaPending?.();return s&&(kind==='image'?s.images>0:kind==='diagram'?s.diagrams:kind==='formula'?s.formulas>0:s.images>0&&s.diagrams&&s.formulas>0);},kind);
 let timer;await Promise.race([context.__pendingSeen,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No native pending media request')),10000);})]).finally(()=>clearTimeout(timer));
 assert(context.__pending.length>0,'The native media request must have started');
 return p.evaluate(()=>window.__qaPending());
}
async function close(p,force=false){
 if(force){await context.close();context=undefined;}
 else{const closed=p.waitForEvent('close');await p.close({runBeforeUnload:true});await closed;}
 // Release the HTTP harness only after the reader has closed. Otherwise native
 // intermediaries can retain abandoned requests across disposable browsers.
 for(const resolve of held)resolve();held.clear();
 await context?.close();context=undefined;
}
async function park(p){await button(p,'hub').click();await p.locator('#library-status[data-state=saved]').waitFor();await close(p);}
try{
 let p=await launch();await p.locator('#offline-status[data-state=ready]').waitFor({timeout:120000});
 await p.locator('#folder-input').setInputFiles(folder);await p.waitForFunction(()=>document.querySelectorAll('#user-files button').length===9);
 for(const kind of kinds)for(const side of ['A','B']){const name=kind+'-'+side;await button(p,name).click();await media(p,name);expected[name]=await at(p,side==='A'?6:8);await p.waitForTimeout(650);await p.locator('#library-status[data-state=saved]').waitFor();console.log('SEED '+name);}
 await park(p);
 for(const kind of kinds)for(const phase of ['switch','rapid-user-move','late-completion']){
  const a=kind+'-A',b=kind+'-B';console.log('START '+kind+': '+phase);p=await launch(kind,false,!compatibility&&kind==='mixed'&&phase==='switch');await button(p,a).click();const beforeSwitch=await pending(p,kind);
  if(phase==='late-completion'){
   // Keyboard navigation also must preserve a pending restore; Space activates
   // the focused file button rather than intentionally moving the reading page.
   await button(p,b).focus();await p.keyboard.press('Space');
  }else if(kind==='diagram'&&phase==='switch'){
   await p.locator('#document a').filter({hasText:'切換文件'}).click();
  }else if(!compatibility&&kind==='mixed'&&phase==='switch'){
   await p.setViewportSize({width:390,height:844});
   const tap=async locator=>{const r=await locator.boundingBox();assert(r);await p.touchscreen.tap(r.x+r.width/2,r.y+r.height/2);};
   await tap(p.locator('#sidebar-toggle'));await button(p,b).scrollIntoViewIfNeeded();await tap(button(p,b));
  }else await button(p,b).click();
  await p.waitForFunction(name=>document.getElementById('current-file').textContent===name+'.md',b);
  if(phase==='switch'&&(kind==='diagram'||kind==='formula'))await p.locator('#library-status[data-state=restoring]').waitFor();
  if(phase==='rapid-user-move'){
   await button(p,a).click();await button(p,b).click();
   await p.evaluate(()=>{window.__qaWheelReceived=false;addEventListener('wheel',event=>{window.__qaWheelReceived={target:event.target?.id,tag:event.target?.tagName,sidebar:!!event.target?.closest?.('#sidebar'),x:event.clientX,y:event.clientY};},{once:true});});
   await p.mouse.move(1000,700);await p.mouse.wheel(0,300);
   await p.waitForFunction(()=>window.__qaWheelReceived);expected[b]=await at(p,10);
  }
  if(phase==='late-completion'){await p.evaluate(()=>window.__qaRelease());await stable(p,b);}
  const requests=[...context.__pending];inFlight={kind,phase,beforeSwitch,expectedA:expected[a],expectedB:expected[b]};
  if(phase==='rapid-user-move')Object.assign(inFlight,{beforeClose:await point(p),input:await p.evaluate(()=>window.__qaWheelReceived)});
  if(phase==='rapid-user-move')await p.evaluate(token=>{
   const scope=new URL('./',location.href).href,key=`inkread-qa:${scope}:last-unload`;
   localStorage.removeItem(key);
   const record=event=>{
    if(event.type==='visibilitychange'&&!document.hidden)return;
    if(localStorage.getItem(key))return;
    const checkpoint=JSON.parse(localStorage.getItem(`inkread-library:${scope}:checkpoint`)||'null');
    // Read after the app's listener. Only a separate QA observation is written;
    // never call save or modify the app's checkpoint, documents or positions.
    localStorage.setItem(key,JSON.stringify({event:event.type,token,y:scrollY,path:checkpoint?.current?.path,positionY:checkpoint?.position?.y}));
   };
   addEventListener('beforeunload',record);addEventListener('pagehide',record);document.addEventListener('visibilitychange',record);
  },kind+':'+phase);
  await close(p,phase==='switch');
  p=await launch(undefined,true);
  if(phase==='rapid-user-move'){
   inFlight.beforeUnload=await p.evaluate(()=>JSON.parse(localStorage.getItem(`inkread-qa:${new URL('./',location.href).href}:last-unload`)||'null'));
   assert(inFlight.beforeUnload,'A real shutdown event must be observed');
   assert(['beforeunload','pagehide','visibilitychange'].includes(inFlight.beforeUnload.event));
   assert.equal(inFlight.beforeUnload.token,kind+':'+phase);
   assert(inFlight.beforeUnload.path.endsWith('/'+b+'.md'));
   assert(Math.abs(inFlight.beforeUnload.y-inFlight.beforeUnload.positionY)<1,'The latest reading position must already be checkpointed when shutdown is observed');
   unloads.push(inFlight.beforeUnload);
  }
  const actualB=await stable(p,b);await button(p,a).click();const actualA=await stable(p,a);
  results.push(kind+': '+phase);evidence.push({kind,phase,beforeSwitch,requests,expectedA:expected[a],actualA,expectedB:expected[b],actualB});console.log('PASS '+results.at(-1));
  await p.screenshot({path:path.join(output,browserName+'-'+kind+'-'+phase+'.png')});await park(p);
 }
 assert.equal(results.length,12);assert.deepEqual(errors,[]);
 await writeFile(path.join(output,browserName+'-results.json'),JSON.stringify({browser:browserName,site:url,passed:results.length,results,evidence,errors,unloads,offlineMethod:'native context.setOffline(true) before navigation after full persistent browser restart'},null,2));
}catch(error){const diagnostic=await context?.pages().at(-1)?.evaluate(()=>({file:document.getElementById('current-file')?.textContent,library:document.getElementById('library-status')?.outerHTML,checkpoint:Object.entries(localStorage).filter(([k])=>k.endsWith(':checkpoint')),scripts:[...document.scripts].map(s=>s.src)})).catch(()=>undefined);await writeFile(path.join(output,browserName+'-failure.json'),JSON.stringify({error:error.stack,results,evidence,errors,inFlight,diagnostic},null,2));await context?.pages().at(-1)?.screenshot({path:path.join(output,browserName+'-failure.png')}).catch(()=>{});throw error;
}finally{
 await context?.close();for(const resolve of held)resolve();for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));await server.close();
 assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
