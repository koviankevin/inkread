import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {browserType,browserName} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';

const output=path.join(process.cwd(),'test-results',browserName,'sidebar-resize');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'run-')),profile=path.join(temporary,'profile');
const results=[],errors=[],points={},pass=name=>{results.push(name);console.log('PASS '+name);};
let unavailable=false,context,engine;
const server=await serveSites({reader:process.env.INKREAD_TEST_DIST||path.join(process.cwd(),'dist')},{intercept:()=>unavailable?{status:503}:undefined});
async function launch(url=server.origin+'/reader/') {
  context=await browserType.launchPersistentContext(profile,{headless:true,viewport:{width:1100,height:900},...(process.env.CHROMIUM_PATH&&browserName==='chromium'?{executablePath:process.env.CHROMIUM_PATH}:{})});
  engine=context.browser()?.version()||browserName;
  if(unavailable && browserName==='chromium')await context.setOffline(true);
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await p.locator('#app:not([hidden])').waitFor();await stable(p);return p;
}
async function stable(p) {
  await p.locator('#library-status[data-state=saved]').waitFor();
  await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(350);
}
const width=p=>p.locator('#sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().width));
async function size(p,w){await p.setViewportSize({width:w,height:900});await stable(p);}
async function point(p){return p.evaluate(()=>{
  const el=[...document.querySelectorAll('#document p')].find(el=>{const r=el.getBoundingClientRect();return r.top<=150&&r.bottom>150;});
  const r=el?.getBoundingClientRect();return {paragraph:el?.textContent.match(/^PARA-\d+/)?.[0],fraction:r?(150-r.top)/r.height:null};
});}
async function same(p,expected){await stable(p);const actual=await point(p);assert.equal(actual.paragraph,expected.paragraph);assert(Math.abs(actual.fraction-expected.fraction)<.035,JSON.stringify({expected,actual}));return actual;}
async function key(p,key){await p.locator('#sidebar-resize').evaluate(el=>el.focus({preventScroll:true}));await p.keyboard.press(key);await stable(p);}
async function toggle(p){await p.locator('#sidebar-toggle').evaluate(el=>el.focus({preventScroll:true}));await p.keyboard.press('Enter');await stable(p);}
async function drag(p,target){
  const box=await p.locator('#sidebar-resize').boundingBox();assert(box);
  await p.mouse.move(box.x+box.width-5,400);await p.mouse.down();
  await p.mouse.move(target-5,400,{steps:12});await p.mouse.up();await stable(p);
  assert.equal(await p.locator('body').evaluate(el=>el.classList.contains('sidebar-resizing')),false);
}
try {
  let p=await launch();
  assert.equal(await width(p),228);await size(p,1440);assert.equal(await width(p),254);
  await size(p,1700);assert.equal(await width(p),270);await size(p,1100);
  pass('Untouched responsive defaults remain 228 / 254 / 270 pixels');
  const text=Array.from({length:100},(_,i)=>`PARA-${String(i).padStart(3,'0')} ${'Reading should stay at this paragraph when the sidebar width changes. '.repeat(12)}`).join('\n\n');
  await p.locator('#file-input').setInputFiles({name:'sidebar.md',mimeType:'text/markdown',buffer:Buffer.from('# Sidebar reading\n\n## Chapter\n\n'+text)});await stable(p);
  await p.locator('#offline-status[data-state=ready]').waitFor({timeout:90000});
  const handle=p.locator('#sidebar-resize');assert.equal(await handle.getAttribute('role'),'separator');assert.equal(await handle.getAttribute('aria-orientation'),'vertical');assert.equal(await handle.getAttribute('aria-valuemin'),'220');assert.equal(await handle.getAttribute('aria-valuemax'),'480');assert.equal(await handle.getAttribute('aria-valuenow'),'228');
  await key(p,'ArrowRight');assert.equal(await width(p),244);await key(p,'ArrowLeft');assert.equal(await width(p),228);
  await drag(p,350);assert.equal(await width(p),350);assert.equal(await p.evaluate(()=>scrollY),0);
  pass('Named separator supports native drag and arrow keys without moving the page start');
  await p.locator('#document p').filter({hasText:/^PARA-050 /}).evaluate(el=>scrollTo({top:scrollY+el.getBoundingClientRect().top+el.getBoundingClientRect().height*.35-150,behavior:'instant'}));await stable(p);points.original=await point(p);
  for(const target of [250,430,220,480,350]){await drag(p,target);assert.equal(await width(p),target);await same(p,points.original);}
  await key(p,'Home');const small=await p.locator('#document').evaluate(el=>el.clientWidth);await same(p,points.original);
  await key(p,'End');const large=await p.locator('#document').evaluate(el=>el.clientWidth);assert(large<small,'Resizing must actually reflow the reading column');await same(p,points.original);
  assert.equal(await width(p),480);assert.equal(await handle.getAttribute('aria-valuenow'),'480');
  pass('Repeated drag plus Home / End reflow preserve the paragraph and its internal position');
  await drag(p,100);assert.equal(await width(p),220);await same(p,points.original);
  await drag(p,1000);assert.equal(await width(p),480);await same(p,points.original);
  await size(p,800);assert.equal(await width(p),380);assert.equal(await handle.getAttribute('aria-valuemax'),'380');await same(p,points.original);
  await size(p,1100);assert.equal(await width(p),480);await same(p,points.original);
  pass('Drag and viewport bounds reserve reading space and restore the preferred width');
  await size(p,390);await same(p,points.original);assert.equal(await handle.isVisible(),false);await toggle(p);assert.equal(await width(p),250);assert.equal(await handle.isVisible(),false);await p.locator('#sidebar-close').click();await same(p,points.original);
  await size(p,1100);assert.equal(await width(p),480);await same(p,points.original);
  await toggle(p);assert.equal(await p.locator('#sidebar').isVisible(),false);await toggle(p);assert.equal(await width(p),480);
  const box=await handle.boundingBox();assert.equal(Math.round(box.x+box.width),480);
  await drag(p,330);await same(p,points.original);
  pass('Mobile keeps its 250px drawer; desktop collapse and reopening retain a usable divider');
  const cancel=await handle.boundingBox();await p.mouse.move(cancel.x+20,350);await p.mouse.down();await p.mouse.move(380,350,{steps:4});await p.evaluate(()=>{const h=document.getElementById('sidebar-resize');h.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1}));});await p.mouse.up();await stable(p);
  assert.equal(await p.locator('body').evaluate(el=>el.classList.contains('sidebar-resizing')),false);await same(p,points.original);
  await key(p,'ArrowLeft');await same(p,points.original);await p.screenshot({path:path.join(output,'desktop.png')});
  const persisted=await width(p);await p.reload();await same(p,points.original);assert.equal(await width(p),persisted);
  pass('Cancellation releases drag state and a normal reload retains width and paragraph');
  const delta=await p.locator('#document p').filter({hasText:/^PARA-060 /}).evaluate(el=>el.getBoundingClientRect().top+el.getBoundingClientRect().height*.35-150);
  await p.mouse.move(800,400);await p.mouse.wheel(0,delta);await p.waitForTimeout(700);await stable(p);points.user=await point(p);assert.equal(points.user.paragraph,'PARA-060');
  await key(p,'ArrowRight');await same(p,points.user);
  pass('Real user scrolling replaces the old paragraph after resizing');
  const finalWidth=await width(p),savedURL=p.url();await context.close();context=undefined;unavailable=true;p=await launch(savedURL);
  points.offline=await same(p,points.user);assert.equal(await width(p),finalWidth);assert.equal(await p.locator('#document h1').textContent(),'Sidebar reading');
  pass('Complete offline browser restart restores width, document and the new paragraph from its retained URL');
  await p.evaluate(()=>scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));await stable(p);await key(p,'Home');assert(await p.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-5));
  await key(p,'End');assert(await p.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-5));
  pass('Resizing at the document end remains at the end');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'results.json'),JSON.stringify({browser:browserName,engine,results,errors,points,recovery:'whole persistent browser restart with the retained URL; server unavailable, Chromium native offline'},null,2));
} catch(error){if(context){const pages=context.pages();await pages.at(-1)?.screenshot({path:path.join(output,'failure.png')});}throw error;} finally {await context?.close();await server.close();}
