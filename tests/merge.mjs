import {browserType,compatibility,browserName,checkExamples,probeFileOrigin,libraryContext,clickRestore} from './browser-compat.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {storedLibrarySnapshot,restoreConflicts,planRestore} from '../src/library-restore.js';
import {documentLinks,resolveDocumentPath} from '../src/document-links.js';
import {encodeBackup,decodeBackup} from '../src/library-backup.js';
import {serveSites} from './site-server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'test-results',...(compatibility ? [browserName] : []));
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'merge-test-')),results=[],errors=[];
const pass=name=>{results.push(name);console.log(`PASS ${name}`);};
const pos=(path,revision,y=100)=>({path,revision,y,ratio:.3,fraction:.2,anchor:'section',atEnd:false,updatedAt:100});
const doc=(path,source,revision)=>({path,source,revision,bytes:Buffer.byteLength(source),pasted:false});
const existing={documents:[doc('shared.md','# current','old'),doc('folder-a/note.md','# unique','unique')],assets:[{path:'picture.svg',blob:new Blob(['current'])}],positions:[pos('shared.md','old'),pos('folder-a/note.md','unique')],current:'shared.md'};
const incoming={documents:[doc('shared.md','# backup','unused'),doc('folder-b/note.md','# another','unused2')],assets:[{path:'picture.svg',blob:new Blob(['backup'])},{path:'extra.svg',blob:new Blob(['extra'])}],positions:[pos('shared.md','unused',300)],current:'folder-b/note.md'};
const conflicts=restoreConflicts(existing,incoming);
assert.deepEqual(conflicts.map(c=>c.key),['documents:shared.md','assets:picture.svg']);
assert.throws(()=>planRestore(existing,incoming,'merge'),{code:'RESTORE_CONFLICT'});
const keep=new Map(conflicts.map(c=>[c.key,'existing'])),take=new Map(conflicts.map(c=>[c.key,'backup']));
const kept=planRestore(existing,incoming,'merge',keep),taken=planRestore(existing,incoming,'merge',take);
const mixed=planRestore(existing,incoming,'merge',new Map([['documents:shared.md','backup'],['assets:picture.svg','existing']]));
assert.equal(mixed.documents.find(d=>d.path==='shared.md').source,'# backup'); assert.equal(await mixed.assets[0].blob.text(),'current');
assert.equal(kept.documents.length,3); assert.equal(kept.assets.length,2); assert.equal(kept.current,'shared.md');
assert.equal(kept.documents.find(d=>d.path==='shared.md').revision,'old'); assert.equal(kept.positions.find(p=>p.path==='shared.md').y,100);
assert.equal(await kept.assets[0].blob.text(),'current'); assert.equal(await taken.assets[0].blob.text(),'backup');
assert.equal(taken.positions.find(p=>p.path==='shared.md').y,300);
assert.equal(taken.positions.find(p=>p.path==='shared.md').revision,taken.documents.find(d=>d.path==='shared.md').revision);
assert.equal(taken.positions.find(p=>p.path==='folder-a/note.md').revision,'unique');
const noProgress=planRestore(existing,{...incoming,positions:[]},'merge',take);
assert.equal(noProgress.positions.some(p=>p.path==='shared.md'),false);
pass('Merge preserves unique paths and selected document progress; image choices are independent');

const full={documents:Array.from({length:200},(_,i)=>doc(`file-${i}.md`,'# file',String(i))),assets:[],positions:[],current:null};
assert.throws(()=>planRestore(full,{documents:[doc('extra.md','# extra','x')],assets:[],positions:[],current:null},'merge'),{code:'RESTORE_LIMIT'});
const large=new Blob([new Uint8Array(20*1024*1024)]);
assert.throws(()=>planRestore({documents:[],assets:Array.from({length:5},(_,i)=>({path:`${i}.png`,blob:large})),positions:[],current:null},{documents:[],assets:[{path:'extra.png',blob:new Blob(['x'])}],positions:[],current:null},'merge'),{code:'RESTORE_LIMIT'});
assert.equal(planRestore(full,{documents:[],assets:[],positions:[],current:null},'replace').documents.length,0);
const linkTargets=Array.from({length:350},(_,i)=>[`old-${i}/${'x'.repeat(900)}.svg`,`new-${i}/${'x'.repeat(900)}.svg`]);
assert.throws(()=>planRestore({documents:[],assets:[],positions:[],current:null},{documents:['one.md','two.md'].map(file=>({...doc(file,'# links','x'),linkBase:file,linkTargets})),assets:[],positions:[],current:null},'replace'),{code:'RESTORE_LIMIT'});
pass('Combined capacity is checked without dropping files; explicit replacement remains available');

