import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {serveSites} from './site-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output = path.join(root,'test-results');
await mkdir(output,{recursive:true});
const site = await serveSites({current:path.join(root,'dist')});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true});
const results = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
const optional = url => /\/(?:math|diagrams|elk)\.(?:js|css)(?:\?|$)/.test(url);
async function session(local=false) {
  const context = await browser.newContext({serviceWorkers:"block",viewport:{width:1440,height:900}});
  context.setDefaultTimeout(20000);
  await context.route('**/*',route=>/^(file:|data:|blob:)/.test(route.request().url()) || route.request().url().startsWith(site.origin + '/') ? route.continue() : route.abort());
  if (local) await context.setOffline(true);
  const page = await context.newPage(), requests = [], errors = [];
  page.on('request',request=>requests.push(request.url()));
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(local?pathToFileURL(path.join(root,'dist','index.html')).href:`${site.origin}/current/`);
  await page.locator('#app:not([hidden])').waitFor();
  await page.getByRole('heading',{name:'好的文件，值得好好閱讀。',exact:true}).waitFor();
  return {context,page,requests,errors};
}
async function open(page,source) {
  await page.locator('#file-input').setInputFiles({name:'test.md',mimeType:'text/markdown',buffer:Buffer.from(source)});
}
const graph = '```mermaid\nflowchart LR\n A[開始] --> B[完成]\n```';
try {
  {
    const {context,page,requests,errors} = await session();
    await page.waitForTimeout(250);
    assert.deepEqual(requests.filter(optional),[]);
    assert.equal(await page.locator('.katex').count(),0);
    pass('Initial reading does not request math, diagrams, or ELK');
    await page.locator('.mermaid-container').first().scrollIntoViewIfNeeded();
    await page.locator('.mermaid-container svg').first().waitFor();
    assert.equal(requests.filter(url=>url.endsWith('/diagrams.js')).length,1);
    assert.equal(requests.filter(url=>url.endsWith('/elk.js')).length,1);
    await page.locator('[data-math-index], .katex').first().scrollIntoViewIfNeeded();
    await page.locator('.katex').first().waitFor();
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(requests.filter(url=>url.endsWith('/math.js')).length,1);
    assert.equal(requests.filter(url=>url.endsWith('/math.css')).length,1);
    await context.setOffline(true);
    await open(page,`# 已載入功能斷網\n\n公式 $a^2+b^2=c^2$\n\n${graph}`);
    await page.locator('.katex').first().waitFor();
    await page.locator('.mermaid-container svg').waitFor();
    assert.deepEqual(errors,[]);
    pass('Visible features load once; loaded features still work offline');
    await context.close();
  }
  {
    const {context,page,requests,errors} = await session();
    await open(page,'# 只有公式\n\n$$\\frac{1}{2} + \\sqrt{x}$$');
    await page.locator('.katex').waitFor();
    assert.equal(requests.some(url=>url.endsWith('/diagrams.js') || url.endsWith('/elk.js')),false);
    assert.deepEqual(errors,[]);
    pass('Formula-only documents do not load diagram engines');
    await context.close();
  }
  {
    const {context,page,requests,errors} = await session(true);
    assert.deepEqual(requests.filter(optional),[]);
    await open(page,`# 圖表離線首次使用\n\n${graph}`);
    await page.locator('.mermaid-container svg').waitFor({timeout:30000});
    // The app strips document configuration. Exercise the retained ELK integration
    // through Mermaid's trusted configuration API instead of the obsolete alias.
    const elkSVG = await page.evaluate(async()=>{
      const mermaid = globalThis[Symbol.for('inkread.vendors')].values.get('diagrams');
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',htmlLabels:false,layout:'elk',flowchart:{htmlLabels:false}});
      return (await mermaid.render('offline-elk-check','flowchart LR\n A[開始] --> B[完成]')).svg;
    });
    assert.equal(requests.some(url=>url.endsWith('/elk.js')),true);
    assert.equal(elkSVG.includes('完成'),true);
    await open(page,`# 離線公式與圖表\n\n$\\int_0^1 x^2 dx = \\frac{1}{3}$\n\n${graph}`);
    await page.locator('.katex').waitFor();
    await page.locator('.mermaid-container svg').waitFor();
    await page.evaluate(()=>document.fonts.ready);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'lazy-offline.png')});
    pass('Cold file:// offline use loads ELK, diagrams, formulas and local fonts');
    await context.close();
  }
  {
    const {context,page,errors} = await session();
    let notify;
    const requested = new Promise(resolve=>{notify=resolve;});
    await context.route('**/diagrams.js',async route=>{
      notify(); await new Promise(resolve=>setTimeout(resolve,500)); await route.continue();
    });
    await open(page,`# 舊圖表\n\n${graph}`);
    await requested;
    await open(page,'# 最新文字\n\n切換後保留這份文件。');
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#document h1').textContent(),'最新文字');
    assert.equal(await page.locator('#document svg').count(),0);
    assert.deepEqual(errors,[]);
    pass('A delayed engine cannot overwrite a newer document');
    await context.close();
  }
  {
    const {context,page,requests,errors} = await session();
    const source = '# 完整列印\n\n' + '足夠長的閱讀段落。\n\n'.repeat(100) + `$$x^2+y^2=z^2$$\n\n${graph}`;
    await open(page,source);
    await page.waitForTimeout(100);
    assert.deepEqual(requests.filter(optional),[]);
    await page.evaluate(()=>{window.print=()=>{window.__printed={diagrams:document.querySelectorAll('#document .mermaid-container svg').length,formulas:document.querySelectorAll('#document .katex').length};};});
    await page.locator('#print-button').click();
    await page.waitForFunction(()=>window.__printed);
    assert.deepEqual(await page.evaluate(()=>window.__printed),{diagrams:1,formulas:1});
    assert.deepEqual(errors,[]);
    pass('Print waits for features that were initially offscreen');
    await context.close();
  }
  {
    const {context,page,errors} = await session();
    await context.route('**/math.js',route=>route.abort());
    await open(page,'# 缺少公式程式\n\n$\\frac{1}{2}$');
    await page.waitForFunction(()=>!document.querySelector('[data-math-index]'));
    assert.equal((await page.locator('#document').textContent()).includes('\\frac{1}{2}'),true);
    assert.deepEqual(errors,[]);
    pass('Missing feature files preserve readable source without script errors');
    await context.close();
  }
  await writeFile(path.join(output,'lazy-results.json'),JSON.stringify({passed:results.length,results},null,2));
  console.log(`\n${results.length} lazy-loading checks passed.`);
} finally { await browser.close(); await site.close(); }
