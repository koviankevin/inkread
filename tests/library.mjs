import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {serveSites} from './site-server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'test-results');
await mkdir(output,{recursive:true});
await Promise.all(['library-failure.json','library-failure.png'].map(file=>rm(path.join(output,file),{force:true})));
const profile=await mkdtemp(path.join(output,'library-profile-'));
const fixture=await mkdtemp(path.join(output,'library-files-'));
await mkdir(path.join(fixture,'assets'));
const paragraphs='閱讀進度要在離線重新開啟後保留。這一段包含足夠的中文內容以測試文字排版與捲動位置。\n\n'.repeat(24);
const source='# 我的長文件\n\n![本機圖片](assets/picture.svg)\n\n![遠端圖片](https://example.com/private-pixel.svg)\n\n$$\\frac{1}{2}+\\sqrt{x}$$\n\n```mermaid\nflowchart LR\n A[離線文件] --> B[接續閱讀]\n```\n\n## 第一節\n\n'+paragraphs+'## 第二節\n\n'+paragraphs+'## 第三節\n\n'+paragraphs;
await writeFile(path.join(fixture,'reader.md'),source);
await writeFile(path.join(fixture,'second.md'),'# 第二份文件\n\n## 開始\n\n'+paragraphs+'## 後半\n\n'+paragraphs);
await writeFile(path.join(fixture,'assets/picture.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180"><rect width="600" height="180" fill="#23705d"/></svg>');
let unavailable=false;
const server=await serveSites({app:path.join(root,'dist')},{intercept:()=>unavailable ? {status:503} : undefined});
const url=server.origin+'/app/';
const options={executablePath:process.env.CHROMIUM_PATH || undefined,headless:true};
let context,browser;
const results=[],errors=[];
const networkErrors=[],consoleErrors=[];
const pass=name=>{results.push(name);console.log(`PASS ${name}`);};
async function setup(ctx) {
  ctx.setDefaultTimeout(30000);
  await ctx.route('**/*',route=>route.request().url().startsWith(server.origin+'/') || /^(file:|blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  ctx.on('requestfailed',request=>networkErrors.push({url:request.url(),failure:request.failure()}));
  ctx.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  return ctx;
}
async function saved(page) { await page.locator('#library-status[data-state=saved]').waitFor(); }
async function open(page,name,content) { await page.locator('#file-input').setInputFiles({name,mimeType:'text/markdown',buffer:Buffer.from(content)}); }
async function paste(page,name,content) {
  await page.locator('#paste-button').click();
  await page.locator('#paste-name').focus(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#paste-name').evaluate(input=>document.activeElement===input),true,'Opening the dialog must not steal focus after the filename is selected');
  await page.locator('#paste-name').fill(name);
  await page.locator('#paste-content').fill(content); await page.locator('#paste-submit').click(); await saved(page);
}
async function inspect(page) {
  return page.evaluate(async()=>{
    const request=indexedDB.open(`inkread-library:${new URL('./',location.href).href}`,1);
    const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const tx=db.transaction(['documents','assets','positions','meta'],'readonly');
    const values={};
    for (const name of ['documents','assets','positions']) {
      const r=tx.objectStore(name).getAll();r.onsuccess=()=>{values[name]=r.result.map(row=>({...row,blob:row.blob ? {size:row.blob.size,type:row.blob.type} : undefined}));};
    }
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    db.close();return values;
  });
}
async function settle(page) {
  await saved(page); await page.waitForTimeout(80);
  await page.waitForFunction(()=>document.getElementById('library-status').dataset.state==='saved');
}
async function atHeading(page,name,offset=210) {
  await page.getByRole('heading',{name,exact:true}).evaluate((heading,amount)=>window.scrollTo({top:heading.getBoundingClientRect().top+scrollY+amount,behavior:'instant'}),offset);
  await settle(page);
  return page.evaluate(()=>scrollY);
}
try {
  context=await setup(await chromium.launchPersistentContext(profile,{...options,viewport:{width:1440,height:900}}));
  let page=await context.newPage(); await page.goto(url);
  await page.locator('#app:not([hidden])').waitFor();
  await page.locator('#folder-input').setInputFiles(fixture);
  await page.locator('#user-files button').filter({hasText:'reader.md'}).click();
  await page.locator('.mermaid-container svg').waitFor(); await page.locator('.katex').waitFor();
  await saved(page);
  await paste(page,'筆記.md','# 已保存的貼上文件\n\n貼上的內容也要保留。');
  let stored=await inspect(page);
  assert.equal(stored.documents.length,3); assert.equal(stored.assets.length,1);
  assert.equal(stored.assets[0].blob.type,'image/svg+xml');
  assert(stored.documents.some(doc=>doc.pasted && doc.source.includes('已保存的貼上文件')));
  pass('Imported files, folder image Blobs and pasted documents commit to browser storage');

  await page.locator('#user-files button').filter({hasText:'second.md'}).click();
  const secondY=await atHeading(page,'後半');
  await page.locator('#user-files button').filter({hasText:'reader.md'}).click();
  await page.locator('.mermaid-container svg').waitFor();
  const readerY=await atHeading(page,'第二節');
  await page.locator('#user-files button').filter({hasText:'second.md'}).click();
  await page.waitForFunction(y=>Math.abs(scrollY-y)<8,secondY);
  await page.locator('#user-files button').filter({hasText:'reader.md'}).click();
  await page.waitForFunction(y=>Math.abs(scrollY-y)<8,readerY);
  await settle(page);
  const allow=page.getByRole('button',{name:'允許此文件載入遠端圖片'});
  await allow.click();
  await page.waitForTimeout(100);
  await page.evaluate(y=>window.scrollTo({top:y,behavior:'instant'}),readerY);
  await settle(page);
  // Remote-image consent changes placeholder height, so compare the reading
  // point within its section rather than the old document's absolute pixels.
  const readerOffset=await page.getByRole('heading',{name:'第二節',exact:true}).evaluate(heading=>-heading.getBoundingClientRect().top);
  pass('Each document keeps its own reading position while switching documents');

  await page.locator('#offline-status[data-state=ready]').waitFor();
  await context.close(); context=undefined; unavailable=true;
  context=await setup(await chromium.launchPersistentContext(profile,{...options,viewport:{width:1440,height:900}}));
  await context.setOffline(true);
  page=await context.newPage(); await page.goto(url+'?resume=1');
  await page.locator('#document h1').filter({hasText:'我的長文件'}).waitFor();
  await page.waitForFunction(offset=>{
    const heading=[...document.querySelectorAll('#document h2')].find(el=>el.textContent==='第二節');
    return heading && Math.abs(heading.getBoundingClientRect().top+offset)<8;
  },readerOffset);
  const restoredReaderY=await page.evaluate(()=>scrollY);
  await saved(page);
  assert.equal(await page.locator('#user-files button').count(),3);
  assert.equal(await page.locator('#document img[src^="blob:"]').evaluate(img=>img.complete && img.naturalWidth>0),true);
  await page.locator('.mermaid-container svg').waitFor(); await page.locator('.katex').waitFor();
  assert.equal(await page.getByRole('button',{name:'允許此文件載入遠端圖片'}).count(),1);
  await page.screenshot({path:path.join(output,'library-offline.png')});
  await paste(page,'筆記.md','# 第二份貼上筆記');
  assert.equal(await page.locator('#user-files button').filter({hasText:'筆記.md'}).count(),2);
  pass('Closing the browser then reopening offline restores files, images, graphics, formulas and progress without remote-image consent');

  await page.locator('#user-files button').filter({hasText:'reader.md'}).click();
  await page.waitForFunction(y=>Math.abs(scrollY-y)<8,restoredReaderY);
  await page.evaluate(()=>{
    const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...args){if(mode==='readwrite')throw new DOMException('Simulated quota failure','QuotaExceededError');return original.call(this,stores,mode,...args);};
    const heading=[...document.querySelectorAll('#document h2')].find(el=>el.textContent==='第三節');
    window.scrollTo({top:heading.getBoundingClientRect().top+scrollY+130,behavior:'instant'});
    window.dispatchEvent(new Event('pagehide'));
  });
  const checkpointOffset=await page.getByRole('heading',{name:'第三節',exact:true}).evaluate(h=>-h.getBoundingClientRect().top);
  await page.close(); page=await context.newPage(); await page.goto(url);
  // A saving/error banner can wrap and move the article while native anchoring
  // keeps its text steady. Verify the reading location with the same 8px limit.
  await page.waitForFunction(offset=>{
    const h=[...document.querySelectorAll('#document h2')].find(h=>h.textContent==='第三節');
    return h && Math.abs(h.getBoundingClientRect().top+offset)<8;
  },checkpointOffset);
  await saved(page);
  pass('An immediate page close recovers the latest small checkpoint even when the periodic progress write fails');
  await context.close(); context=undefined;
  unavailable=false;
  browser=await chromium.launch(options);
  context=await setup(await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:900}}));
  page=await context.newPage(); await page.goto(url); await page.locator('#app:not([hidden])').waitFor();
  await open(page,'stable.md','# 先前保存的內容'); await saved(page);
  await page.evaluate(()=>{
    window.__originalTransaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...args){if(mode==='readwrite')throw new DOMException('Simulated quota failure','QuotaExceededError');return window.__originalTransaction.call(this,stores,mode,...args);};
  });
  await open(page,'new.md','# 尚未保存的內容');
  await page.locator('#library-status[data-state=error]').waitFor();
  stored=await inspect(page); assert.equal(stored.documents.length,1);
  assert.equal(await page.locator('#document h1').textContent(),'尚未保存的內容');
  await page.evaluate(()=>{IDBDatabase.prototype.transaction=window.__originalTransaction;});
  await page.locator('#library-retry').click(); await saved(page);
  await page.reload(); await page.locator('#document h1').filter({hasText:'尚未保存的內容'}).waitFor();
  assert.equal(await page.locator('#user-files button').count(),2);
  pass('Failed document saves keep the previous committed library, show an error and retry without losing the open document');

  await page.locator('#file-input').setInputFiles(path.join(fixture,'assets/picture.svg')); await saved(page);
  assert.equal((await inspect(page)).assets.length,1);
  const other=await context.newPage(); await other.goto(url); await other.locator('#app:not([hidden])').waitFor();
  await page.evaluate(()=>{
    window.__originalTransaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...args){if(mode==='readwrite')throw new DOMException('Simulated clear failure','UnknownError');return window.__originalTransaction.call(this,stores,mode,...args);};
  });
  await page.locator('#clear-files').click(); await page.locator('#library-retry').filter({hasText:'重試清除'}).waitFor();
  assert.equal(await page.locator('#user-files button').count(),2);
  await page.evaluate(()=>{IDBDatabase.prototype.transaction=window.__originalTransaction;});
  await page.locator('#library-retry').click();
  await page.waitForFunction(()=>document.querySelectorAll('#user-files button').length===0);
  await other.waitForFunction(()=>document.querySelectorAll('#user-files button').length===0);
  await other.evaluate(()=>window.scrollTo({top:500,behavior:'instant'}));
  await other.reload(); await other.locator('#app:not([hidden])').waitFor();
  assert.equal(await other.locator('#user-files button').count(),0);
  stored=await inspect(other); assert.equal(stored.documents.length+stored.assets.length+stored.positions.length,0);
  await other.close();
  pass('Clear failures remain visible; retry deletes documents, images and progress across tabs without resurrection');

  await page.evaluate(async()=>{
    const r=indexedDB.open(`inkread-library:${new URL('./',location.href).href}`,1);
    const db=await new Promise(resolve=>{r.onsuccess=()=>resolve(r.result);});
    const tx=db.transaction(['documents','positions','meta'],'readwrite');
    tx.objectStore('documents').put({path:'../../escape.md',source:'# invalid',revision:'x'});
    tx.objectStore('documents').put({path:'範例/開始閱讀.md',source:'# overwritten demo',revision:'x'});
    tx.objectStore('documents').put({path:'oversize.md',source:'x'.repeat(2*1024*1024+1),revision:'x'});
    tx.objectStore('documents').put({path:'safe.md',source:'# 復原內容安全\n\n<script>window.__storedAttack=true</script>\n\n![遠端](https://example.com/track.svg)',revision:'safe',demo:true});
    tx.objectStore('positions').put({path:'safe.md',revision:'old',y:99999,ratio:1,anchor:'x',fraction:1,updatedAt:Date.now()});
    tx.objectStore('meta').put({path:'safe.md',updatedAt:Date.now()+60000},'current');
    await new Promise(resolve=>{tx.oncomplete=resolve;});db.close();
  });
  await page.reload(); await page.locator('#document h1').filter({hasText:'復原內容安全'}).waitFor();
  assert.equal(await page.locator('#user-files button').count(),1);
  assert.equal(await page.evaluate(()=>window.__storedAttack),undefined);
  assert.equal(await page.locator('#document img[src^="https:"]').count(),0);
  assert.equal(await page.evaluate(()=>scrollY),0);
  pass('Restored data obeys file and path limits, renders through sanitization and rejects stale progress revisions');
  await context.close(); context=undefined;

  context=await setup(await browser.newContext({serviceWorkers:'block'}));
  await context.setOffline(true);
  page=await context.newPage();
  const local=pathToFileURL(path.join(root,'dist/index.html')).href;
  await page.goto(local); await page.locator('#app:not([hidden])').waitFor();
  await open(page,'local.md','# 本機離線保留\n\n$$x^2+y^2=z^2$$'); await saved(page);
  await page.close(); page=await context.newPage(); await page.goto(local);
  await page.locator('#document h1').filter({hasText:'本機離線保留'}).waitFor();
  await page.locator('.katex').waitFor();
  pass('The extracted file:// version preserves its local documents when reopened offline in the same browser');
  await context.close(); context=undefined;

  context=await setup(await browser.newContext({serviceWorkers:'block'}));
  await context.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Storage denied','SecurityError');}}));
  page=await context.newPage(); await page.goto(url); await page.locator('#library-status[data-state=error]').waitFor();
  await open(page,'memory.md','# 儲存受限仍可閱讀');
  await page.locator('#document h1').filter({hasText:'儲存受限仍可閱讀'}).waitFor();
  assert.equal(await page.locator('#library-status').getAttribute('data-state'),'error');
  assert.deepEqual(errors,[]);
  pass('Denied browser storage keeps the reader usable and never falsely reports that documents were saved');
  await writeFile(path.join(output,'library-results.json'),JSON.stringify({passed:results.length,results,uncaughtErrors:errors},null,2));
  console.log(`\n${results.length} saved-library checks passed.`);
} catch(error) {
  const page=context?.pages().findLast(page=>page.url().startsWith(url));
  if (page) {
    await writeFile(path.join(output,'library-failure.json'),JSON.stringify({error:String(error),uncaughtErrors:errors,networkErrors,consoleErrors,state:await page.evaluate(()=>({offline:document.getElementById('offline-status')?.outerHTML,library:document.getElementById('library-status')?.outerHTML,scrollY}))},null,2));
    await page.screenshot({path:path.join(output,'library-failure.png')});
  }
  throw error;
} finally {
  await context?.close(); await browser?.close(); await server.close();
  for (const directory of [profile,fixture]) {
    if (!path.resolve(directory).startsWith(path.resolve(output)+path.sep)) throw new Error('Unsafe temporary path');
    await rm(directory,{recursive:true,force:true});
  }
}