const loaded=storedLibrarySnapshot({...existing,current:{path:'folder-a/note.md',updatedAt:1},checkpoint:{position:{...pos('shared.md','old',500),updatedAt:200},current:{path:'shared.md',updatedAt:2}},revision:'state'});
assert.equal(loaded.current,'shared.md'); assert.equal(loaded.positions.find(p=>p.path==='shared.md').y,500); assert.equal(loaded.revision,'state');
assert.equal(storedLibrarySnapshot({...existing,current:null,checkpoint:{position:pos('shared.md','stale')},revision:null}).positions.find(p=>p.path==='shared.md').y,100);
pass('Destination snapshots preserve valid latest checkpoints and ignore stale content revisions');

const bothChoices=new Map([['documents:shared.md','both']]);
const both=planRestore(existing,incoming,'merge',bothChoices);
const copy=both.documents.find(d=>d.path==='shared (備份 1).md');
assert.equal(both.documents.length,4); assert.equal(both.assets.length,3);
assert.equal(both.documents.find(d=>d.path==='shared.md'),existing.documents[0]);
assert.equal(both.positions.find(p=>p.path===copy.path).y,300);
assert.equal(both.positions.find(p=>p.path===copy.path).revision,copy.revision);
assert.equal(resolveDocumentPath(copy,'picture.svg?raw=1#preview'),'picture (備份 1).svg');
assert.equal(resolveDocumentPath(copy,'/shared.md#section'),copy.path);
assert.equal(resolveDocumentPath(existing.documents[0],'picture.svg'),'picture.svg');
assert.equal(resolveDocumentPath(copy,'https://example.com/picture.svg'),null);
const twice=planRestore(both,incoming,'merge',new Map([...restoreConflicts(both,incoming).map(c=>[c.key,'existing']),['documents:shared.md','both']]));
assert(twice.documents.some(d=>d.path==='shared (備份 2).md')); assert(twice.assets.some(a=>a.path==='picture (備份 2).svg'));
const future=planRestore(existing,{...incoming,documents:[...incoming.documents,doc('shared (備份 1).md','# reserved','future')]},'merge',bothChoices);
assert.equal(future.documents.find(d=>d.source==='# reserved').path,'shared (備份 1).md');
assert.equal(future.documents.find(d=>d.source==='# backup').path,'shared (備份 2).md');
const longPath='folder/'+'中'.repeat(1014)+'.md';
const longResult=planRestore({documents:[doc(longPath,'# old','o')],assets:[],positions:[],current:null},{documents:[doc(longPath,'# new','n')],assets:[],positions:[],current:null},'merge',new Map([[`documents:${longPath}`,'both']]));
assert.equal(longResult.renamed[0].to.length,1024); assert(longResult.renamed[0].to.startsWith('folder/'));
const chained=planRestore(both,await decodeBackup(await encodeBackup(both)),'merge',new Map(restoreConflicts(both,both).map(c=>[c.key,'both'])));
const chainedCopy=chained.documents.find(d=>d.path==='shared (備份 1) (備份 1).md');
assert.equal(resolveDocumentPath(chainedCopy,'picture.svg'),'picture (備份 1) (備份 1).svg');
assert.equal(resolveDocumentPath(chainedCopy,'shared.md'),chainedCopy.path);
assert.throws(()=>planRestore(full,{...incoming,documents:[doc('file-0.md','# duplicate','x')]},'merge',new Map([['documents:file-0.md','both']])),{code:'RESTORE_LIMIT'});
pass('Keep both allocates collision-free names, isolates images, composes prior link maps and preserves each revision and progress');

