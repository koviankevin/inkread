import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {browserType,browserName,compatibility} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';
import {decodeBackup} from '../src/library-backup.js';

const root=process.cwd(),out=path.join(root,'test-results','product-v180',browserName);
await mkdir(out,{recursive:true});
const temporary=await mkdtemp(path.join(out,'run-')),profile=path.join(temporary,'profile'),books=path.join(temporary,'books');
await mkdir(path.join(books,'assets'),{recursive:true});
const paragraphs=Array.from({length:35},(_,i)=>`PARA-${String(i).padStart(3,'0')} 閱讀段落要獨立保存，文件重新命名後，圖片及連結仍屬於原來的文件。`.repeat(5)).join('\n\n');
const mixed='# PRIVATE_PAYLOAD_A\n\n![紅色圖片](assets/red.svg)\n\n$$\\frac{1}{2}+\\sqrt{x}$$\n\n```mermaid\nflowchart LR\n A[PRODUCT] --> B[OFFLINE]\n```\n\n'+paragraphs;
await writeFile(path.join(books,'A.md'),mixed);await writeFile(path.join(books,'B.md'),'# PRIVATE_PAYLOAD_B\n\n[前往 A](A.md)\n\n![共用圖片](assets/red.svg)\n\n'+paragraphs);
await writeFile(path.join(books,'assets','red.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="250" height="120"><rect width="250" height="120" fill="#d02525"/></svg>');
const server=await serveSites({app:path.join(root,'dist'),source:path.join(root,'src')},{intercept:pathname=>pathname==='/source/manage-qa.html' ? {headers:{'Content-Type':'text/html'},body:'<!doctype html><script type="module">import{createLibraryStore}from"./library-store.js";import{storedLibrarySnapshot}from"./library-restore.js";import{planDocumentEdit}from"./library-management.js";window.makeStore=createLibraryStore;window.snapshot=storedLibrarySnapshot;window.plan=planDocumentEdit;</script>'} : undefined});
const url=server.origin+'/app/',launch={headless:true,viewport:{width:1440,height:900},...(!compatibility&&process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})};
let context;
const results=[],errors=[],debug={};const pass=name=>{results.push(name);console.log(`PASS ${name}`);};
async function createContext(offline=false){
 const c=await browserType.launchPersistentContext(profile,launch);c.setDefaultTimeout(30000);
 if(offline)await c.setOffline(true);
 c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 return c;
}
async function saved(p){await p.locator('#library-status[data-state=saved]').waitFor();}
async function open(p,address=url){await p.goto(address,{waitUntil:'domcontentloaded'});await p.locator('#app:not([hidden])').waitFor();await saved(p);}
async function point(p){return p.evaluate(()=>{
 const el=[...document.querySelectorAll('#document p')].find(p=>p.textContent.startsWith('PARA-')&&p.getBoundingClientRect().top<=150&&p.getBoundingClientRect().bottom>150);
 if(!el)return null;const r=el.getBoundingClientRect();return{id:el.textContent.slice(0,8),fraction:(150-r.top)/r.height};
});}
async function at(p,n){
 const id=`PARA-${String(n).padStart(3,'0')}`;await p.locator('#document p').filter({hasText:id}).evaluate(el=>{const r=el.getBoundingClientRect();scrollTo({top:scrollY+r.top-150+r.height*.35,behavior:'instant'});});
 await p.waitForFunction(id=>decodeURIComponent(location.hash).includes(id) || location.hash.includes('&position='),id);await p.waitForTimeout(650);await saved(p);
 const result=await point(p);assert.equal(result?.id,id);return result;
}
async function samePoint(p,expected){await p.bringToFront();await p.waitForFunction(expected=>{
 const el=[...document.querySelectorAll('#document p')].find(p=>p.textContent.startsWith(expected.id));if(!el)return false;const r=el.getBoundingClientRect();return r.height>0&&Math.abs((150-r.top)/r.height-expected.fraction)<.035;
},expected);}
async function manage(p){await p.locator('#manage-library').click();await p.locator('#manage-dialog[open]').waitFor();}
async function support(p){
 if(browserName!=='firefox')return p.locator('#support-button').click();
 // Firefox's automation scrollIntoView shifts the root around a sticky sidebar.
 // Scroll only the sidebar, verify the painted target, then use native input.
 await p.locator('#sidebar').evaluate(el=>{el.scrollTop=el.scrollHeight;});
 const at=await p.locator('#support-button').evaluate(el=>{const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(document.elementFromPoint(x,y)!==el)throw Error('Support button is not the painted target');return{x:x-(visualViewport?.offsetLeft || 0),y:y-(visualViewport?.offsetTop || 0)};});
 await p.mouse.click(at.x,at.y);
}
async function image(p){await p.waitForFunction(()=>{const img=document.querySelector('#document img');return img?.complete&&img.naturalWidth===250&&img.naturalHeight===120;});assert.equal(await p.locator('#document img').first().evaluate(img=>img.complete&&img.naturalWidth===250&&img.naturalHeight===120),true);}
try{
 context=await createContext();let a=await context.newPage();await open(a);
 assert.equal(await a.locator('#first-use').isVisible(),true);assert.equal(await a.locator('#manage-library').isDisabled(),true);
 await a.locator('#folder-input').setInputFiles(books);await a.locator('#user-files button').filter({hasText:'A.md'}).waitFor();await saved(a);
 await a.locator('#user-files button').filter({hasText:'A.md'}).click();await a.locator('.mermaid-container svg').waitFor();await a.locator('.katex').waitFor();await image(a);
 await a.locator('#offline-status[data-state=ready]').waitFor();await saved(a);
 assert.equal(await a.locator('#first-use').isHidden(),true);await a.locator('#library-health summary').click();
 assert.match(await a.locator('#library-capacity').textContent(),/2 份文件 · 1 張圖片/);assert.match(await a.locator('#backup-history').textContent(),/尚無匯出紀錄/);
 pass('First-use guidance, actual content sizes and backup reminder reflect imported documents');
 const pa=await at(a,7),oldURL=a.url();let other=await context.newPage();await open(other,oldURL);const po=await at(other,15);
 const oldOtherURL=other.url();let b=await context.newPage();await open(b);await b.locator('#user-files button').filter({hasText:'B.md'}).click();const pb=await at(b,11);
 await manage(a);await a.locator('#manage-name').fill('重新命名.md');await a.locator('#manage-name').press('Enter');await a.locator('#manage-dialog').waitFor({state:'hidden'});
 await a.waitForFunction(()=>document.getElementById('current-file').textContent==='重新命名.md');await other.waitForFunction(()=>document.getElementById('current-file').textContent==='重新命名.md');
 await samePoint(a,pa);await samePoint(other,po);await samePoint(b,pb);await image(a);await image(other);
 pass('Atomic rename preserves pictures and three tabs own paragraphs, including two tabs of the same document');
 const ua=a.url(),ub=b.url();
 const linkTab=await context.newPage();await open(linkTab,ub);
 await linkTab.getByRole('link',{name:'前往 A',exact:true}).click();await linkTab.waitForFunction(()=>document.getElementById('current-file').textContent==='重新命名.md');await image(linkTab);await linkTab.close();
 pass('Original Markdown links from another file resolve to the renamed document');
 await samePoint(b,pb);
 if(!process.env.INKREAD_PRODUCT_MINIMAL){
 await manage(a);await a.locator('#manage-name').fill('B.md');await a.locator('#manage-rename').click();await a.locator('#manage-error').filter({hasText:'已有這個名稱'}).waitFor();
 assert.equal(await a.locator('#user-files button').count(),2);await a.locator('#manage-name').fill('../escape.md');await a.locator('#manage-rename').click();await a.locator('#manage-error').filter({hasText:'不可包含'}).waitFor();
 await a.locator('#manage-cancel').click();debug.afterRejectedNames={point:await point(a),url:a.url()};await samePoint(a,pa);pass('Duplicate and unsafe names are rejected without changing the library');
 await saved(a);await manage(a);await a.locator('#manage-name').fill('should-not-commit.md');
 await a.evaluate(()=>{window.__originalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,mode,...options){if(mode==='readwrite')throw new DOMException('Simulated quota failure','QuotaExceededError');return window.__originalTransaction.call(this,stores,mode,...options);};});
 await a.locator('#manage-rename').click();await a.locator('#manage-error').filter({hasText:/./}).waitFor();
 assert.equal(await a.locator('#current-file').textContent(),'重新命名.md');assert.equal(await a.locator('#user-files button').filter({hasText:'should-not-commit'}).count(),0);
 await a.evaluate(()=>{IDBDatabase.prototype.transaction=window.__originalTransaction;});await a.locator('#manage-cancel').click();
 debug.afterQuota={point:await point(a),url:a.url()};await samePoint(a,pa);
 pass('Failed storage transaction retains the original document, name and reading state');
 const downloadEvent=a.waitForEvent('download');await a.locator('#backup-library').click();const download=await downloadEvent;const archive=path.join(temporary,'export.inkread');await download.saveAs(archive);
 const backup=await decodeBackup(new Blob([await readFile(archive)]));assert.equal(backup.documents.length,2);assert.equal(backup.assets.length,1);assert.equal(backup.documents.find(d=>d.path.endsWith('B.md')).linkTargets[0][1],'books/重新命名.md');
 assert.match(await a.locator('#backup-history').textContent(),/上次產生備份/);debug.afterBackup={point:await point(a),url:a.url()};await samePoint(a,pa);pass('Real downloaded backup retains renamed links and records export history without claiming confirmed disk storage');
 await support(a);const diagnostic=JSON.parse(await a.locator('#diagnostic-content').inputValue());
 assert.equal(diagnostic.documents,2);assert.equal(diagnostic.images,1);assert(!JSON.stringify(diagnostic).includes('PRIVATE_PAYLOAD'));assert(!JSON.stringify(diagnostic).includes('重新命名'));assert(!JSON.stringify(diagnostic).includes(server.origin));
 assert.deepEqual(Object.keys(diagnostic).sort(),['format','version','createdAt','openingMode','secureContext','online','programState','libraryState','documents','images','textBytes','imageBytes','storageError'].sort());
 await a.locator('#support-dialog button[value=close]').click();debug.afterSupport={point:await point(a),url:a.url()};await samePoint(a,pa);pass('Inspectable diagnostics use an explicit metadata allowlist without names, content, paths or URL fragments');
 }
 // Traditional Chinese collation places this Chinese name before Latin B.
 await a.locator('#file-sort').selectOption('name');assert.deepEqual(await a.locator('#user-files .file-name').allTextContents(),['重新命名.md','B.md']);
 await saved(a);await saved(other);await saved(b);const retained=[a.url(),oldOtherURL,b.url()];debug.coldStart={expected:[pa,po,pb],urls:retained};await writeFile(path.join(temporary,'cold-start.json'),JSON.stringify(debug.coldStart,null,2));await context.close();context=await createContext(true);
 a=await context.newPage();await open(a,retained[0]);other=await context.newPage();await open(other,retained[1]);b=await context.newPage();await open(b,retained[2]);
 assert.equal(await a.evaluate(()=>navigator.onLine),false);await samePoint(a,pa);await samePoint(other,po);await samePoint(b,pb);
 assert.equal(await other.locator('#current-file').textContent(),'重新命名.md');assert.equal(await a.locator('#file-sort').inputValue(),'name');await image(a);await a.locator('.mermaid-container svg').waitFor();await a.locator('.katex').waitFor();
 pass('Whole-browser offline restart restores renamed and legacy tab URLs, independent paragraphs, sort preference and all media');
 await manage(a);await a.locator('#manage-delete').click();await a.locator('#confirm-cancel').click();assert.equal(await a.locator('#user-files button').count(),2);
 await a.locator('#manage-delete').click();await a.locator('#confirm-accept').click();await a.locator('#manage-dialog').waitFor({state:'hidden'});await other.waitForFunction(()=>document.querySelectorAll('#user-files button').length===1);
 assert.equal(await a.locator('#user-files button').filter({hasText:'B.md'}).count(),1);await image(a);await samePoint(b,pb);
 await a.locator('#clear-files').click();assert.equal(await a.locator('#confirm-cancel').evaluate(el=>el===document.activeElement),true);await a.keyboard.press('Escape');assert.equal(await a.locator('#user-files button').count(),1);
 pass('Delete requires confirmation, cancel is safe, shared images survive and other document progress is preserved');
 await a.reload({waitUntil:'domcontentloaded'});await saved(a);assert.equal(await a.locator('#user-files button').count(),1);await image(a);
 pass('Offline reload cannot resurrect the deleted document or remove a shared image');
 await a.setViewportSize({width:320,height:640});await a.locator('#sidebar-toggle').click();await manage(a);
 assert.equal(await a.locator('#manage-dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth&&el.getBoundingClientRect().left>=0),true);
 await a.screenshot({path:path.join(out,'management-mobile.png'),fullPage:false});await a.keyboard.press('Escape');
 pass('Document management fits a 320 px viewport and closes with the keyboard');
 await context.setOffline(false);
 const qa=await context.newPage();await qa.goto(server.origin+'/source/manage-qa.html');await qa.waitForFunction(()=>window.makeStore&&window.plan);
 const storage=await qa.evaluate(async()=>{
  const a=makeStore(),stale=makeStore();await a.load();await a.clear();await a.load();
  const doc={path:'A.md',source:'# A',bytes:3,revision:'A1'};await a.write({documents:[doc],current:{path:'A.md',updatedAt:1}});await stale.load();
  let s=snapshot(await a.load()),edit=plan(s,{kind:'rename',path:'A.md',name:'B.md'});
  await a.edit({...edit,current:{path:edit.current,updatedAt:2}},s.revision);
  await new Promise(r=>setTimeout(r,80));
  let rejected=false;try{await stale.write({documents:[doc]});}catch(e){rejected=e.code==='LIBRARY_CHANGED';}
  if(!rejected)throw Error('Stale tab can resurrect an old file');
  if((await a.load()).documents.some(d=>d.path==='A.md'))throw Error('Old name was resurrected');
  const before=await a.load();let failed=false;
  try{await a.edit({documents:[],positions:[],removedPaths:['B.md'],current:null},'stale-revision');}catch(e){failed=e.code==='LIBRARY_CHANGED';}
  if(!failed||(await a.load()).documents.length!==1)throw Error('Stale edit damaged library');
  s=snapshot(await a.load());edit=plan(s,{kind:'delete',path:'B.md'});
  const original=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(){throw Error('Injected abort');};
  try{await a.edit({...edit,current:null},s.revision);throw Error('Edit should abort');}catch(e){if(e.message==='Edit should abort')throw e;}finally{IDBObjectStore.prototype.delete=original;}
  if((await a.load()).documents[0].path!=='B.md')throw Error('Failed edit was not atomic');
  return {staleWriteRejected:rejected,stalePreviewRejected:failed,rollback:true};
 });
 assert.deepEqual(storage,{staleWriteRejected:true,stalePreviewRejected:true,rollback:true});pass('Native IndexedDB rejects stale writers and stale previews and rolls back aborted edits');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(out,'results.json'),JSON.stringify({browser:browserName,results,errors,storage,source:'local candidate'},null,2));
}catch(error){
 const pages=await Promise.all((context?.pages() || []).map(async p=>{
  try{return await p.evaluate(async()=>({url:location.href,selected:document.getElementById('current-file')?.textContent,library:document.getElementById('library-status')?.textContent,offline:document.getElementById('offline-status')?.textContent,online:navigator.onLine,paragraph:(()=>{const el=[...document.querySelectorAll('#document p')].find(p=>p.textContent.startsWith('PARA-')&&p.getBoundingClientRect().top<=150&&p.getBoundingClientRect().bottom>150);if(!el)return null;const r=el.getBoundingClientRect();return{id:el.textContent.slice(0,8),fraction:(150-r.top)/r.height};})(),worker:!!navigator.serviceWorker.controller,registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state,waiting:r.waiting?.state,installing:r.installing?.state})),caches:await caches.keys()}));}catch{return{url:p.url()};}
 }));
 await writeFile(path.join(out,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,results,errors,debug,pages},null,2));try{await context?.pages()[0]?.screenshot({path:path.join(out,'failure.png')});}catch{}throw error;
}
finally{await context?.close();await server.close();}
