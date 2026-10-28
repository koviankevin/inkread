import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {browserType,browserName} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';

const output=path.join(process.cwd(),'test-results',browserName,'printing');await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(output,'run-')),results=[],errors=[];
const server=await serveSites({app:process.env.INKREAD_TEST_DIST||path.join(process.cwd(),'dist')});
const graph='```mermaid\nflowchart LR\n A[Read] --> B[Print]\n```';
let context;
const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
const pass=name=>{results.push(name);console.log('PASS '+name);};
async function session(name,offline=false){
 context=await browserType.launchPersistentContext(path.join(temp,name),{headless:true,viewport:{width:1440,height:900},serviceWorkers:'block',...(browserName==='chromium'&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const p=await context.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{window.printCalls=[];window.print=()=>printCalls.push({title:document.querySelector('#document h1').textContent,diagrams:document.querySelectorAll('#document .mermaid-container svg').length,formulas:document.querySelectorAll('#document .katex').length,image:document.querySelector('#document img')?.naturalWidth,fonts:document.fonts.status});});
 if(offline)await context.setOffline(true);
 await p.goto(offline?pathToFileURL(path.join(process.env.INKREAD_TEST_DIST||path.join(process.cwd(),'dist'),'index.html')).href:server.origin+'/app/',{waitUntil:'domcontentloaded'});await p.locator('#app:not([hidden])').waitFor();return p;
}
async function open(p,source,name='print.md'){await p.locator('#file-input').setInputFiles({name,mimeType:'text/markdown',buffer:Buffer.from(source)});await p.locator('#library-status[data-state=saved]').waitFor();}
async function printed(p,n=1){await p.waitForFunction(n=>printCalls.length===n,n);await p.waitForFunction(()=>!document.getElementById('print-button').disabled);assert.equal(await p.locator('#print-status').isVisible(),false);assert.equal(await p.locator('#print-button').getAttribute('aria-busy'),null);}
try{
 let p=await session('plain');await open(p,'# Plain\n\nCurrent plain text.');await p.locator('#print-button').click();await printed(p);
 assert.equal((await p.evaluate(()=>printCalls[0])).title,'Plain');
 if(browserName==='chromium'){const start=Date.now(),pdf=await p.pdf({format:'A4',printBackground:true});assert(pdf.length>1000);await writeFile(path.join(output,'plain.pdf'),pdf);await writeFile(path.join(output,'pagination.json'),JSON.stringify({milliseconds:Date.now()-start,bytes:pdf.length}));}
 pass('Plain text prints and resets the accessible busy state; Chromium also generates a real PDF');await context.close();context=undefined;

 p=await session('stale');let hold=gate(),requested=gate();
 await context.route('**/diagrams.js',async r=>{requested.release();await hold.promise;await r.continue().catch(()=>{});});
 try{
  await open(p,'# Old\n\n'+graph,'old.md');await requested.promise;
  await open(p,'# Current\n\nPlain text must not wait for the old diagram.','current.md');await p.locator('#print-button').click();
  await p.waitForFunction(()=>printCalls.length===1,null,{timeout:2500});await printed(p);assert.equal((await p.evaluate(()=>printCalls[0])).title,'Current');
  pass('A plain current document prints while an older diagram download remains blocked');
 }finally{hold.release();await context.close();context=undefined;}

 p=await session('complete');hold=gate();requested=gate();const imageHold=gate(),imageRequested=gate();let engineRequests=0;
 await context.route('**/diagrams.js',async r=>{engineRequests++;requested.release();await hold.promise;await r.continue().catch(()=>{});});
 await context.route('**/slow.svg',async r=>{imageRequested.release();await imageHold.promise;await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>'}).catch(()=>{});});
 try{
  await open(p,'# Complete\n\n'+('Offscreen paragraph.\n\n').repeat(100)+graph+'\n\n$$x^2+y^2=z^2$$\n\n![Green]('+server.origin+'/slow.svg)');
  await p.locator('.image-placeholder button').evaluate(e=>e.focus({preventScroll:true}));await p.keyboard.press('Enter');assert.equal(await p.evaluate(()=>scrollY),0);
  await p.locator('#print-button').click();await requested.promise;
  await Promise.race([imageRequested.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Image loading must start before the held diagram is released')),2500))]);
  await p.locator('#print-status:not([hidden])').waitFor();assert.equal(await p.locator('#print-button').getAttribute('aria-busy'),'true');assert.equal(await p.evaluate(()=>printCalls.length),0);
  imageHold.release();hold.release();await printed(p);
  assert.deepEqual(await p.evaluate(()=>printCalls[0]),{title:'Complete',diagrams:1,formulas:1,image:20,fonts:'loaded'});
  pass('Offscreen image and diagram load concurrently; printing waits for the real image, diagram, formula and fonts');
  await p.locator('#print-button').click();await printed(p,2);assert.equal(engineRequests,1);
  if(browserName==='chromium'){const pdf=await p.pdf({format:'A4',printBackground:true});assert(pdf.length>1000);await writeFile(path.join(output,'complete.pdf'),pdf);}
  pass('Repeated printing reuses the completed engines and media without another diagram download');
 }finally{hold.release();imageHold.release();await context.close();context=undefined;}

 p=await session('cancel');hold=gate();requested=gate();await context.route('**/diagrams.js',async r=>{requested.release();await hold.promise;await r.continue().catch(()=>{});});
 try{
  await open(p,'# First\n\n'+('Offscreen paragraph.\n\n').repeat(100)+graph,'first.md');await p.locator('#print-button').click();await requested.promise;
  await open(p,'# Second\n\nOnly print when requested.','second.md');await p.waitForFunction(()=>!document.getElementById('print-button').disabled);assert.equal(await p.evaluate(()=>printCalls.length),0);assert.equal(await p.locator('#print-status').isVisible(),false);
  await p.locator('#print-button').click();await printed(p);assert.equal((await p.evaluate(()=>printCalls[0])).title,'Second');
  hold.release();await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>printCalls.length),1);
  pass('Switching documents cancels a pending print immediately and the new document can print independently');
 }finally{hold.release();await context.close();context=undefined;}

 p=await session('retry');await open(p,'# Retry\n\nReady.');await p.evaluate(()=>{window.print=()=>{throw Error('Controlled print failure');};});await p.locator('#print-button').click();await p.waitForFunction(()=>!document.getElementById('print-button').disabled);assert.equal(await p.locator('#print-status').isVisible(),false);assert.match(await p.locator('#toast').textContent(),/無法準備列印/);
 await p.evaluate(()=>{window.print=()=>printCalls.push({title:document.querySelector('#document h1').textContent});});await p.locator('#print-button').click();await printed(p);assert.equal((await p.evaluate(()=>printCalls[0])).title,'Retry');
 pass('A print failure clears the busy state, reports the problem and permits a retry');
 if(browserName==='chromium'){
  await context.close();context=undefined;p=await session('offline',true);
  await p.locator('#file-input').setInputFiles([{name:'offline.md',mimeType:'text/markdown',buffer:Buffer.from('# Offline\n\n'+('Offscreen paragraph.\n\n').repeat(100)+graph+'\n\n$$x^2+y^2=z^2$$\n\n![Green](green.svg)')},{name:'green.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>')}]);
  await p.locator('#library-status[data-state=saved]').waitFor();await p.locator('#print-button').click();await printed(p);
  assert.deepEqual(await p.evaluate(()=>printCalls[0]),{title:'Offline',diagrams:1,formulas:1,image:20,fonts:'loaded'});
  pass('The downloaded file version prepares real local images, diagrams, formulas and fonts on its first fully offline print');
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(output,'results.json'),JSON.stringify({browser:browserName,results,errors,scope:'real rendering and native input, window.print intercepted to inspect readiness; real Chromium PDF generation is separate from native preview UI'},null,2));
}finally{await context?.close();await server.close();}
