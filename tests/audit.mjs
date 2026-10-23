import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baseline = process.argv.includes('--baseline');
const output = path.join(root,'test-results');
await mkdir(output,{recursive:true});
const server = createServer(async (request,response) => {
  try {
    const name = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const file = path.resolve(root,'dist',`.${name === '/' ? '/index.html' : name}`);
    const relative = path.relative(path.join(root,'dist'),file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      response.writeHead(403).end(); return;
    }
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
    response.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream'});
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
const report = {baseline,checks:[],performance:{}};
try {
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true});
  const context = await browser.newContext({serviceWorkers:"block",viewport:{width:1440,height:1050}});
  context.setDefaultTimeout(15000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  await context.route('**/*',route => route.request().url().startsWith(origin + '/') || /^(blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  page.on('request',request => {
    if (new URL(request.url()).hostname === 'example.com') requests.push(request.url());
  });
  await page.goto(origin);
  await page.locator('#app:not([hidden])').waitFor();
  console.log('Audit: application ready');
  async function paste(source,name='稽核.md') {
    await page.locator('#paste-button').click();
    await page.locator('#paste-dialog').waitFor({state:'visible'});
    await page.locator('#paste-name').fill(name);
    await page.locator('#paste-content').fill(source);
    await page.locator('#paste-submit').click();
  }
  // Reimporting a changed file must require a new remote-image decision.
  const file = source => ({name:'same.md',mimeType:'text/markdown',buffer:Buffer.from(source)});
  await page.locator('#file-input').setInputFiles(file('# 原始文件\n\n![old](https://example.com/old.png)'));
  await page.getByRole('button',{name:'允許此文件載入遠端圖片',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.image-placeholder'));
  await page.locator('#file-input').setInputFiles(file('# 更新文件\n\n![new](https://example.com/new.png)'));
  await page.getByRole('heading',{name:'更新文件',exact:true}).waitFor();
  await page.waitForTimeout(100);
  report.reimportResetConsent = !requests.some(url => url.endsWith('/new.png'));
  if (!baseline) assert.equal(report.reimportResetConsent,true,'Changed files must not reuse remote-image consent');
  report.checks.push('Remote-image consent on same-path reimport');
  console.log(`Audit: image-consent reset = ${report.reimportResetConsent}`);

  await paste('# 惡意內容\n\n<script>window.__auditAttack=1</script>\n\n[危險](javascript:window.__auditAttack=1)\n\n$\\href{javascript:alert(1)}{click}$\n\n```mermaid\nflowchart LR\n A[開始] --> B[完成]\n click A "https://example.com/graph"\n```');
  await page.locator('.mermaid-container svg').waitFor();
  assert.equal(await page.evaluate(() => window.__auditAttack),undefined);
  assert.equal(await page.locator('#document script,#document a[href^="javascript:"],.mermaid-container a,.mermaid-container image').count(),0);
  assert.equal(requests.some(url => url.includes('/graph')),false);
  report.checks.push('Inert raw HTML, dangerous URLs, math and Mermaid interactions');
  console.log('Audit: malicious content remained inert');
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__auditInline = true';
    document.body.append(script);
  });
  report.inlineScriptBlocked = await page.evaluate(() => window.__auditInline !== true);
  if (!baseline) assert.equal(report.inlineScriptBlocked,true);
  report.checks.push('Content Security Policy blocks injected inline scripts');
  console.log(`Consent reset: ${report.reimportResetConsent}; inline scripts blocked: ${report.inlineScriptBlocked}`);

  const longDocument = '# 長文件\n\n' + Array.from({length:1000},(_,index) => `## 第 ${index+1} 節\n\n測試文件的段落內容。測試閱讀進度與章節跳轉。\n\n`).join('');
  const renderStart = performance.now();
  await page.locator('#file-input').setInputFiles(file(longDocument));
  await page.locator('#document h2').nth(999).waitFor({state:'attached'});
  report.performance.renderMs = Math.round(performance.now()-renderStart);
  await page.waitForTimeout(100);
  report.performance.scroll = await page.evaluate(async () => {
    let headingReads = 0, blockReads = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function(...args) {
      if (/^H[1-6]$/.test(this.tagName)) headingReads++;
      if (/^(P|LI|PRE|TABLE|H[1-6])$/.test(this.tagName)) blockReads++;
      return original.apply(this,args);
    };
    const samples = [];
    try {
      for (let index=1;index<=30;index++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        window.scrollTo({top:index*400,behavior:'instant'});
        const start = performance.now();
        window.dispatchEvent(new Event('scroll'));
        samples.push(performance.now()-start);
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      samples.sort((a,b)=>a-b);
      return {headingLayoutReads:headingReads,blockLayoutReads:blockReads,medianHandlerMs:samples[15],maxHandlerMs:samples[29]};
    } finally { Element.prototype.getBoundingClientRect = original; }
  });
  if (!baseline) assert.ok(report.performance.scroll.headingLayoutReads < 2000,'Steady scrolling must not measure all headings on every event');
  if (!baseline) assert.equal(report.performance.scroll.blockLayoutReads,0,'Stable scrolling must use cached block geometry');
  await page.locator('#toc-links a').nth(499).evaluate(element => element.click());
  await page.waitForFunction(() => document.querySelectorAll('#toc-links a')[499]?.getAttribute('aria-current') === 'location',undefined,{timeout:10000});
  report.checks.push('1,000-heading document and chapter navigation');
  if (!baseline) {
    const before = await page.locator('#current-file').textContent();
    await page.locator('#file-input').setInputFiles(file('x'.repeat(2*1024*1024+1)));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#current-file').textContent(),before);
    await paste('x'.repeat(2*1024*1024+1),'過大.md');
    assert.equal(await page.locator('#paste-dialog').evaluate(element=>element.open),true);
    await page.locator('#paste-dialog button[data-close]').count().then(async count=> {
      if (count) await page.locator('#paste-dialog button[data-close]').click();
      else await page.keyboard.press('Escape');
    });
    report.checks.push('Oversized file and pasted content are rejected before rendering');
    const diagrams = '# 多張圖表\n\n' + '```mermaid\nflowchart LR\n A --> B\n```\n\n'.repeat(21);
    await page.locator('#file-input').setInputFiles(file(diagrams));
    await page.locator('#document .render-error').waitFor();
    assert.equal(await page.locator('#document [data-diagram-index]').count(),20);
    report.checks.push('Document diagram limit leaves readable source');
    await page.locator('#library-status[data-state=saved]').waitFor();
    // Exercise asynchronous storage completion even on fast local disks.
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{
        ...descriptor,
        set(handler) {
          descriptor.set.call(this,handler && function(event) {
            setTimeout(()=>handler.call(this,event),250);
          });
        },
      });
    });
    await page.locator('#clear-files').click();
    await page.waitForFunction(()=>document.querySelectorAll('#user-files button').length === 0);
    await page.locator('#library-status[data-state=saved]').waitFor();
    await page.locator('#file-input').setInputFiles(Array.from({length:201},(_,index)=>({name:`document-${index}.md`,mimeType:'text/markdown',buffer:Buffer.from('# 有界匯入')})));
    await page.waitForFunction(()=>document.querySelectorAll('#user-files button').length === 200);
    report.checks.push('Bulk import after asynchronous clear stops at 200 documents');
  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,baseline?'audit-baseline.json':'audit-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
