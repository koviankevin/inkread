import {chromium,firefox,webkit} from 'playwright-core';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// The original npm test remains Chromium-only. No additional test framework.
export const browserName=process.env.INKREAD_BROWSER || 'chromium';
assert(['chromium','firefox','webkit'].includes(browserName),'Unknown INKREAD_BROWSER');
export const browserType={chromium,firefox,webkit}[browserName];
export const compatibility=browserName!=='chromium';

// WebKit ephemeral sessions cannot persist image Blobs (Playwright #42795).
// Use an empty real profile, not mocked storage; every write/restore must succeed.
export async function libraryContext(browser,profile,launchOptions,contextOptions) {
  return browserName==='webkit'
    ? browserType.launchPersistentContext(profile,{...launchOptions,...contextOptions})
    : browser.newContext(contextOptions);
}

export async function checkExamples(page,output,archive) {
  await page.setViewportSize({width:1440,height:900});
  const section=page.locator('#demo-section'),search=page.locator('#file-search');
  const names=await page.locator('#user-files button').allTextContents();
  assert(names.length>0);
  assert.equal(await section.evaluate(el=>el.open),false);
  await search.fill('開始閱讀');
  await page.locator('#demo-files button').first().waitFor();
  assert.equal(await section.evaluate(el=>el.open && !el.hidden),true);
  assert.equal(await page.locator('#empty-files').isVisible(),false);
  await search.fill('');
  assert.equal(await section.evaluate(el=>el.open),false);
  await section.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await section.evaluate(el=>el.open),true);
  await search.fill('不存在的文件-no-match');
  assert.equal(await section.isHidden(),true);
  await search.fill('');
  assert.equal(await section.evaluate(el=>el.open && !el.hidden),true);
  await page.locator('#user-files button').first().click();
  assert.equal(await section.evaluate(el=>el.open),true);
  // Selecting a document closes the mobile drawer. Reopen it through the UI.
  for (const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    if (!await page.locator('#sidebar').isVisible()) await page.locator('#sidebar-toggle').click();
    await search.fill('開始閱讀');
    assert.equal(await section.evaluate(el=>el.open && !el.hidden),true);
    await search.fill('');
    assert.deepEqual(await page.locator('#user-files button').allTextContents(),names);
    for(const id of ['backup-library','restore-library']) {
      const control=await page.locator(`#${id}`).boundingBox();
      assert(control && control.x>=0 && control.x+control.width<=width,'Transfer controls must fit the viewport');
    }
    await page.locator('#restore-library').scrollIntoViewIfNeeded();
    const chooser=page.waitForEvent('filechooser');
    await page.locator('#restore-library').click(); await (await chooser).setFiles(archive);
    await page.locator('#restore-dialog').waitFor({state:'visible'});
    await page.locator('#restore-mode').selectOption('replace');
    assert.equal(await page.locator('#restore-confirm').isEnabled(),true);
    const box=await page.locator('#restore-dialog').boundingBox();
    assert(box && box.x>=0 && box.x+box.width<=width+1,'Restore dialog must fit the viewport');
    await page.screenshot({path:path.join(output,`compat-restore-${width}.png`)});
    await page.locator('#restore-cancel').click();
    await page.locator('#library-status[data-state=saved]').waitFor();
    assert.deepEqual(await page.locator('#user-files button').allTextContents(),names);
  }
}

// A diagnostic of the browser's local-file origin, separate from HTTP acceptance.
// Missing platform APIs are reported as limitations, never counted as restore passes.
export async function probeFileOrigin(browser,filename,output,profile) {
  const ctx=await libraryContext(browser,profile,{headless:true},{serviceWorkers:'block'}),page=await ctx.newPage();
  const messages=[]; page.on('pageerror',e=>messages.push(e.message));
  try {
    await page.goto(pathToFileURL(filename).href);
    const capabilities=await page.evaluate(async()=>{
      const result={secureContext:isSecureContext,crypto:!!globalThis.crypto?.subtle,indexedDB:false,storageError:null};
      let db;
      try {
        db=await new Promise((resolve,reject)=>{
          const r=indexedDB.open('inkread-file-capability-probe',1);
          r.onupgradeneeded=()=>r.result.createObjectStore('probe');
          r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
        });
        await new Promise((resolve,reject)=>{
          const tx=db.transaction('probe','readwrite');tx.objectStore('probe').put(new Blob(['probe']),'value');
          tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
        });
        const blob=await new Promise((resolve,reject)=>{
          const r=db.transaction('probe').objectStore('probe').get('value');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
        });
        result.indexedDB=await blob.text()==='probe';
      } catch(e) {result.storageError=`${e.name}: ${e.message}`;}
      finally {db?.close();try{indexedDB.deleteDatabase('inkread-file-capability-probe');}catch{}}
      return result;
    });
    if (capabilities.crypto && capabilities.indexedDB) await page.locator('#app:not([hidden])').waitFor();
    const report={browser:browserName,capabilities,messages,transferTest:'not run: file:// transfer remains in the Chromium suite',classification:capabilities.crypto && capabilities.indexedDB ? 'APIs available; full file:// transfer not verified' : 'local-file platform API restriction; not an HTTP restore failure'};
    await writeFile(path.join(output,'file-origin-capabilities.json'),JSON.stringify(report,null,2));
    console.log(`INFO file:// ${JSON.stringify(report)}`);
  } finally {await ctx.close();}
}
