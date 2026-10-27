import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {browserName,browserType} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';

const out=path.join(process.cwd(),'test-results/accessibility',browserName);await mkdir(out,{recursive:true});
const profile=await mkdtemp(path.join(out,'profile-')),server=await serveSites({app:path.join(process.cwd(),'dist')});
const context=await browserType.launchPersistentContext(profile,{headless:true,serviceWorkers:'block',reducedMotion:'reduce',viewport:{width:1440,height:900}});
context.setDefaultTimeout(15000);const p=await context.newPage(),results=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
const pass=message=>{results.push(message);console.log('PASS '+message);};
const id=()=>p.evaluate(()=>document.activeElement.id);
async function expectFocus(value){await p.waitForFunction(value=>document.activeElement.id===value,value);assert.equal(await id(),value);}
async function keyFocus(selector){await p.bringToFront();await p.locator(selector).evaluate(el=>el.focus({preventScroll:true}));}
async function side(){await p.locator('#sidebar-toggle').click();await p.waitForFunction(()=>document.getElementById('sidebar').getAttribute('aria-modal')==='true');}
async function point(){return p.evaluate(()=>{const e=[...document.querySelectorAll('#document p')].find(e=>e.textContent.startsWith('PARA-') && e.getBoundingClientRect().top<=150 && e.getBoundingClientRect().bottom>150);if(!e)return null;const r=e.getBoundingClientRect();return {id:e.textContent.slice(0,8),fraction:(150-r.top)/r.height};});}
async function same(expected){try{await p.waitForFunction(expected=>{const e=[...document.querySelectorAll('#document p')].find(e=>e.textContent.startsWith(expected.id));if(!e)return false;const r=e.getBoundingClientRect();return Math.abs((150-r.top)/r.height-expected.fraction)<.035;},expected);}catch(error){error.message+=' '+JSON.stringify({expected,actual:await point(),metrics:await p.evaluate(()=>({y:scrollY,font:document.getElementById('font-size').textContent,focus:document.activeElement.id}))});throw error;}}
const source='# Accessible document\n\n## First section\n\n- [x] Finished task\n- [ ] Pending task\n\n```js\n// Readable code\nconst x = 42; console.log("'+ 'long code '.repeat(35)+'");\n```\n\n'+Array.from({length:35},(_,i)=>`PARA-${String(i).padStart(3,'0')} `+'Keep this paragraph while navigating. '.repeat(22)).join('\n\n')+'\n\n## Last section\n\nLast paragraph.';
try {
 await p.goto(server.origin+'/app/');await p.locator('#app:not([hidden])').waitFor();await p.locator('#library-status[data-state=saved]').waitFor();
 await p.keyboard.press('Tab');assert.equal(await p.locator(':focus').getAttribute('class'),'skip-link');await p.keyboard.press('Enter');assert.equal(await id(),'document');
 assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'),'true');
 await p.locator('#file-input').setInputFiles({name:'Accessible.md',mimeType:'text/markdown',buffer:Buffer.from(source)});await p.getByRole('heading',{name:'Accessible document',exact:true}).waitFor();
 assert.equal(await p.getByRole('checkbox',{name:'Finished task',exact:true}).isChecked(),true);assert.equal(await p.getByRole('checkbox',{name:'Pending task',exact:true}).isChecked(),false);
 assert.equal(await p.getByRole('group',{name:'閱讀字級'}).count(),1);assert.equal(await p.getByRole('status',{name:'閱讀字級'}).count(),1);
 await keyFocus('.code-block pre');await p.keyboard.press('End');await p.keyboard.press('ArrowRight');await p.waitForFunction(()=>document.querySelector('.code-block pre').scrollLeft>0);
 pass('Skip link, read-only task names, live font size and keyboard code scrolling are accessible');

 await p.setViewportSize({width:320,height:640});await p.waitForFunction(()=>matchMedia('(max-width:720px)').matches && document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false' && document.getElementById('toc-toggle').getAttribute('aria-expanded')==='false');assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');assert.equal(await p.locator('#toc-toggle').getAttribute('aria-expanded'),'false');
 await side();assert.equal(await id(),'sidebar-close');assert.equal(await p.locator('.workspace').evaluate(e=>e.inert),true);
 await p.keyboard.press('Shift+Tab');assert.equal(await id(),'support-button');await p.keyboard.press('Tab');assert.equal(await id(),'sidebar-close');
 for(let i=0;i<25;i++){await p.keyboard.press('Tab');assert.equal(await p.locator('#sidebar').evaluate(e=>e.contains(document.activeElement)),true);}
 await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');assert.equal(await p.locator('.workspace').evaluate(e=>e.inert),false);
 await side();await p.mouse.click(315,610);await p.waitForFunction(()=>document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false');
 pass('Mobile drawer traps Tab, makes the background inert and returns focus after Escape or outside click');

 await side();await p.locator('#user-files button').click();assert.equal(await id(),'document');assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
 await side();await p.locator('#manage-library').click();await p.locator('#manage-dialog[open]').waitFor();await p.waitForFunction(()=>!document.body.classList.contains('sidebar-mobile-open'));
 await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');
 await side();await p.locator('#help-button').click();await p.locator('#help-dialog[open]').waitFor();await p.locator('#character-shortcuts').uncheck();await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');
 let chooserCount=0;p.on('filechooser',()=>chooserCount++);await p.keyboard.press('o');await p.keyboard.press('/');await p.waitForTimeout(150);assert.equal(chooserCount,0);await expectFocus('sidebar-toggle');
 await p.reload();await p.locator('#app:not([hidden])').waitFor();await p.locator('#library-status[data-state=saved]').waitFor();await p.keyboard.press('/');assert.notEqual(await id(),'file-search');
 await side();await p.locator('#help-button').click();await p.locator('#character-shortcuts').check();await p.keyboard.press('Escape');await p.waitForFunction(()=>document.activeElement.id==='sidebar-toggle' && !document.querySelector('dialog[open]'));await p.keyboard.press('/');assert.equal(await id(),'file-search');assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'),'true');
 await keyFocus('#file-sort');await p.keyboard.press('o');assert.equal(await id(),'file-sort');assert.equal(chooserCount,0);await p.keyboard.press('Escape');
 pass('Document selection and native dialogs keep usable focus; shortcut opt-out persists and select input is not intercepted');

 await p.locator('#toc-toggle').click();await p.waitForFunction(()=>document.getElementById('toc-links').contains(document.activeElement));await p.keyboard.press('Escape');assert.equal(await id(),'toc-toggle');assert.equal(await p.locator('#toc-toggle').getAttribute('aria-expanded'),'false');
 await p.locator('#toc-toggle').click();await p.keyboard.press('Enter');await p.waitForFunction(()=>document.activeElement.matches('#document h2'));assert.equal(await p.locator('#toc-toggle').getAttribute('aria-expanded'),'false');
 assert.equal(await p.locator('#document h2').first().evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('.reading-toolbar').getBoundingClientRect().bottom),true);
 pass('Narrow-screen chapter navigation returns focus or focuses the selected heading without hiding it under the toolbar');
+
+ await side();const downloadEvent=p.waitForEvent('download');await p.locator('#backup-library').click();const download=await downloadEvent,archive=path.join(profile,'accessibility.inkread');await download.saveAs(archive);
+ await p.locator('#backup-input').setInputFiles(archive);await p.locator('#restore-dialog[open]').waitFor();await expectFocus('restore-title');await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');
+ await side();await p.locator('#support-button').click();await p.locator('#support-dialog[open]').waitFor();await expectFocus('support-title');await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');
+ await side();await p.locator('#paste-button').click();await p.locator('#paste-dialog[open]').waitFor();await expectFocus('paste-content');await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');
+ await side();await p.locator('#clear-files').click();await p.locator('#confirm-dialog[open]').waitFor();await expectFocus('confirm-cancel');await p.keyboard.press('Escape');await expectFocus('sidebar-toggle');assert.equal(await p.locator('#user-files button').count(),1);
+ pass('Restore, support, paste and destructive dialogs have appropriate initial focus and a visible return target; cancel keeps data');
+

 await p.setViewportSize({width:1440,height:900});await p.waitForTimeout(250);
 await p.locator('#document p').filter({hasText:/^PARA-020 /}).evaluate(el=>{const r=el.getBoundingClientRect();scrollTo({top:scrollY+r.top+r.height*.35-150,behavior:'instant'});});await p.waitForTimeout(650);const expected=await point();assert.equal(expected?.id,'PARA-020');
 await keyFocus('#sidebar-toggle');await p.keyboard.press('Enter');await same(expected);await p.keyboard.press('Enter');await same(expected);
 await keyFocus('#font-plus');await p.keyboard.press('Space');await same(expected);
 await p.setViewportSize({width:320,height:640});await same(expected);await p.setViewportSize({width:640,height:320});await same(expected);
 pass('Sidebar layout, keyboard font changes and narrow/landscape resize preserve the same paragraph within .035');

 await p.setViewportSize({width:320,height:640});await p.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
 for(const dark of [false,true]){
   if((await p.evaluate(()=>document.documentElement.dataset.theme==='dark'))!==dark)await p.locator('#theme-toggle').click();
   await p.waitForTimeout(80);
   const contrast=await p.evaluate(()=>{
     const rgb=s=>s.trim().startsWith('#') ? s.trim().slice(1).match(/../g).map(x=>parseInt(x,16)) : s.match(/[\d.]+/g).slice(0,3).map(Number),lum=rgb=>rgb.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0),ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
     const root=getComputedStyle(document.documentElement),code=getComputedStyle(document.querySelector('.code-block'));
     return {muted:ratio(rgb(root.getPropertyValue('--muted')),rgb(root.getPropertyValue('--sidebar'))),tokens:[...document.querySelectorAll('.code-block [class^=hljs]')].map(el=>ratio(rgb(getComputedStyle(el).color),rgb(code.backgroundColor)))};
   });assert(contrast.muted>=4.5);assert(contrast.tokens.every(x=>x>=4.5),JSON.stringify(contrast));
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await side();await p.locator('#manage-library').click();await p.locator('#manage-dialog[open]').waitFor();
   assert.equal(await p.locator('#manage-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await p.screenshot({path:path.join(out,`mobile-${dark?'dark':'light'}.png`)});await p.keyboard.press('Escape');
 }
 await p.emulateMedia({forcedColors:'active'});await side();await p.keyboard.press('Tab');assert.match(await p.locator(':focus').evaluate(e=>getComputedStyle(e).outlineStyle),/solid/);await p.keyboard.press('Escape');
 pass('Light/dark code and muted text meet 4.5:1, 320px UI reflows and forced-color focus stays visible');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({browser:browserName,results,errors},null,2));
}catch(error){await p.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await writeFile(path.join(out,'failure.json'),JSON.stringify({message:error.message,results,focus:await id().catch(()=>null),viewport:await p.evaluate(()=>({width:innerWidth,height:innerHeight,mobile:matchMedia('(max-width:720px)').matches,sidebar:document.getElementById('sidebar-toggle').getAttribute('aria-expanded'),toc:document.getElementById('toc-toggle').getAttribute('aria-expanded')})).catch(()=>null)},null,2));throw error;}
finally{await context.close();await server.close();}