const portableBoth=await decodeBackup(await encodeBackup(both));
assert.deepEqual(documentLinks(portableBoth.documents.find(d=>d.path===copy.path)),documentLinks(copy));
assert.equal(portableBoth.documents.find(d=>d.path===copy.path).source,copy.source);
for(const row of [{linkBase:'shared.md',linkTargets:[['picture.svg','../../escape.svg']]},{linkBase:'shared.md',linkTargets:[['picture.svg','javascript:attack()']]},{linkBase:'shared.md',linkTargets:[['picture.svg','one.svg'],['picture.svg','two.svg']]}]) {
  assert.throws(()=>documentLinks(row)); await assert.rejects(()=>encodeBackup({...both,documents:[{...copy,...row}]}));
}
pass('Renamed link metadata survives portable backups; unsafe or duplicate mappings are rejected');

const paragraphs='合併文件庫後，既有文件、圖片與閱讀進度必須保留，同名版本由使用者選擇。\n\n'.repeat(32);
const currentSource='# 目前共用文件\n\n![圖片](picture.svg)\n\n## 目前段落\n\n'+paragraphs+'## 目前接續\n\n'+paragraphs;
const backupSource='# 備份共用文件\n\n![圖片](picture.svg)\n\n<script>window.__mergePreviewAttack=true</script>\n\n$$\\frac{1}{2}$$\n\n```mermaid\nflowchart LR\n A[合併] --> B[保留進度]\n```\n\n## 備份段落\n\n'+paragraphs+'## 備份接續\n\n'+paragraphs;
const onlyCurrent='# 原有獨立文件\n\n![獨有圖片](current.svg)\n\n## 原有開頭\n\n'+paragraphs+'## 原有接續\n\n'+paragraphs;
const image=color=>`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100"><rect width="600" height="100" fill="${color}"/></svg>`;
const currentFolder=path.join(temporary,'current/books'),backupFolder=path.join(temporary,'backup/books');
for (const folder of [currentFolder,backupFolder]) await mkdir(folder,{recursive:true});
await writeFile(path.join(currentFolder,'shared.md'),currentSource); await writeFile(path.join(currentFolder,'only-current.md'),onlyCurrent);
await writeFile(path.join(currentFolder,'picture.svg'),image('green')); await writeFile(path.join(currentFolder,'current.svg'),image('blue'));
await writeFile(path.join(backupFolder,'shared.md'),backupSource); await writeFile(path.join(backupFolder,'only-backup.md'),'# 備份獨立文件\n\n[備份同名文件][copy]\n\n[copy]: /books/shared.md#備份接續\n\n![根目錄圖片](/books/picture.svg)\n\n`[範例](shared.md)`');
await writeFile(path.join(backupFolder,'picture.svg'),image('red')); await writeFile(path.join(backupFolder,'extra.svg'),image('orange'));
let serverUnavailable=false;
const server=await serveSites({source:path.join(root,'dist'),target:path.join(root,'dist')},{intercept:()=>serverUnavailable ? {status:503,body:'Compatibility test: server unavailable'} : undefined});
// WebKit offline emulation can reject SW-served navigation (Playwright #42775).
// Fail the real origin instead; unlike setOffline this verifies cache-only reopening
// without claiming an OS/network disconnect in the compatibility jobs.
async function offline(ctx) { if (compatibility) serverUnavailable=true; else await ctx.setOffline(true); }
const sourceURL=server.origin+'/source/',targetURL=server.origin+'/target/',options={executablePath:!compatibility ? process.env.CHROMIUM_PATH || undefined : undefined,headless:true};
let browser,sourceContext,targetContext,localContext,bothContext;
async function setup(ctx) {
  ctx.setDefaultTimeout(30000);
  await ctx.addInitScript(()=>{
    window.__storageErrors=[]; window.__transactions={started:0,completed:0};
    const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args) {
      try { const tx=transaction.apply(this,args); window.__transactions.started++; tx.addEventListener('complete',()=>window.__transactions.completed++); tx.addEventListener('abort',()=>window.__storageErrors.push(String(tx.error))); return tx; }
      catch(error) {window.__storageErrors.push(`${error.name}: ${error.message}`);throw error;}
    };
  });
  await ctx.route('**/*',route=>route.request().url().startsWith(server.origin+'/') || /^(file:|blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message))); return ctx;
}
const saved=page=>page.locator('#library-status[data-state=saved]').waitFor();
async function preview(page,archive) { await page.locator('#backup-input').setInputFiles(archive); await page.locator('#restore-dialog').waitFor({state:'visible'}); assert.equal(await page.locator('#restore-mode').inputValue(),'merge'); }
async function choose(page,value='existing') { for (const select of await page.locator('#restore-conflicts select').all()) await select.selectOption(value); }
const choice=(page,kind,file)=>page.locator(`#restore-conflicts select[data-kind="${kind}"][data-path="books/${file}"]`);
// Firefox's default clickable quad can drift inside a scrolled native dialog.
// Pick an explicit interior point, retaining Playwright visibility/hit-target checks.
async function confirm(page) { await clickRestore(page); await page.locator('#restore-dialog').waitFor({state:'hidden'}); await saved(page); }
async function at(page,name,amount=120) {
  await saved(page);
  await page.getByRole('heading',{name,exact:true}).evaluate((el,y)=>window.scrollTo({top:el.getBoundingClientRect().top+scrollY+y,behavior:'instant'}),amount);
  await page.waitForTimeout(650); await saved(page); return page.getByRole('heading',{name,exact:true}).evaluate(el=>-el.getBoundingClientRect().top);
}
async function resumed(page,name,amount) {
  try { await page.waitForFunction(({name,amount})=>{const h=[...document.querySelectorAll('#document h2')].find(el=>el.textContent===name);return h && Math.abs(h.getBoundingClientRect().top+amount)<8;},{name,amount}); }
  catch(error) {
    const snapshot=await rows(page),geometry=await page.evaluate(()=>({file:document.getElementById('current-file')?.textContent,status:document.getElementById('library-status')?.dataset.state,y:scrollY,height:document.documentElement.scrollHeight,headings:[...document.querySelectorAll('#document h2')].map(el=>({name:el.textContent,top:el.getBoundingClientRect().top}))}));
    console.error('Progress diagnostic:',JSON.stringify({name,amount,positions:snapshot.positions,page:geometry}));
    await writeFile(path.join(output,'merge-progress-failure.json'),JSON.stringify({name,amount,rows:snapshot,page:geometry},null,2));
    await page.screenshot({path:path.join(output,'merge-failure.png')}); throw error;
  }
  await saved(page);
}
async function rows(page) {
  return page.evaluate(async()=>{
    const r=indexedDB.open(`inkread-library:${new URL('./',location.href).href}`,1),db=await new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const tx=db.transaction(['documents','assets','positions'],'readonly'),result={};
    for(const name of ['documents','assets','positions']) { const request=tx.objectStore(name).getAll(); request.onsuccess=()=>{result[name]=request.result;}; }
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    result.assets=await Promise.all(result.assets.map(async a=>({path:a.path,text:await a.blob.text()}))); return result;
  });
}
try {
  browser=await browserType.launch(options);
  sourceContext=await setup(await libraryContext(browser,path.join(temporary,'donor-profile'),options,{viewport:{width:1440,height:900},acceptDownloads:true}));
  const from=await sourceContext.newPage(); await from.goto(sourceURL); await from.locator('#offline-status[data-state=ready]').waitFor();
  await from.locator('#folder-input').setInputFiles(backupFolder); await from.locator('#user-files button').filter({hasText:'shared.md'}).click();
  await from.locator('.katex').waitFor(); await from.locator('.mermaid-container svg').waitFor(); const backupOffset=await at(from,'備份接續');
  const download=from.waitForEvent('download'); await from.locator('#backup-library').click(); const archive=path.join(temporary,'backup.inkread'); await (await download).saveAs(archive);
  targetContext=await setup(await browserType.launchPersistentContext(path.join(temporary,'profile'),{...options,viewport:{width:1440,height:900}}));
  let page=await targetContext.newPage(); await page.goto(targetURL); await page.locator('#offline-status[data-state=ready]').waitFor();
  await page.locator('#folder-input').setInputFiles(currentFolder); await page.locator('#user-files button').filter({hasText:'only-current.md'}).click();
  const uniqueOffset=await at(page,'原有接續');
  await page.locator('#user-files button').filter({hasText:'shared.md'}).click(); let currentOffset=await at(page,'目前接續');
  let before=await rows(page); await offline(targetContext);
  // Select a backup in the same event as a layout change, before ResizeObserver.
  currentOffset=await page.evaluate(bytes=>{
    document.querySelector('.offline-state').style.minHeight='100px';
    const heading=[...document.querySelectorAll('#document h2')].find(h=>h.textContent==='目前接續');
    window.scrollTo({top:heading.getBoundingClientRect().top+scrollY+120,behavior:'instant'});
    const offset=-heading.getBoundingClientRect().top,transfer=new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)],'backup.inkread',{type:'application/octet-stream'}));
    const input=document.getElementById('backup-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    return offset;
  },[...await readFile(archive)]);
  await page.locator('#restore-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#restore-conflicts select').count(),2); assert.equal(await page.locator('#restore-confirm').isDisabled(),true);
  await page.locator('#restore-conflicts summary').first().click(); assert.equal(await page.locator('#restore-conflicts script').count(),0); assert.equal(await page.evaluate(()=>window.__mergePreviewAttack),undefined);
  await choose(page);
  const imagePreview=page.locator('.restore-conflict').filter({has:page.locator('select[data-kind=assets]')});
  await imagePreview.locator('summary').click();
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('#restore-conflicts img')];return images.length===2 && images.every(img=>img.complete && img.naturalWidth>0);});
  await page.screenshot({path:path.join(output,'merge-preview.png')});
  await page.locator('#restore-cancel').click(); await saved(page);
  await resumed(page,'目前接續',currentOffset);
  assert.deepEqual((await rows(page)).documents,before.documents); assert.deepEqual((await rows(page)).assets,before.assets);
  pass('Merge is the default; unresolved versions block confirmation and cancellation preserves destination data');

  await preview(page,archive); await choose(page); await confirm(page); await resumed(page,'目前接續',currentOffset);
  let after=await rows(page);
  assert.equal(after.documents.length,3); assert.equal(after.assets.length,3);
  assert.equal(after.documents.find(d=>d.path==='books/shared.md').revision,before.documents.find(d=>d.path==='books/shared.md').revision);
  assert.equal(after.assets.find(a=>a.path==='books/picture.svg').text,image('green'));
  assert.equal(after.documents.find(d=>d.path==='books/only-current.md').source,onlyCurrent);
  await page.locator('#user-files button').filter({hasText:'only-current.md'}).click(); await resumed(page,'原有接續',uniqueOffset);
  pass('Keeping current conflicts retains current text, image bytes and independent reading positions while adding new files');

  await preview(page,archive); await choose(page);
  await choice(page,'documents','shared.md').selectOption('backup'); await choice(page,'assets','picture.svg').selectOption('backup'); await confirm(page);
  await page.locator('#user-files button').filter({hasText:'shared.md'}).click(); await resumed(page,'備份接續',backupOffset);
  after=await rows(page); assert.equal(after.documents.find(d=>d.path==='books/shared.md').source,backupSource); assert.equal(after.assets.find(a=>a.path==='books/picture.svg').text,image('red'));
  assert.equal(after.documents.find(d=>d.path==='books/only-current.md').source,onlyCurrent); assert.equal(after.assets.find(a=>a.path==='books/current.svg').text,image('blue'));
  pass('Choosing backup conflicts restores that copy and its progress without replacing unrelated current files or images');

  await preview(page,archive); await choose(page);
  const other=await targetContext.newPage(); await other.goto(targetURL); await other.locator('#app:not([hidden])').waitFor();
  await other.locator('#file-input').setInputFiles({name:'other-tab.md',mimeType:'text/markdown',buffer:Buffer.from('# 其他分頁的新文件')}); await saved(other);
  await clickRestore(page); await page.locator('#restore-error').filter({hasText:'其他分頁已更新文件庫'}).waitFor();
  assert.equal(await page.locator('#restore-confirm').isDisabled(),true); assert((await rows(page)).documents.some(d=>d.path==='other-tab.md'));
  await choose(page); await confirm(page); assert.equal((await rows(page)).documents.length,4);
  await other.close();
  pass('Concurrent destination changes abort the merge and require fresh conflict choices without losing the other tab file');

  await preview(page,archive); await choose(page,'backup'); before=await rows(page);
  await page.evaluate(()=>{window.__mergeClear=IDBObjectStore.prototype.clear;IDBObjectStore.prototype.clear=function(...args){const r=window.__mergeClear.apply(this,args);if(this.name==='documents')this.transaction.abort();return r;};});
  await clickRestore(page); await page.locator('#restore-error').filter({hasText:'原文件庫仍保留'}).waitFor();
  assert.deepEqual((await rows(page)).documents,before.documents); assert.deepEqual((await rows(page)).assets,before.assets);
  await page.evaluate(()=>{IDBObjectStore.prototype.clear=window.__mergeClear;}); await confirm(page);
  pass('Failed merge transactions roll back all changes and can retry with the selected versions intact');

  await page.locator('#user-files button').filter({hasText:'only-current.md'}).click(); await resumed(page,'原有接續',uniqueOffset); await saved(page);
  await targetContext.close(); targetContext=undefined;
  targetContext=await setup(await browserType.launchPersistentContext(path.join(temporary,'profile'),{...options,viewport:{width:1440,height:900}})); await offline(targetContext);
  page=await targetContext.newPage(); await page.goto(targetURL+'?merged-restart=1'); await resumed(page,'原有接續',uniqueOffset);
  assert.equal(await page.locator('#user-files button').count(),4); assert.equal(await page.locator('#document img[src^="blob:"]').evaluate(img=>img.complete && img.naturalWidth>0),true);
  await page.locator('#user-files button').filter({hasText:'shared.md'}).click(); await resumed(page,'備份接續',backupOffset); await page.locator('.katex').waitFor(); await page.locator('.mermaid-container svg').waitFor();
  pass('Persistent profile reopening preserves the merged library and both chosen and untouched reading positions');

  await page.evaluate(()=>{document.querySelector('.offline-state').style.minHeight='';});
  await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(1200); await saved(page);
  const settledPositions=(await rows(page)).positions; await page.waitForTimeout(1100); await saved(page);
  assert.deepEqual((await rows(page)).positions,settledPositions,'Idle status labels must not cause a repeated progress-save loop');
  await page.locator('#sidebar-toggle').click(); await preview(page,archive);
  await choose(page); await page.screenshot({path:path.join(output,'merge-mobile.png')});
  await page.locator('#restore-mode').selectOption('replace'); assert.equal(await page.locator('#restore-conflicts select').count(),0); assert.equal(await page.locator('#restore-confirm').textContent(),'還原並取代文件庫');
  await page.locator('#restore-mode').selectOption('merge'); assert.equal(await page.locator('#restore-confirm').isDisabled(),false);
  await page.locator('#restore-cancel').click();
  pass('Mobile conflict choices remain usable; switching modes preserves explicit choices and replacement is clearly labeled');

  serverUnavailable=false;
  bothContext=await setup(await browserType.launchPersistentContext(path.join(temporary,'both-profile'),{...options,viewport:{width:1440,height:900},acceptDownloads:true}));
  let bothPage=await bothContext.newPage(); await bothPage.goto(targetURL); await bothPage.locator('#offline-status[data-state=ready]').waitFor();
  // A fresh browser profile must keep its two versions independent, even offline.
  await bothPage.locator('#folder-input').setInputFiles(currentFolder); await bothPage.locator('#user-files button').filter({hasText:'shared.md'}).click();
  const bothCurrentOffset=await at(bothPage,'目前接續'); await offline(bothContext);
  await preview(bothPage,archive); await choice(bothPage,'documents','shared.md').selectOption('both');
  assert.equal(await choice(bothPage,'assets','picture.svg').inputValue(),'both'); assert.equal(await choice(bothPage,'assets','picture.svg').isDisabled(),true);
  assert.match(await bothPage.locator('#restore-result').textContent(),/shared \(備份 1\)\.md/); assert.equal(await bothPage.locator('#restore-confirm').isEnabled(),true);
  await bothPage.screenshot({path:path.join(output,'merge-keep-both.png')}); await confirm(bothPage);
  await resumed(bothPage,'目前接續',bothCurrentOffset);
  let bothRows=await rows(bothPage); assert.equal(bothRows.documents.length,4); assert.equal(bothRows.assets.length,4);
  assert.equal(bothRows.assets.find(a=>a.path==='books/picture.svg').text,image('green'));
  assert.equal(bothRows.assets.find(a=>a.path==='books/picture (備份 1).svg').text,image('red'));
  async function assertImage(page,color) {
    await page.waitForFunction(()=>{const img=document.querySelector('#document img[src^="blob:"]');return img?.complete && img.naturalWidth>0;});
    const pixel=await page.locator('#document img[src^="blob:"]').first().evaluate(img=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});
    assert.deepEqual(pixel,color==='red' ? [255,0,0,255] : [0,128,0,255]);
  }
  await assertImage(bothPage,'green');
  await bothPage.locator('#user-files button').filter({hasText:'shared (備份 1).md'}).click(); await resumed(bothPage,'備份接續',backupOffset); await assertImage(bothPage,'red');
  await bothPage.locator('#user-files button').filter({hasText:'only-backup.md'}).click(); await assertImage(bothPage,'red');
  await bothPage.getByRole('link',{name:'備份同名文件',exact:true}).click(); await bothPage.getByRole('heading',{name:'備份共用文件',exact:true}).waitFor();
  await assertImage(bothPage,'red');
  await bothPage.locator('#user-files button').filter({hasText:'shared (備份 1).md'}).click(); const bothBackupOffset=await at(bothPage,'備份接續');
  await resumed(bothPage,'備份接續',bothBackupOffset);
  pass('Keep both previews automatic names and restores separate document images, reference links and both original progress values');

  await bothContext.close(); bothContext=undefined;
  bothContext=await setup(await browserType.launchPersistentContext(path.join(temporary,'both-profile'),{...options,viewport:{width:1440,height:900}})); await offline(bothContext);
  bothPage=await bothContext.newPage(); await bothPage.goto(targetURL+'?both-restart=1'); await resumed(bothPage,'備份接續',bothBackupOffset); await assertImage(bothPage,'red');
  await bothPage.locator('#user-files button').filter({hasText:'shared.md'}).click(); await resumed(bothPage,'目前接續',bothCurrentOffset); await assertImage(bothPage,'green');
  // Export after IndexedDB reopens, so format 2 exercises the same regression
  // as format 1 before transferring the actual download into a fresh profile.
  const bothDownload=bothPage.waitForEvent('download'); await bothPage.locator('#backup-library').click(); const bothArchive=path.join(temporary,'both.inkread'); await (await bothDownload).saveAs(bothArchive);
  const bothBytes=await readFile(bothArchive);
  assert.equal(JSON.parse(bothBytes.subarray(44,44+bothBytes.readUInt32LE(8))).version,2);
  const decodedBoth=await decodeBackup(new Blob([bothBytes]));
  assert.equal(resolveDocumentPath(decodedBoth.documents.find(d=>d.path==='books/shared (備份 1).md'),'picture.svg'),'books/picture (備份 1).svg');
  await preview(bothPage,archive); await choose(bothPage); await choice(bothPage,'documents','shared.md').selectOption('both'); await confirm(bothPage);
  assert((await rows(bothPage)).documents.some(d=>d.path==='books/shared (備份 2).md'));
  pass('Persistent profile restart and another merge keep both copies independent; re-exported backups preserve local link mappings');

  if (!compatibility) {
  localContext=await setup(await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:900}})); await localContext.setOffline(true);
  const local=await localContext.newPage(); await local.goto(pathToFileURL(path.join(root,'dist/index.html')).href); await local.locator('#app:not([hidden])').waitFor();
  await local.locator('#folder-input').setInputFiles(currentFolder); await saved(local); await preview(local,archive); await choose(local); await confirm(local);
  assert.equal(await local.locator('#user-files button').count(),3); assert.equal((await rows(local)).assets.find(a=>a.path==='books/picture.svg').text,image('green'));
  pass('The file:// version merges the same backup completely offline while keeping existing conflicting images');

  } else {
    // Reuse the exact keep-both archive in a fresh HTTP profile, with no seed data.
    serverUnavailable=false;
    localContext=await setup(await libraryContext(browser,path.join(temporary,'roundtrip-profile'),options,{viewport:{width:1440,height:900},acceptDownloads:true}));
  }
  const transferred=compatibility ? await localContext.newPage() : localContext.pages()[0];
  if (compatibility) { await transferred.goto(targetURL); await transferred.locator('#offline-status[data-state=ready]').waitFor(); await offline(localContext); }
  const local=transferred;
  await preview(local,bothArchive); await local.locator('#restore-mode').selectOption('replace'); await confirm(local);
  assert.equal((await rows(local)).documents.length,4);
  await local.locator('#user-files button').filter({hasText:'shared (備份 1).md'}).click(); await resumed(local,'備份接續',bothBackupOffset); await assertImage(local,'red');
  await local.locator('#user-files button').filter({hasText:'shared.md'}).click(); await resumed(local,'目前接續',bothCurrentOffset); await assertImage(local,'green');
  await local.locator('#user-files button').filter({hasText:'only-backup.md'}).click(); await local.getByRole('link',{name:'備份同名文件',exact:true}).click();
  await local.getByRole('heading',{name:'備份共用文件',exact:true}).waitFor(); await assertImage(local,'red');
  const restored=await rows(local);
  assert.equal(restored.documents.length,decodedBoth.documents.length);
  const portableDocuments=docs=>docs.map(d=>({path:d.path,source:d.source,pasted:d.pasted,...documentLinks(d)})).sort((a,b)=>a.path.localeCompare(b.path));
  assert.deepEqual(portableDocuments(restored.documents),portableDocuments(decodedBoth.documents));
  assert.deepEqual(restored.assets.map(a=>({path:a.path,text:a.text})).sort((a,b)=>a.path.localeCompare(b.path)),await Promise.all(decodedBoth.assets.map(async a=>({path:a.path,text:await a.blob.text()}))).then(a=>a.sort((a,b)=>a.path.localeCompare(b.path))));
  pass(`A format 2 backup transfers to a fresh ${compatibility ? 'HTTP' : 'file://'} library with independent images, document links and progress`);

  assert.deepEqual(errors,[]); await writeFile(path.join(output,'merge-results.json'),JSON.stringify({browser:browserName,engineVersion:browser.version(),compatibility,offlineMethod:compatibility ? 'HTTP 503 at real origin (not network-disconnect emulation)' : 'context.setOffline',checks:results,total:results.length,uncaughtErrors:errors},null,2));
  console.log(`\n${results.length} library merge checks passed.`);
} catch(error) {
  await writeFile(path.join(output,'merge-failure.json'),JSON.stringify({browser:browserName,completed:results,error:error.stack},null,2));
  for (const [index,ctx] of [localContext,bothContext,targetContext,sourceContext].entries()) {
    for (const [tab,page] of (ctx?.pages() || []).entries()) if (!page.isClosed()) {
      await page.screenshot({path:path.join(output,`merge-failure-${index}-${tab}.png`)}).catch(()=>{});
      const diagnostic=await page.evaluate(()=>({url:location.href,y:scrollY,status:document.getElementById('library-status')?.outerHTML,offline:document.getElementById('offline-status')?.outerHTML,errors:window.__storageErrors,transactions:window.__transactions,geometry:['restore-dialog','restore-confirm','library-status'].map(id=>{const el=document.getElementById(id),r=el?.getBoundingClientRect();return {id,rect:r?.toJSON(),hit:r ? document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500) : null};})})).catch(e=>({error:e.message}));
      await writeFile(path.join(output,`merge-failure-${index}-${tab}.json`),JSON.stringify(diagnostic,null,2));
      console.error('Browser failure diagnostic:',JSON.stringify(diagnostic));
    }
  }
  throw error;
} finally {
  await localContext?.close(); await sourceContext?.close(); await targetContext?.close(); await bothContext?.close(); await browser?.close(); await server.close();
  if (!path.resolve(temporary).startsWith(output+path.sep)) throw new Error('Unsafe temporary path'); await rm(temporary,{recursive:true,force:true});
}
