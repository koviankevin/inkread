import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

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
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
