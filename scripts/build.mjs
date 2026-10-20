import {build} from 'esbuild';
import {mkdir, rm, copyFile, cp, readFile, writeFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {minify} from 'terser';
import {writeOfflineWorker} from './offline-worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out = path.join(root,'dist');
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
const shared = {absWorkingDir:root, metafile:true, bundle:true, format:'iife', platform:'browser', target:['chrome110','edge110'], minify:true, legalComments:'linked', loader:{'.md':'text','.svg':'text','.woff2':'file','.woff':'file','.ttf':'file'}, assetNames:'fonts/[name]-[hash]', logLevel:'info'};
const sharedModules = {
  name:'shared-offline-engines',
  setup(builder) {
    builder.onResolve({filter:/^(katex|dompurify)$/},args=>({path:args.path,namespace:'shared-engine'}));
    builder.onLoad({filter:/.*/,namespace:'shared-engine'},args=>({contents:`import {getLoadedVendor} from ${JSON.stringify(path.join(root,'src/vendor-loader.js'))}; export default ${args.path === 'katex' ? '{renderToString(...args){return getLoadedVendor("math").renderToString(...args)}}' : 'getLoadedVendor("sanitize")'};`,loader:'js',resolveDir:root}));
    builder.onResolve({filter:/^elkjs\/lib\/elk\.bundled\.js$/},()=>({path:path.join(root,'src/lazy-elk.js')}));
  }
};
const deferredTexmath = {
  name:'deferred-texmath-engine',
  setup(builder) {
    // markdown-it-texmath's unused CommonJS fallback must not pull KaTeX into app.js.
    builder.onResolve({filter:/^katex$/},()=>({path:'deferred-katex',namespace:'unused-math-fallback'}));
    builder.onLoad({filter:/.*/,namespace:'unused-math-fallback'},()=>({contents:'export default {};',loader:'js'}));
  }
};
const results = [];
for (const [entry,filename,plugins] of [
  ['app','app', [deferredTexmath]],
  ['math-engine','math', []],
  ['diagram-engine','diagrams',[sharedModules]],
  ['elk-engine','elk',[]],
]) results.push(await build({...shared,entryPoints:[path.join(root,`src/${entry}.js`)],outfile:path.join(out,`${filename}.js`),plugins}));
// The large optional engines are already minified; focus extra compression on the reader.
for (const file of ['app.js','math.js']) {
  const source = await readFile(path.join(out,file),'utf8');
  const compressed = await minify(source,{compress:{passes:2},mangle:true,format:{comments:/^!|@license|@preserve/}});
  if (!compressed.code) throw new Error(`Empty minified bundle: ${file}`);
  await writeFile(path.join(out,file),compressed.code + '\n');
}
await copyFile(path.join(root,'src/index.html'),path.join(out,'index.html'));
await copyFile(path.join(root,'src/favicon.svg'),path.join(out,'favicon.svg'));
await cp(path.join(root,'samples'),path.join(out,'samples'),{recursive:true});
await writeFile(path.join(out,'.nojekyll'),'');
// Keep upstream licenses available in the standalone, offline distribution.
let notices = '墨閱 Inkread — Third-party notices\n\n';
const modules = path.join(root,'node_modules');
const packageFolders = new Set();
for (const input of results.flatMap(result=>Object.keys(result.metafile.inputs))) {
  if (input.startsWith('shared-engine:') || input.startsWith('unused-math-fallback:')) continue;
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
// Include all static app assets and font formats, with content integrity checks.
await writeOfflineWorker(out);
await mkdir(path.join(root,'test-results'),{recursive:true});
await writeFile(path.join(root,'test-results','bundle-packages.json'),JSON.stringify([...packageFolders].map(folder=>path.relative(root,folder)),null,2));
await writeFile(path.join(root,'test-results','bundle-metafiles.json'),JSON.stringify(results.map(result=>result.metafile)));
const {gzipSync,brotliCompressSync} = await import('node:zlib');
const bundles = await Promise.all(['app.js','math.js','diagrams.js','elk.js'].map(async file=>{
  const bytes = await readFile(path.join(out,file));
  return {file,bytes:bytes.length,gzipBytes:gzipSync(bytes).length,brotliBytes:brotliCompressSync(bytes).length};
}));
await writeFile(path.join(root,'test-results','bundle-sizes.json'),JSON.stringify(bundles,null,2));
console.log(JSON.stringify(bundles,null,2));
console.log('Offline distribution ready: dist/index.html');
