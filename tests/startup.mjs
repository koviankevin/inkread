import {chromium} from 'playwright-core';
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveSites} from './site-server.mjs';
import {gzipSync} from 'node:zlib';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'test-results');
await mkdir(output,{recursive:true});
const sites={current:path.join(root,'dist')};
try { await stat(path.join(output,'startup-baseline','index.html')); sites.baseline=path.join(output,'startup-baseline'); } catch {}
const server=await serveSites(sites,{gzip:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true});
const samples=[];
try {
  for(let round=0;round<3;round++) for(const name of ['baseline','current'].filter(name=>sites[name])) {
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    await context.route('**/*',route=>route.request().url().startsWith(server.origin+'/') || /^(data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
    const page=await context.newPage();
    const client=await context.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions',{offline:false,latency:50,downloadThroughput:625000,uploadThroughput:1250000});
    await client.send('Emulation.setCPUThrottlingRate',{rate:4});
    await page.addInitScript(()=>{
      new MutationObserver((_,observer)=>{
        const app=document.getElementById('app');
        if(app && !app.hidden && document.querySelector('#document h1')) { window.__readingReady=performance.now(); observer.disconnect(); }
      }).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});
    });
    await page.goto(`${server.origin}/${name}/`,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>window.__readingReady);
    const readyMs=await page.evaluate(()=>window.__readingReady);
    const bytes=await readFile(path.join(sites[name],'app.js'));
    samples.push({name,round:round+1,readingReadyMs:Math.round(readyMs),initialJavaScriptBytes:bytes.length,initialJavaScriptGzipBytes:gzipSync(bytes).length});
    console.log(`${name} ${round+1}: ${Math.round(readyMs)} ms`);
    await context.close();
  }
  const medians=Object.fromEntries(Object.keys(sites).map(name=>{
    const values=samples.filter(sample=>sample.name===name).map(sample=>sample.readingReadyMs).sort((a,b)=>a-b);
    return [name,values[1]];
  }));
  const report={conditions:'3 cold contexts per build; gzip; 5 Mbps; 50 ms latency; CPU 4x slowdown; time until reader heading is visible in the DOM',medians,samples};
  await writeFile(path.join(output,'startup-results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); await server.close(); }
