import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {readDroppedFiles} from '../src/drop-import.js';
import {serveSites} from './site-server.mjs';

const results=[],pass=message=>{results.push(message);console.log('PASS '+message);};
const plain=new File(['# Readable'],'Single.MD',{type:'text/markdown'}),image=new File(['image'],'green.svg');let reads=0;
const blocked={isFile:true,isDirectory:false,name:plain.name,file(){reads++;throw new Error('Entry API unavailable');}},item=e=>({webkitGetAsEntry:()=>e});
assert.deepEqual(await readDroppedFiles({files:[plain],items:[item(blocked)]}),[plain]);assert.equal(reads,0);
pass('Single-file drop retains the native File and never reopens it through Entry.file');
assert.deepEqual(await readDroppedFiles({files:[plain,image],items:[item(blocked),{webkitGetAsEntry(){throw new Error('Unavailable');}}]}),[plain,image]);
pass('Multiple native files and a failing entry lookup use the same picker-compatible objects');
const transient={files:[plain],items:[item(blocked)]},pending=readDroppedFiles(transient);transient.files=[];transient.items=[];assert.deepEqual(await pending,[plain]);
pass('Drop data is captured synchronously before the event data store is cleared');
const fileEntry=(name,file)=>({name,isFile:true,isDirectory:false,file:resolve=>resolve(file)});
const directory=(name,batches)=>({name,isFile:false,isDirectory:true,createReader(){let i=0;return {readEntries:resolve=>resolve(batches[i++]||[])};}});
const folder=directory('books',[[fileEntry('book.md',plain)],[directory('assets',[[fileEntry('green.svg',image)]])],[]]);
const nested=await readDroppedFiles({files:[new File([],'books')],items:[item(folder)]});assert.deepEqual(nested,[{file:plain,path:'books/book.md'},{file:image,path:'books/assets/green.svg'}]);
pass('Real directory entries retain nested image paths and read every directory batch');
assert.deepEqual(await readDroppedFiles({files:[],items:[item(fileEntry('book.md',plain))]}),[{file:plain,path:'book.md'}]);
pass('Entry-only browser data remains supported when a native FileList is absent');
await assert.rejects(readDroppedFiles({files:[],items:[item({name:'bad.md',isFile:true,file:(ok,fail)=>fail(new DOMException('Unreadable','NotReadableError'))})]}),{name:'NotReadableError'});
await assert.rejects(readDroppedFiles({files:[],items:[item(directory('large',[Array.from({length:1001},(_,i)=>fileEntry(`${i}.md`,plain))]))]}),/Too many files/);
pass('Unreadable entry-only data and the existing 1000-file directory bound fail explicitly');

const out=path.join(process.cwd(),'test-results/drop-import');await mkdir(out,{recursive:true});const temp=await mkdtemp(path.join(out,'run-')),fixture=path.join(temp,'books');await mkdir(path.join(fixture,'assets'),{recursive:true});await mkdir(path.join(fixture,'chapters'),{recursive:true});
await writeFile(path.join(temp,'Single.MD'),'# Native single\n\n![Green](green.svg)');await writeFile(path.join(temp,'second.md'),'# Second');await writeFile(path.join(temp,'green.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>');await writeFile(path.join(fixture,'book.md'),'# Native folder\n\n![Green](assets/green.svg)');await writeFile(path.join(fixture,'chapters/next.md'),'# Nested chapter\n\n![Green](../assets/green.svg)\n\n[Back](../book.md)');await writeFile(path.join(fixture,'assets/green.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})}),server=await serveSites({app:process.env.INKREAD_TEST_DIST || path.join(process.cwd(),'dist')}),errors=[];
try{
 for(const scenario of ['drop-single-entry-failure','picker-single-entry-failure','drop-multiple','drop-folder','picker-folder']){
  const context=await browser.newContext({serviceWorkers:'block'});context.setDefaultTimeout(15000);
  await context.addInitScript(inject=>{window.dropProbe={calls:0,trusted:false};addEventListener('drop',e=>{dropProbe.trusted=e.isTrusted;if(!inject)return;for(const item of e.dataTransfer.items){const entry=item.webkitGetAsEntry?.();if(entry?.isFile)Object.getPrototypeOf(entry).file=function(ok,fail){dropProbe.calls++;queueMicrotask(()=>fail(new DOMException('Entry unavailable; native File is readable','NotReadableError')));};}},true);},scenario.endsWith('entry-failure'));
  const p=await context.newPage();p.on('pageerror',error=>errors.push(error.message));await p.goto(server.origin+'/app/');await p.locator('#app:not([hidden])').waitFor();await p.locator('#library-status[data-state=saved]').waitFor();
  if(scenario==='picker-folder'){const chooserEvent=p.waitForEvent('filechooser');await p.locator('#folder-button').click();await (await chooserEvent).setFiles(fixture);}
  else if(scenario.startsWith('picker'))await p.locator('#file-input').setInputFiles(path.join(temp,'Single.MD'));
  else{
   const files=scenario==='drop-folder'?[fixture]:scenario==='drop-multiple'?['Single.MD','second.md','green.svg'].map(n=>path.join(temp,n)):[path.join(temp,'Single.MD')];
   const session=await context.newCDPSession(p);for(const type of ['dragEnter','dragOver','drop'])await session.send('Input.dispatchDragEvent',{type,x:650,y:350,data:{items:[],files,dragOperationsMask:1}});
  }
  const isFolder=scenario.endsWith('folder'),expected=scenario==='drop-multiple'||isFolder?2:1;await p.waitForFunction(expected=>document.querySelectorAll('#user-files button').length===expected,expected);await p.locator('#library-status[data-state=saved]').waitFor();
  if(isFolder)await p.locator('#user-files button[title="books/book.md"]').click();assert.equal(await p.locator('#document h1').textContent(),isFolder?'Native folder':'Native single');assert.doesNotMatch(await p.locator('#toast').textContent(),/無法完整讀取/);
  if(isFolder || scenario==='drop-multiple')await p.waitForFunction(()=>{const img=document.querySelector('#document img');return img?.complete&&img.naturalWidth===10;});
  if(isFolder){assert.deepEqual((await p.locator('#user-files button').evaluateAll(nodes=>nodes.map(e=>e.title))).sort(),['books/book.md','books/chapters/next.md']);await p.locator('#user-files button[title="books/chapters/next.md"]').click();await p.waitForFunction(()=>document.querySelector('#document img')?.naturalWidth===10);await p.getByRole('link',{name:'Back',exact:true}).click();assert.equal(await p.locator('#document h1').textContent(),'Native folder');}
  const probe=await p.evaluate(()=>dropProbe);assert.equal(probe.calls,0);if(!scenario.startsWith('picker'))assert.equal(probe.trusted,true);
  pass(`Native ${scenario} imports the expected document and preserves applicable image paths`);await context.close();
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({engine:browser.version(),results,errors},null,2));
}finally{await browser.close();await server.close();}
