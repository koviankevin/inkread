import {browserType,compatibility,browserName,checkExamples,probeFileOrigin,libraryContext} from './browser-compat.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encodeBackup,decodeBackup,MAX_BACKUP_BYTES} from '../src/library-backup.js';
import {serveSites} from './site-server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'test-results',...(compatibility ? [browserName] : []));
await mkdir(output,{recursive:true});
await rm(path.join(output,'backup-failure.json'),{force:true});
const temporary=await mkdtemp(path.join(output,'backup-test-'));
const results=[],errors=[];
const pass=name=>{results.push(name);console.log(`PASS ${name}`);};
const position={path:'中文/筆記.md',y:120,ratio:.2,fraction:.3,anchor:'章節',atEnd:false,updatedAt:Date.now()};
const snapshot={documents:[{path:position.path,source:'# 中文\n\n<script>attack()</script>',pasted:true}],assets:[{path:'中文/圖.png',blob:new Blob([new Uint8Array([0,1,128,255])],{type:'image/png'})}],positions:[position],current:position.path};
const encoded=await encodeBackup(snapshot),decoded=await decodeBackup(encoded);
assert.equal(decoded.documents[0].source,snapshot.documents[0].source);
assert.equal(decoded.documents[0].pasted,true);
assert.deepEqual(new Uint8Array(await decoded.assets[0].blob.arrayBuffer()),new Uint8Array([0,1,128,255]));
assert.deepEqual(decoded.positions,[position]);
assert.equal(decoded.current,position.path);
pass('Portable binary backup preserves UTF-8, original image bytes and progress without base64');

async function rewrite(change) {
  const bytes=new Uint8Array(await encoded.arrayBuffer()),length=new DataView(bytes.buffer).getUint32(8,true);
  const manifest=JSON.parse(new TextDecoder().decode(bytes.slice(44,44+length))); change(manifest);
  const body=new TextEncoder().encode(JSON.stringify(manifest)),header=bytes.slice(0,44);
  new DataView(header.buffer).setUint32(8,body.length,true);
  header.set(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),12);
  return new Blob([header,body,bytes.slice(44+length)]);
}
const broken=new Uint8Array(await encoded.arrayBuffer()); broken[broken.length-1]^=1;
for (const blob of [new Blob([broken]),encoded.slice(0,encoded.size-1),new Blob([encoded,'trailing']),await rewrite(m=>m.version=3),await rewrite(m=>m.documents[0].size=2*1024*1024+1)]) await assert.rejects(()=>decodeBackup(blob));
const badHeader=new Uint8Array(44); badHeader.set([73,78,75,82,69,65,68,0]); new DataView(badHeader.buffer).setUint32(8,0xffffffff,true);
await assert.rejects(()=>decodeBackup(new Blob([badHeader])));
assert(MAX_BACKUP_BYTES<123*1024*1024);
pass('Corrupt, truncated, trailing, unsupported and oversized backups fail before restoration');
for (const change of [m=>m.documents[0].path='../../escape.md',m=>m.documents[0].path='範例/開始閱讀.md',m=>m.documents.push({...m.documents[0]}),m=>m.positions[0].ratio=2,m=>m.positions.push({...m.positions[0]}),m=>m.assets[0].path='payload.html',m=>m.assets[0].path='payload.constructor',m=>m.current='unknown.md',m=>Object.assign(m.documents[0],{linkBase:'safe.md',linkTargets:[]}),m=>{m.version=2;Object.assign(m.documents[0],{linkBase:'safe.md',linkTargets:[['image.svg','../../escape.svg']]});},m=>{m.version=2;Object.assign(m.documents[0],{linkBase:'safe.md',linkTargets:[['image.svg','one.svg'],['image.svg','two.svg']]});}]) await assert.rejects(async()=>decodeBackup(await rewrite(change)));
pass('Untrusted manifests reject unsafe paths, duplicate entries, invalid progress and non-image assets');

