import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export async function writeOfflineWorker(out) {
  const assets = [];
  async function collect(directory) {
    for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const filename = path.join(directory,entry.name);
      const info = await stat(filename);
      if (info.isDirectory()) await collect(filename);
      else if (info.isFile() && entry.name !== 'sw.js' && !entry.name.endsWith('.zip')) {
        assets.push({path:path.relative(out,filename).split(path.sep).join('/'),integrity:'sha256-' + createHash('sha256').update(await readFile(filename)).digest('base64')});
      }
    }
  }
  await collect(out);
  for (const required of ['index.html','app.js','app.css','math.js','math.css','diagrams.js','elk.js','LICENSE','THIRD-PARTY-NOTICES.txt']) {
    if (!assets.some(asset=>asset.path === required)) throw new Error(`Missing offline asset: ${required}`);
  }
  if (!assets.some(asset=>asset.path.startsWith('fonts/') && asset.path.endsWith('.woff2'))) throw new Error('Missing offline fonts');
  const template = await readFile(new URL('../src/service-worker.js',import.meta.url),'utf8');
  const version = createHash('sha256').update(template).update(JSON.stringify(assets)).digest('hex').slice(0,24);
  await writeFile(path.join(out,'sw.js'),template.replace('__CACHE_NAME__',JSON.stringify(version)).replace('__PRECACHE_ASSETS__',JSON.stringify(assets)));
}
