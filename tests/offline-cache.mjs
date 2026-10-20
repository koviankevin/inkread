import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveSites} from './site-server.mjs';
import {writeOfflineWorker} from '../scripts/offline-worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output = path.join(root,'test-results');
await mkdir(output,{recursive:true});
const profile = await mkdtemp(path.join(output,'offline-profile-'));
const next = await mkdtemp(path.join(output,'offline-next-'));
await cp(path.join(root,'dist'),next,{recursive:true});
await writeFile(path.join(next,'index.html'),(await readFile(path.join(next,'index.html'),'utf8')).replace('<body>','<body data-offline-revision="next">'));
await writeFile(path.join(next,'math.js'),(await readFile(path.join(next,'math.js'),'utf8'))+'\nglobalThis.__offlineMathRevision="next";\n');
await writeOfflineWorker(next);
const sites = {current:path.join(root,'dist')};
let unavailable=false, brokenMath=false, holdMath=true, releaseMath, onMath;
const mathRequested = new Promise(resolve=>{onMath=resolve;});
const mathGate = new Promise(resolve=>{releaseMath=resolve;});
const server = await serveSites(sites,{intercept:async pathname=>{
  if (unavailable) return {status:503};
  if (pathname === '/outside/') return {body:'<!doctype html><title>Update observer</title>',headers:{'Content-Type':'text/html'}};
  if (pathname.endsWith('/math.js')) {
    if (brokenMath) return {body:'/* corrupted deployment */',headers:{'Content-Type':'text/javascript'}};
    if (holdMath) { onMath(); await mathGate; }
  }
}});
const url = `${server.origin}/current/`;
const options = {executablePath:process.env.CHROMIUM_PATH || undefined,headless:true};
let context,browser;
const results=[],errors=[];
const pass=name=>{results.push(name);console.log(`PASS ${name}`);};
async function setup(ctx) {
  ctx.setDefaultTimeout(30000);
  await ctx.route('**/*',route=>route.request().url().startsWith(server.origin + '/') || /^(data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  return ctx;
}
async function ready(page) { await page.locator('#offline-status[data-state=ready]').waitFor(); }
async function open(page,source) {
  await page.locator('#file-input').setInputFiles({name:'private-test.md',mimeType:'text/markdown',buffer:Buffer.from(source)});
}
const source='# 離線完整功能\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n```mermaid\nflowchart LR\n A[開始] --> B[完成]\n```';
async function features(page) {
  await open(page,source);
  await page.locator('#document .katex').waitFor();
  await page.locator('.mermaid-container svg').waitFor();
  assert.equal((await page.locator('.mermaid-container svg').textContent()).includes('完成'),true);
  assert.equal(await page.evaluate(async()=>{
    await document.fonts.ready;
    const used=[...document.fonts].filter(font=>font.family.startsWith('KaTeX') && font.status!=='unloaded');
    return used.length>0 && used.every(font=>font.status==='loaded');
  }),true);
}
const ownCaches = page=>page.evaluate(async()=>{
  const scope=new URL('./',location.href).href;
  return (await caches.keys()).filter(key=>key.startsWith(`inkread:${scope}:`));
});
try {
  context=await setup(await chromium.launchPersistentContext(profile,options));
  let page=await context.newPage();
  await page.goto(url);
  await page.locator('#app:not([hidden])').waitFor();
  await Promise.race([mathRequested,page.locator('#offline-status[data-state=error]').waitFor().then(()=>{throw new Error('Offline registration failed before precaching');})]);
  assert.equal(await page.locator('#offline-status').getAttribute('data-state'),'preparing');
  assert.equal(await page.locator('.katex,.mermaid-container svg').count(),0);
  assert.deepEqual(await page.evaluate(()=>[...globalThis[Symbol.for('inkread.vendors')].values.keys()]),['sanitize']);
  holdMath=false; releaseMath();
  await ready(page);
  const cachedPaths=await page.evaluate(async()=>{
    const names=await caches.keys();
    const cache=await caches.open(names.find(name=>name.startsWith('inkread:')));
    return (await cache.keys()).map(request=>decodeURIComponent(new URL(request.url).pathname));
  });
  for (const name of ['index.html','app.js','math.js','diagrams.js','elk.js','app.css','math.css','LICENSE','THIRD-PARTY-NOTICES.txt','samples/開始閱讀.md']) assert(cachedPaths.includes('/current/'+name),name);
  const fontCount=cachedPaths.filter(name=>name.startsWith('/current/fonts/')).length;
  assert(fontCount>0);
  assert.equal(cachedPaths.some(name=>name.includes('private-test')),false);
  pass('First visit downloads the complete static app before declaring offline readiness; engines stay unexecuted');
  await context.close(); context=undefined;

  // Restart Chromium with the same on-disk profile; origin now cannot serve any file.
  unavailable=true;
  context=await setup(await chromium.launchPersistentContext(profile,options));
  await context.setOffline(true);
  page=await context.newPage();
  await page.goto(url+'?offline-restart=1');
  await ready(page);
  await features(page);
  await page.screenshot({path:path.join(output,'online-offline.png')});
  pass('Browser restart plus offline navigation supports first use of diagrams, ELK, formulas and local fonts');
  const unknown=await context.newPage();
  await assert.rejects(unknown.goto(url+'not-an-app-file'));
  await unknown.close();
  assert.equal(await page.evaluate(async()=>{
    const names=await caches.keys();
    const requests=(await Promise.all(names.map(async name=>(await caches.open(name)).keys()))).flat();
    return requests.every(request=>request.method==='GET' && request.url.startsWith(location.origin+'/current/')) && !requests.some(request=>request.url.includes('private-test'));
  }),true);
  pass('Only allowlisted app resources enter the worker cache; documents use separate browser storage');
  await context.close(); context=undefined;

  unavailable=false; brokenMath=true;
  browser=await chromium.launch(options);
  context=await setup(await browser.newContext());
  page=await context.newPage();
  await page.goto(url);
  await page.locator('#offline-status[data-state=error]').waitFor();
  assert.equal(await page.locator('#offline-retry').isVisible(),true);
  assert.deepEqual(await ownCaches(page),[]);
  brokenMath=false;
  await page.locator('#offline-retry').click();
  await ready(page);
  assert.equal((await ownCaches(page)).length,1);
  pass('A corrupt first download fails integrity, leaves no partial offline cache and can be retried');

  const originalCache=(await ownCaches(page))[0];
  await page.evaluate(async()=>{await caches.open('unrelated-app-cache');});
  sites.current=next; brokenMath=true;
  await page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.getRegistration();
    window.__updateFailed=false;
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker.addEventListener('statechange',()=>{if(worker.state==='redundant')window.__updateFailed=true;});
    },{once:true});
    await registration.update();
  });
  await page.waitForFunction(()=>window.__updateFailed);
  await ready(page);
  assert.deepEqual(await ownCaches(page),[originalCache]);
  assert.equal(await page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting),false);
  pass('Failed updates preserve the complete active version instead of replacing it with mixed files');

  brokenMath=false;
  await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});
  await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
  await page.locator('#offline-status').filter({hasText:'更新已備妥'}).waitFor();
  assert.equal((await ownCaches(page)).length,2);
  await context.setOffline(true);
  await features(page);
  assert.equal(await page.evaluate(()=>window.__offlineMathRevision),undefined);
  assert.equal(await page.locator('body').getAttribute('data-offline-revision'),null);
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('body').getAttribute('data-offline-revision'),null);
  pass('A ready update waits while open tabs keep a consistent cached app and lazy engines');

  await context.setOffline(false);
  const observer=await context.newPage();
  await observer.goto(server.origin+'/outside/');
  await page.close();
  await observer.waitForFunction(async()=>{
    const registration=await navigator.serviceWorker.getRegistration('/current/');
    return registration?.active?.state==='activated' && !registration.waiting;
  });
  unavailable=true;
  await context.setOffline(true);
  page=await context.newPage();
  await page.goto(url+'index.html?updated=1');
  await ready(page);
  assert.equal(await page.locator('body').getAttribute('data-offline-revision'),'next');
  await features(page);
  assert.equal(await page.evaluate(()=>window.__offlineMathRevision),'next');
  const updatedCaches=await ownCaches(page);
  assert.equal(updatedCaches.length,1);
  assert.notEqual(updatedCaches[0],originalCache);
  assert.equal(await page.evaluate(async()=>(await caches.keys()).includes('unrelated-app-cache')),true);
  assert.deepEqual(errors,[]);
  pass('Closing old tabs activates the new complete version offline and cleans only its own old cache');

  await writeFile(path.join(output,'offline-results.json'),JSON.stringify({passed:results.length,results,cachedFontFiles:fontCount,uncaughtErrors:errors},null,2));
  console.log(`\n${results.length} complete-offline checks passed.`);
} finally {
  releaseMath();
  await context?.close(); await browser?.close(); await server.close();
  for (const directory of [profile,next]) {
    if (!path.resolve(directory).startsWith(path.resolve(output)+path.sep)) throw new Error('Unsafe temporary path');
    await rm(directory,{recursive:true,force:true});
  }
}
