import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {browserType,browserName,compatibility} from './browser-compat.mjs';
import {serveSites} from './site-server.mjs';
const root=process.cwd(),out=path.join(root,'test-results','checkpoint-storage');await mkdir(out,{recursive:true});
const tmp=await mkdtemp(path.join(os.tmpdir(),'ircpqa-'));
const server=await serveSites({src:process.env.INKREAD_TEST_SOURCE||path.join(root,'src')},{intercept:pathname=>pathname==='/src/checkpoint-qa.html'?{headers:{'Content-Type':'text/html'},body:'<!doctype html><script type="module">import{createLibraryStore}from"./library-store.js";import{storedLibrarySnapshot}from"./library-restore.js";window.makeStore=createLibraryStore;window.snapshot=storedLibrarySnapshot;</script>'}:undefined});
let context;
try{
 context=await browserType.launchPersistentContext(tmp,{headless:true,...(!compatibility&&process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});const p=await context.newPage();await p.goto(server.origin+'/src/checkpoint-qa.html');await p.waitForFunction(()=>window.makeStore&&window.snapshot);
 const result=await p.evaluate(async()=>{
  const check=(condition,message)=>{if(!condition)throw Error(message);};const results=[];const a=makeStore(),b=makeStore();
  const documents=[{path:'A.md',revision:'rev-A',source:'# A'},{path:'B.md',revision:'rev-B',source:'# B'}];
  const position=(path,y,updatedAt)=>({path,revision:'rev-'+path[0],y,ratio:.1,anchor:path[0],fraction:.35,fontSize:18,block:{index:1,fraction:.35},atEnd:false,updatedAt});
  await a.load();await a.write({documents,positions:[position('A.md',6,1),position('B.md',9,1)],current:{path:'A.md',updatedAt:1}});await b.load();
  a.checkpoint({path:'A.md',updatedAt:2},position('A.md',7,2));b.checkpoint({path:'B.md',updatedAt:3},position('B.md',10,3));
  const inspect=async()=>snapshot(await a.load());let s=await inspect();
  check(s.positions.find(p=>p.path==='A.md').y===7&&s.positions.find(p=>p.path==='B.md').y===10,'Independent checkpoints must retain both positions');results.push('Independent document checkpoints survive the shared selection slot');
  const base='inkread-library:'+new URL('./',location.href).href+':checkpoint';const key=Object.keys(localStorage).find(k=>k.startsWith(base+':')&&k.endsWith(':A.md'));check(key,'A checkpoint exists');const original=localStorage.getItem(key);
  for(const mutate of [()=>'{',r=>{r.position.path='B.md';return JSON.stringify(r);},r=>{r.position.revision='stale';return JSON.stringify(r);},r=>{r.epoch='stale';return JSON.stringify(r);},r=>{r.position.ratio=2;return JSON.stringify(r);},r=>{r.position.y=null;return JSON.stringify(r);}]){
   localStorage.setItem(key,mutate(JSON.parse(original)));s=await inspect();check(s.positions.find(p=>p.path==='A.md').y===6,'Invalid checkpoint must fall back to the valid committed row');check(s.positions.find(p=>p.path==='B.md').y===10,'Other document remains independent');
  }
  localStorage.setItem(key,original);results.push('Malformed, wrong-path, wrong-revision, wrong-epoch and invalid numeric checkpoints keep valid fallback rows');
  const captured=Object.fromEntries(Object.entries(localStorage).filter(([k])=>k===base||k.startsWith(base+':')));
  let failed=false;try{await a.replace({documents,assets:[],positions:[],current:{path:'B.md',updatedAt:4}},'wrong-revision');}catch(e){failed=e.code==='LIBRARY_CHANGED';}check(failed,'Replacement must reject stale revision');
  for(const [k,v]of Object.entries(captured))check(localStorage.getItem(k)===v,'Failed replacement cannot remove a checkpoint');results.push('Failed replacement retains every old checkpoint');
  const other='inkread-library:'+new URL('../other/',location.href).href+':checkpoint:foreign:A.md';localStorage.setItem(other,'keep');localStorage.setItem('unrelated-qa','keep');
  const latest=await a.load();await a.replace({documents:documents.map(d=>({...d,revision:d.revision+'-new'})),assets:[],positions:[],current:{path:'A.md',updatedAt:4}},latest.revision);
  check(!Object.keys(localStorage).some(k=>k===base||k.startsWith(base+':')),'Successful replacement removes old checkpoints');s=await inspect();check(s.positions.length===0,'Old positions cannot attach to replacement documents');check(localStorage.getItem(other)==='keep','Replacement is scoped');results.push('Successful replacement invalidates the old generation and cleans its checkpoints');
  a.checkpoint({path:'A.md',updatedAt:5},{...position('A.md',8,5),revision:'rev-A-new'});await a.clear();const empty=await a.load();check(empty.documents.length===0&&empty.positions.length===0,'Clear removes library and progress');check(!Object.keys(localStorage).some(k=>k===base||k.startsWith(base+':')),'Clear cleans own checkpoints');check(localStorage.getItem(other)==='keep'&&localStorage.getItem('unrelated-qa')==='keep','Clear cannot remove other namespaces');results.push('Clear removes own progress and leaves other scopes untouched');
  return {passed:results.length,results};
 });
 assert.equal(result.passed,5);for(const r of result.results)console.log('PASS '+r);await writeFile(path.join(out,browserName+'-results.json'),JSON.stringify(result,null,2));
}finally{await context?.close();await server.close();assert(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
