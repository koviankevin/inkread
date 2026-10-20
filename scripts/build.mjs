import {build} from 'esbuild';
import {mkdir, rm, copyFile, cp, readFile, writeFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out = path.join(root,'dist');
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
const result = await build({absWorkingDir:root, metafile:true, entryPoints:[path.join(root,'src/app.js')], outfile:path.join(out,'app.js'), bundle:true, format:'iife', platform:'browser', target:['chrome110','edge110'], minify:true, legalComments:'linked', loader:{'.md':'text','.svg':'text','.woff2':'file','.woff':'file','.ttf':'file'}, assetNames:'fonts/[name]-[hash]', logLevel:'info'});
await copyFile(path.join(root,'src/index.html'),path.join(out,'index.html'));
await copyFile(path.join(root,'src/favicon.svg'),path.join(out,'favicon.svg'));
await cp(path.join(root,'samples'),path.join(out,'samples'),{recursive:true});
await writeFile(path.join(out,'.nojekyll'),'');
// Keep upstream licenses available in the standalone, offline distribution.
let notices = '墨閱 Inkread — Third-party notices\n\n';
const modules = path.join(root,'node_modules');
const packageFolders = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const relative = path.relative(modules,path.resolve(root,input));
  if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
  const parts = relative.split(path.sep);
  const start = parts.lastIndexOf('node_modules') + 1;
  const end = start + (parts[start].startsWith('@') ? 2 : 1);
  packageFolders.add(path.join(modules,...parts.slice(0,end)));
}
for (const folder of [...packageFolders].sort()) {
  const pkg = JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));
  notices += `${pkg.name} ${pkg.version} (${pkg.license || 'See license below'})\n`;
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  notices += `Package and source references: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n${repository || ''}\n`;
  const files = await readdir(folder,{withFileTypes:true});
  const licenses = files.filter(file=>file.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file.name));
  if (!licenses.length) throw new Error(`Missing bundled license for ${pkg.name}`);
  for (const file of licenses) {
    notices += `${file.name}\n${await readFile(path.join(folder,file.name),'utf8')}\n\n`;
  }
}
await writeFile(path.join(out,'THIRD-PARTY-NOTICES.txt'),notices);
try { await copyFile(path.join(root,'README.md'),path.join(out,'使用說明.md')); } catch {}
await copyFile(path.join(root,'交接文件.md'),path.join(out,'交接文件.md'));
await copyFile(path.join(root,'LICENSE'),path.join(out,'LICENSE'));
await mkdir(path.join(root,'test-results'),{recursive:true});
await writeFile(path.join(root,'test-results','bundle-packages.json'),JSON.stringify([...packageFolders].map(folder=>path.relative(root,folder)),null,2));
console.log('Offline distribution ready: dist/index.html');
