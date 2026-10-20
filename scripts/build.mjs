import {build} from 'esbuild';
import {mkdir, rm, copyFile, cp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out = path.join(root,'dist');
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
await build({entryPoints:[path.join(root,'src/app.js')], outfile:path.join(out,'app.js'), bundle:true, format:'iife', platform:'browser', target:['chrome110','edge110'], minify:true, legalComments:'linked', loader:{'.md':'text','.svg':'text','.woff2':'file','.woff':'file','.ttf':'file'}, assetNames:'fonts/[name]-[hash]', logLevel:'info'});
await copyFile(path.join(root,'src/index.html'),path.join(out,'index.html'));
await copyFile(path.join(root,'src/favicon.svg'),path.join(out,'favicon.svg'));
await cp(path.join(root,'samples'),path.join(out,'samples'),{recursive:true});
await writeFile(path.join(out,'.nojekyll'),'');
// Keep upstream licenses available in the standalone, offline distribution.
let notices = '墨閱 Inkread — Third-party notices\n\n';
for (const name of ['markdown-it','markdown-it-task-lists','markdown-it-texmath','katex','highlight.js','dompurify','mermaid','lucide']) {
  const folder = path.join(root,'node_modules',name);
  const pkg = JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));
  notices += `${name} ${pkg.version} (${pkg.license || 'See license below'})\n`;
  for (const filename of ['LICENSE','LICENSE.txt','LICENSE.md','license','LICENSE-MIT']) {
    try { notices += await readFile(path.join(folder,filename),'utf8') + '\n\n'; break; } catch {}
  }
}
await writeFile(path.join(out,'THIRD-PARTY-NOTICES.txt'),notices);
try { await copyFile(path.join(root,'README.md'),path.join(out,'使用說明.md')); } catch {}
await copyFile(path.join(root,'交接文件.md'),path.join(out,'交接文件.md'));
console.log('Offline distribution ready: dist/index.html');
