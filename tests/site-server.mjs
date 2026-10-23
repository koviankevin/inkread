import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

// https://fetch.spec.whatwg.org/#port-blocking — keep browser protections intact
// when the OS happens to assign a restricted ephemeral port (observed: 2049).
const blockedPorts=new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

export async function serveSites(sites,{gzip=false,intercept}={}) {
  const compressed = new Map();
  const server = createServer(async (request,response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const override = await intercept?.(pathname,request);
      if (override) { response.writeHead(override.status || 200,override.headers || {}).end(override.body || ''); return; }
      const [,site,...parts] = pathname.split('/');
      const directory = sites[site];
      if (!directory) { response.writeHead(404).end(); return; }
      const file = path.resolve(directory,parts.join('/') || 'index.html');
      const relative = path.relative(directory,file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
      const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};
      const headers = {'Content-Type':types[path.extname(file)] || 'application/octet-stream'};
      let data = await readFile(file);
      if (gzip && /\.(js|css|html)$/.test(file)) {
        if (!compressed.has(file)) compressed.set(file,gzipSync(data));
        data = compressed.get(file);
        headers['Content-Encoding'] = 'gzip';
      }
      response.writeHead(200,headers); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  for(let attempt=0;;attempt++){
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
    });
    if(!blockedPorts.has(server.address().port))break;
    await new Promise(resolve=>server.close(resolve));
    if(attempt>=7)throw new Error('No browser-compatible ephemeral test port was assigned');
  }
  return {origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