const fixture=path.join(temporary,'books'); await mkdir(path.join(fixture,'assets'),{recursive:true});
const paragraphs='跨瀏覽器還原之後，文件、圖片與每份文件的閱讀位置都應完整保留。\n\n'.repeat(35);
const source='# 跨裝置文件\n\n![圖片](assets/picture.svg)\n\n![遠端](https://example.com/private.svg)\n\n[下一份](second.md)\n\n<script>window.__backupAttack=true</script>\n\n$$\\frac{1}{2}+\\sqrt{x}$$\n\n```mermaid\nflowchart LR\n A[備份] --> B[離線還原]\n```\n\n## 第一節\n\n'+paragraphs+'## 接續閱讀\n\n'+paragraphs;
await writeFile(path.join(fixture,'book.md'),source);
await writeFile(path.join(fixture,'second.md'),'# 第二份文件\n\n## 開頭\n\n'+paragraphs+'## 第二份接續\n\n'+paragraphs);
await writeFile(path.join(fixture,'assets/picture.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><rect width="600" height="120" fill="#23705d"/></svg>');
let serverUnavailable=false;
const server=await serveSites({source:path.join(root,'dist'),target:path.join(root,'dist')},{intercept:()=>serverUnavailable ? {status:503,body:'Compatibility test: server unavailable'} : undefined});
// WebKit offline emulation can reject SW-served navigation (Playwright #42775).
// Fail the real origin instead; unlike setOffline this verifies cache-only reopening
// without claiming an OS/network disconnect in the compatibility jobs.
async function offline(ctx) { if (compatibility) serverUnavailable=true; else await ctx.setOffline(true); }
const sourceURL=server.origin+'/source/',targetURL=server.origin+'/target/';
const options={executablePath:!compatibility ? process.env.CHROMIUM_PATH || undefined : undefined,headless:true};
let browser,donor,receiver,local;
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
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  return ctx;
}
const saved=page=>page.locator('#library-status[data-state=saved]').waitFor();
async function open(page,name,source) { await page.locator('#file-input').setInputFiles({name,mimeType:'text/markdown',buffer:Buffer.from(source)}); await saved(page); }
async function backup(page,filename) {
  if (compatibility) await page.evaluate(()=>{
    window.__backupObjectURL=URL.createObjectURL;
    URL.createObjectURL=function(blob) {if(blob.type==='application/octet-stream') window.__downloadBlob=blob; return window.__backupObjectURL.call(this,blob);};
  });
  try {
    const download=page.waitForEvent('download'); await page.locator('#backup-library').click();
    const item=await download; assert(item.suggestedFilename().endsWith('.inkread')); await item.saveAs(filename); await saved(page);
    if (compatibility) {
      const bytes=await readFile(filename),memory=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await window.__downloadBlob.arrayBuffer()))));
      const manifest=JSON.parse(bytes.subarray(44,44+bytes.readUInt32LE(8)));
      const expectedSize=44+bytes.readUInt32LE(8)+[...manifest.documents,...manifest.assets].reduce((n,row)=>n+row.size,0);
      await writeFile(path.join(output,path.basename(filename)),bytes);
      await writeFile(path.join(output,path.basename(filename)+'.json'),JSON.stringify({downloaded:bytes.length,inMemory:memory.length,expectedSize,manifest,stored:await rows(page)},null,2));
      console.log('Backup byte sizes:',JSON.stringify({filename:path.basename(filename),downloaded:bytes.length,inMemory:memory.length,expectedSize}));
      assert.deepEqual(bytes,memory,'Downloaded bytes must match the actual browser-generated Blob');
      assert.equal(bytes.length,expectedSize,'Archive must contain exactly the declared document and image bytes');
    }
  } finally {
    if(compatibility) await page.evaluate(()=>{URL.createObjectURL=window.__backupObjectURL;delete window.__downloadBlob;});
  }
}
async function preview(page,file) { await page.locator('#backup-input').setInputFiles(file); await page.locator('#restore-dialog').waitFor({state:'visible'}); await page.locator('#restore-mode').selectOption('replace'); }
async function offset(page,name,amount=120) {
  await page.getByRole('heading',{name,exact:true}).evaluate((el,y)=>window.scrollTo({top:el.getBoundingClientRect().top+scrollY+y,behavior:'instant'}),amount);
  await page.waitForTimeout(650); await saved(page);
  return page.getByRole('heading',{name,exact:true}).evaluate(el=>-el.getBoundingClientRect().top);
}
async function positionRestored(page,name,amount) {
  try { await page.waitForFunction(({name,amount})=>{
    const el=[...document.querySelectorAll('#document h2')].find(el=>el.textContent===name);
    return el && Math.abs(el.getBoundingClientRect().top+amount)<8;
  },{name,amount}); } catch(error) {
    await writeFile(path.join(output,'backup-progress-failure.json'),JSON.stringify({name,amount,stored:await rows(page),page:await page.evaluate(()=>({visibility:document.visibilityState,y:scrollY,status:document.getElementById('library-status').textContent,headings:[...document.querySelectorAll('#document h2')].map(el=>({text:el.textContent,top:el.getBoundingClientRect().top}))}))},null,2));
    throw error;
  } await saved(page);
}
async function rows(page) {
  return page.evaluate(async()=>{
    const r=indexedDB.open(`inkread-library:${new URL('./',location.href).href}`,1);
    const db=await new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const tx=db.transaction(['documents','assets','positions'],'readonly'),result={};
    for (const name of ['documents','assets','positions']) { const request=tx.objectStore(name).getAll(); request.onsuccess=()=>{result[name]=request.result.map(row=>({...row,blob:row.blob && {size:row.blob.size}}));}; }
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);}); db.close(); return result;
  });
}
try {
  browser=await browserType.launch(options);
  donor=await setup(await libraryContext(browser,path.join(temporary,'donor-profile'),options,{viewport:{width:1440,height:900},acceptDownloads:true}));
  const from=await donor.newPage(); await from.goto(sourceURL); await from.locator('#app:not([hidden])').waitFor();
  await from.locator('#folder-input').setInputFiles(fixture);
  await from.locator('#user-files button').filter({hasText:'second.md'}).click();
  // Status text wraps on small windows and moves the article without resizing it.
  await from.locator('.offline-state').evaluate(el=>{el.style.minHeight='100px';});
  await from.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const secondOffset=await offset(from,'第二份接續');
  await from.locator('#user-files button').filter({hasText:'book.md'}).click();
  await from.locator('.katex').waitFor(); await from.locator('.mermaid-container svg').waitFor();
  const readerOffset=await offset(from,'接續閱讀');
  const archive=path.join(temporary,'library.inkread'); await backup(from,archive);
  const archiveBytes=await readFile(archive);
  assert.equal(JSON.parse(archiveBytes.subarray(44,44+archiveBytes.readUInt32LE(8))).version,1);
  const content=await decodeBackup(new Blob([archiveBytes]));
  assert.equal(content.documents.length,2); assert.equal(content.assets.length,1); assert.equal(content.positions.length,2);
  assert.equal(content.current.endsWith('/book.md'),true);
  receiver=await setup(await browserType.launchPersistentContext(path.join(temporary,'profile'),{...options,viewport:{width:1440,height:900},acceptDownloads:true}));
  let page=await receiver.newPage(); await page.goto(targetURL); await page.locator('#offline-status[data-state=ready]').waitFor();
  await open(page,'keep.md','# 原文件庫仍保留');
  await offline(receiver);
  await preview(page,archive); assert((await page.locator('#restore-summary').textContent()).includes('2 份文件'));
  await page.locator('#restore-cancel').click(); await saved(page);
  assert.equal((await rows(page)).documents[0].path,'keep.md');
  pass('UI downloads a complete library; restore preview and cancellation preserve the destination');

  await page.locator('#backup-input').setInputFiles({name:'broken.inkread',mimeType:'application/octet-stream',buffer:Buffer.from('broken')});
  await page.locator('#toast').filter({hasText:'無法讀取備份'}).waitFor(); await saved(page);
  assert.equal(await page.locator('#restore-dialog').evaluate(el=>el.open),false);
  assert.equal((await rows(page)).documents[0].path,'keep.md');
  await page.evaluate(()=>Object.defineProperty(crypto,'subtle',{value:undefined,configurable:true}));
  await page.locator('#restore-library').click();
  await page.locator('#toast').filter({hasText:'備份與還原需要 HTTPS'}).waitFor();
  await page.evaluate(()=>{delete crypto.subtle;});
  pass('Invalid backups and unavailable cryptography leave saved documents unchanged and show clear feedback');

  const other=await receiver.newPage(); await other.goto(targetURL); await other.locator('#document h1').filter({hasText:'原文件庫仍保留'}).waitFor(); await saved(other);
  await preview(page,archive);
  await page.evaluate(()=>{
    window.__backupClear=IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear=function(...args) {
      const request=window.__backupClear.apply(this,args);
      if (this.name==='documents') this.transaction.abort();
      return request;
    };
  });
  await page.locator('#restore-confirm').click(); await page.locator('#restore-error').filter({hasText:'原文件庫仍保留'}).waitFor();
  assert.equal((await rows(page)).documents[0].path,'keep.md');
  await page.evaluate(()=>{IDBObjectStore.prototype.clear=window.__backupClear;});
  await page.locator('#restore-confirm').click(); await page.locator('#restore-dialog').waitFor({state:'hidden'});
  await positionRestored(page,'接續閱讀',readerOffset);
  assert.equal((await rows(page)).documents.length,2);
  await other.waitForFunction(()=>document.querySelectorAll('#user-files button').length===0);
  await other.reload(); await other.locator('#document h1').filter({hasText:'跨裝置文件'}).waitFor(); await other.close();
  pass('A failed replacement rolls back clears; retry commits all records and invalidates other tabs');

  assert.equal(await page.locator('#document img[src^="blob:"]').evaluate(img=>img.complete && img.naturalWidth>0),true);
  await page.locator('.katex').waitFor(); await page.locator('.mermaid-container svg').waitFor();
  assert.equal(await page.evaluate(()=>window.__backupAttack),undefined);
  assert.equal(await page.locator('#document script').count(),0);
  await page.getByRole('button',{name:'允許此文件載入遠端圖片',exact:true}).waitFor();
  await page.locator('#document a').filter({hasText:'下一份'}).evaluate(el=>el.click());
  await positionRestored(page,'第二份接續',secondOffset);
  await page.locator('#user-files button').filter({hasText:'book.md'}).click(); await positionRestored(page,'接續閱讀',readerOffset);
  pass('Cross-profile and cross-URL restore preserves links, images, formulas, diagrams and per-document progress safely');

  await receiver.close(); receiver=undefined;
  receiver=await setup(await browserType.launchPersistentContext(path.join(temporary,'profile'),{...options,viewport:{width:1440,height:900},acceptDownloads:true}));
  await offline(receiver); page=await receiver.newPage(); await page.goto(targetURL+'?reopened=1');
  await positionRestored(page,'接續閱讀',readerOffset);
  await page.locator('.katex').waitFor(); await page.locator('.mermaid-container svg').waitFor();
  await page.waitForFunction(()=>{const img=document.querySelector('#document img[src^="blob:"]');return img?.complete && img.naturalWidth>0;});
  pass(compatibility ? 'Persistent profile reopens the transferred library with its origin returning HTTP 503' : 'A browser restart offline restores the transferred library without reimporting the backup');

  const secondArchive=path.join(temporary,'second.inkread'); await backup(page,secondArchive);
  const again=await decodeBackup(new Blob([await readFile(secondArchive)]));
  // Folder enumeration and IndexedDB key order can differ across platforms.
  const byPath=docs=>docs.map(({path,source,pasted})=>({path,source,pasted})).sort((a,b)=>a.path<b.path ? -1 : a.path>b.path ? 1 : 0);
  assert.deepEqual(byPath(again.documents),byPath([...content.documents].reverse()));
  assert.deepEqual(Buffer.from(await again.assets[0].blob.arrayBuffer()),Buffer.from(await content.assets[0].blob.arrayBuffer()));
  assert.equal(again.positions.length,2);
  await page.setViewportSize({width:390,height:844}); await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('#restore-library').isVisible(),true);
  await page.locator('#restore-library').evaluate(el=>el.blur());
  await page.screenshot({path:path.join(output,'backup-mobile.png')});
  pass('A restored library can be backed up again; transfer controls remain accessible on mobile');

  if (compatibility) {
    await checkExamples(page,output,archive);
    pass('Collapsed examples, search expansion and mobile restore cancellation preserve the document list');
    serverUnavailable=false;
    local=await setup(await libraryContext(browser,path.join(temporary,'roundtrip-profile'),options,{viewport:{width:1440,height:900},acceptDownloads:true}));
    const fresh=await local.newPage(); await fresh.goto(targetURL); await fresh.locator('#offline-status[data-state=ready]').waitFor(); await offline(local);
    await preview(fresh,secondArchive); await fresh.locator('#restore-confirm').click(); await fresh.locator('#restore-dialog').waitFor({state:'hidden'});
    await positionRestored(fresh,'接續閱讀',readerOffset);
    await fresh.locator('#document a').filter({hasText:'下一份'}).click(); await positionRestored(fresh,'第二份接續',secondOffset);
    assert.deepEqual((await rows(fresh)).documents.map(d=>d.path).sort(),content.documents.map(d=>d.path).sort());
    pass('Re-exported format 1 archive restores into a fresh HTTP library with document links and progress');
    await probeFileOrigin(browser,path.join(root,'dist/index.html'),output,path.join(temporary,'file-probe-profile'));
  } else {
  local=await setup(await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:900},acceptDownloads:true}));
  await local.setOffline(true); const filePage=await local.newPage(); await filePage.goto(pathToFileURL(path.join(root,'dist/index.html')).href);
  await filePage.locator('#app:not([hidden])').waitFor(); await preview(filePage,archive);
  await filePage.locator('#restore-confirm').click(); await filePage.locator('#restore-dialog').waitFor({state:'hidden'});
  await positionRestored(filePage,'接續閱讀',readerOffset);
  await filePage.locator('.mermaid-container svg').waitFor(); await filePage.locator('.katex').waitFor();
  const localArchive=path.join(temporary,'file.inkread'); await backup(filePage,localArchive);
  assert.equal((await decodeBackup(new Blob([await readFile(localArchive)]))).documents.length,2);
  pass('The extracted file:// app restores and exports the same portable backup fully offline');

  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'backup-results.json'),JSON.stringify({browser:browserName,engineVersion:browser.version(),compatibility,offlineMethod:compatibility ? 'HTTP 503 at real origin (not network-disconnect emulation)' : 'context.setOffline',checks:results,total:results.length,uncaughtErrors:errors},null,2));
  console.log(`\n${results.length} backup and restore checks passed.`);
} catch(error) {
  await writeFile(path.join(output,'backup-failure.json'),JSON.stringify({browser:browserName,completed:results,error:error.stack},null,2));
  for (const [index,ctx] of [receiver,donor].entries()) {
    for (const [tab,page] of (ctx?.pages() || []).entries()) if (!page.isClosed()) {
      await page.screenshot({path:path.join(output,`backup-failure-${index}-${tab}.png`)}).catch(()=>{});
      const diagnostic=await page.evaluate(()=>({url:location.href,y:scrollY,status:document.getElementById('library-status')?.outerHTML,offline:document.getElementById('offline-status')?.outerHTML,errors:window.__storageErrors,transactions:window.__transactions,geometry:['restore-dialog','restore-confirm','library-status'].map(id=>{const el=document.getElementById(id),r=el?.getBoundingClientRect();return {id,rect:r?.toJSON(),hit:r ? document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500) : null};})})).catch(e=>({error:e.message}));
      await writeFile(path.join(output,`backup-failure-${index}-${tab}.json`),JSON.stringify(diagnostic,null,2));
      console.error('Browser failure diagnostic:',JSON.stringify(diagnostic));
    }
  }
  throw error;
} finally {
  await local?.close(); await donor?.close(); await receiver?.close(); await browser?.close(); await server.close();
  if (!path.resolve(temporary).startsWith(output+path.sep)) throw new Error('Unsafe temporary path');
  await rm(temporary,{recursive:true,force:true});
}
