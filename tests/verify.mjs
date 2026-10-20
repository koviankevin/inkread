import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {normalizePath, resolvePath, imageKind} from '../src/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output = path.join(root,'test-results');
await mkdir(output,{recursive:true});
const results = [];
// Optional accounting for a known host injected by local endpoint software.
// These requests remain blocked by the route; the default permits no exceptions.
const injectedHosts = new Set((process.env.INKREAD_TEST_INJECTED_HOSTS || '').split(',').filter(Boolean));
const blockedInjectedRequests = [];
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
assert.equal(normalizePath('a/b/../c.md'),'a/c.md');
assert.equal(normalizePath('../../outside'),null);
assert.equal(resolvePath('docs/筆記.md','./assets/test%20image.png'),'docs/assets/test image.png');
assert.equal(resolvePath('docs/file.md','https://example.com/test'),null);
assert.equal(imageKind('javascript:alert(1)'),'blocked');
pass('Safe relative paths and image classification');

const server = createServer(async (req,res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/internal\/inkread\//,'');
    const filename = path.resolve(root,'dist',relative || 'index.html');
    const withinDist = path.relative(path.join(root,'dist'),filename);
    if (withinDist === '..' || withinDist.startsWith(`..${path.sep}`) || path.isAbsolute(withinDist)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(filename);
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[path.extname(filename)] || 'application/octet-stream'});
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  console.log('Launching test browser...');
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,timeout:30000,args:['--no-sandbox','--disable-dev-shm-usage']});
  console.log('Test browser ready.');
  const context = await browser.newContext({viewport:{width:1440,height:1050}});
  await context.route('**/*', route => route.request().url().startsWith(base) || /^(blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  const remoteRequests = [];
  page.on('pageerror',e => errors.push(e.message));
  function recordRequest(request) {
    const url = request.url();
    if (!/^https?:/.test(url) || url.startsWith(base)) return;
    if (injectedHosts.has(new URL(url).hostname)) {
      blockedInjectedRequests.push(url);
    } else remoteRequests.push(url);
  }
  page.on('request',recordRequest);
  await page.goto(`${base}/internal/inkread/`);
  await page.locator('#app:not([hidden])').waitFor();
  await page.locator('.mermaid-container').first().scrollIntoViewIfNeeded();
  await page.locator('.mermaid-container svg').first().waitFor({timeout:30000});
  await page.locator('[data-math-index], .katex').first().scrollIntoViewIfNeeded();
  await page.locator('.katex').first().waitFor();
  assert.equal(await page.locator('.katex').count() > 0,true);
  assert.equal(await page.locator('.mermaid-container svg .node').count() > 0,true);
  assert.equal(await page.locator('.mermaid-container svg text').count() > 0,true);
  assert.equal((await page.locator('.mermaid-container svg').first().textContent()).includes('開啟文件'),true);
  await writeFile(path.join(output,'diagram.svg'),await page.locator('.mermaid-container').first().innerHTML());
  assert.notEqual(await page.locator('.mermaid-container svg .node rect').first().evaluate(el => getComputedStyle(el).fill),'rgb(0, 0, 0)');
  await page.locator('.mermaid-container').first().screenshot({path:path.join(output,'diagram.png')});
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  assert.equal(await page.locator('#document h1').textContent(),'好的文件，值得好好閱讀。');
  assert.equal(await page.locator('#toc-links a').count() > 3,true);
  assert.equal(remoteRequests.length,0,remoteRequests.join('\n'));
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:false});
  pass('HTTP subdirectory works with no external access; Mermaid labels, formulas and TOC');

  await page.locator('#demo-files button').filter({hasText:'表格筆記.md'}).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.wide-table').count(),1);
  assert.equal(await page.locator('.table-scroll').evaluateAll(els => els.some(el => el.scrollWidth > el.clientWidth)),true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  const originalFont = await page.locator('#font-size').textContent();
  await page.locator('#font-plus').click();
  assert.equal(Number(await page.locator('#font-size').textContent()),Number(originalFont) + 1);
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.waitForTimeout(200);
  await page.screenshot({path:path.join(output,'dark.png'),fullPage:false});
  await page.reload();
  await page.locator('#app:not([hidden])').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(Number(await page.locator('#font-size').textContent()),Number(originalFont) + 1);
  await page.locator('#theme-toggle').click();
  await page.locator('#font-minus').click();
  pass('Wide tables, no page overflow, font controls and theme persistence');

  await page.locator('#folder-input').setInputFiles(path.join(root,'samples'));
  await page.locator('#user-files button').filter({hasText:'圖表與公式.md'}).click();
  await page.locator('#document img').waitFor();
  assert.equal(await page.locator('#document img').evaluate(img => img.complete && img.naturalWidth > 0),true);
  await page.locator('.mermaid-container svg').nth(1).waitFor({timeout:30000});
  await page.locator('#document a').filter({hasText:'回到閱讀指南'}).click();
  assert.equal(await page.locator('#current-file').textContent(),'開始閱讀.md');
  pass('Folder import resolves local SVG, multiple Markdown documents and relative links');
  await context.setOffline(true);

  await page.locator('#paste-button').click();
  await page.locator('#paste-name').fill('安全測試.md');
  await page.locator('#paste-content').fill('# 安全測試\n\n## 重複標題\n\n<script>window.__injected=1</script>\n\n[危險](javascript:alert(1))\n\n![外部](https://example.com/private.png)\n\n![遺失](./missing.png)\n\n## 重複標題\n\n```mermaid\nnot a valid diagram @@@\n```\n\n$$\\invalidcommand{x}$$\n\n```js\nconst value = 42;\n```');
  await page.locator('#paste-submit').click();
  await page.locator('.render-error').waitFor({timeout:30000});
  assert.equal(await page.evaluate(() => window.__injected),undefined);
  assert.equal(await page.locator('#document script').count(),0);
  assert.equal(await page.locator('#document a[href^="javascript:"]').count(),0);
  assert.equal(await page.locator('#document img[src^="https:"]').count(),0);
  assert.equal(await page.locator('.image-placeholder').count(),2);
  assert.equal(await page.locator('#document h2').evaluateAll(els => new Set(els.map(e => e.id)).size),2);
  assert.equal(remoteRequests.length,0);
  assert.equal(await page.locator('.copy-code').count(),1);
  pass('Paste, duplicate headings, inert HTML, blocked remote images and readable parse failures');

  // Validate SVG sanitization with Mermaid nodes and attempted click directives.
  await page.locator('#paste-button').click();
  await page.locator('#paste-content').fill('# 圖表安全\n\n```mermaid\nflowchart LR\n A[開始] --> B[完成]\n click A "https://example.com/track"\n```');
  await page.locator('#paste-submit').click();
  await page.locator('.mermaid-container svg').waitFor({timeout:30000});
  assert.equal(await page.locator('.mermaid-container a,.mermaid-container image,.mermaid-container script').count(),0);
  pass('Mermaid strict rendering and SVG sanitization while offline');

  await page.locator('#demo-files button').filter({hasText:'表格筆記.md'}).click();
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#sidebar').isVisible(),false);
  assert.equal(await page.locator('.topbar').isVisible(),false);
  assert.equal(await page.locator('#document').isVisible(),true);
  assert.equal(await page.locator('.table-scroll').first().evaluate(el => getComputedStyle(el).overflow),'visible');
  await page.pdf({path:path.join(output,'table-print.pdf'),format:'A4',landscape:true,printBackground:true});
  await page.emulateMedia({media:'screen'});
  pass('Print layout hides controls and expands tables; landscape A4 PDF generated');

  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await page.screenshot({path:path.join(output,'mobile.png'),fullPage:false});
  await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('#sidebar').isVisible(),true);
  await page.locator('#demo-files button').filter({hasText:'圖表與公式.md'}).click();
  assert.equal(await page.locator('#sidebar').isVisible(),false);
  await page.locator('#toc-toggle').click();
  assert.equal(await page.locator('#toc').isVisible(),true);
  await page.locator('#toc-links a').first().click();
  assert.equal(await page.locator('#toc').isVisible(),false);
  pass('390px mobile: no overflow, functional sidebar and TOC');

  await page.setViewportSize({width:1440,height:1050});
  await page.locator('#clear-files').click();
  assert.equal(await page.locator('#user-files button').count(),0);
  await context.setOffline(false);
  await page.reload();
  await page.locator('#app:not([hidden])').waitFor();
  assert.equal(await page.locator('#user-files button').count(),0);
  assert.equal(errors.length,0,errors.join('\n'));
  pass('Clear imported files, no document persistence, no uncaught browser errors');
  const localContext = await browser.newContext({viewport:{width:1440,height:1050}});
  await localContext.route('**/*', route => /^(file:|blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  await localContext.setOffline(true);
  const localPage = await localContext.newPage();
  localPage.on('pageerror',e => errors.push(e.message));
  localPage.on('request',recordRequest);
  await localPage.goto(pathToFileURL(path.join(root,'dist','index.html')).href);
  await localPage.locator('#app:not([hidden])').waitFor();
  await localPage.locator('.mermaid-container').first().scrollIntoViewIfNeeded();
  await localPage.locator('.mermaid-container svg').first().waitFor({timeout:30000});
  await localPage.locator('[data-math-index], .katex').first().scrollIntoViewIfNeeded();
  await localPage.locator('.katex').first().waitFor();
  assert.equal((await localPage.locator('.mermaid-container svg').first().textContent()).includes('開啟文件'),true);
  assert.equal(await localPage.locator('.katex').count() > 0,true);
  assert.equal(await localPage.evaluate(async () => {
    await document.fonts.ready;
    const fonts = Array.from(document.fonts).filter(font => font.family.startsWith('KaTeX') && font.status !== 'unloaded');
    return fonts.length > 0 && fonts.every(font => font.status === 'loaded');
  }),true);
  await localPage.locator('#folder-input').setInputFiles(path.join(root,'samples'));
  await localPage.locator('#user-files button').filter({hasText:'圖表與公式.md'}).click();
  await localPage.locator('#document img').waitFor();
  assert.equal(await localPage.locator('#document img').evaluate(img => img.complete && img.naturalWidth > 0),true);
  await localPage.locator('.mermaid-container svg').nth(1).waitFor({timeout:30000});
  await localPage.screenshot({path:path.join(output,'local-file.png')});
  assert.equal(errors.length,0,errors.join('\n'));
  assert.equal(remoteRequests.length,0);
  await localContext.close();
  pass('Offline file:// opening, Mermaid labels, KaTeX fonts and imported local images');
  await writeFile(path.join(output,'results.json'),JSON.stringify({passed:results.length,results,uncaughtErrors:errors,remoteRequests,blockedInjectedRequests},null,2));
  console.log(`\n${results.length} checks passed.`);
} finally { await browser?.close(); server.close(); }
