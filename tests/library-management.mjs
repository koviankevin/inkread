import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planDocumentEdit,resolveSavedDocument} from '../src/library-management.js';
import {resolveDocumentPath} from '../src/document-links.js';
import {encodeBackup,decodeBackup} from '../src/library-backup.js';

const snapshot=()=>({documents:[{path:'books/A.md',source:'# A\n![image](assets/red.svg)',name:'A.md',revision:'A1',bytes:30},{path:'books/B.md',source:'# B\n[next](A.md)',name:'B.md',revision:'B1',bytes:20}],assets:[{path:'books/assets/red.svg',blob:new Blob(['red'])}],positions:[{path:'books/A.md',revision:'A1',y:400,ratio:.2,anchor:'A',fraction:.3,block:{index:7,fraction:.3},fontSize:18,atEnd:false,updatedAt:1}],current:'books/A.md'});

test('rename retains exact Markdown, image identity, revision, progress and incoming links',()=>{
  const old=snapshot(),before=JSON.stringify(old),next=planDocumentEdit(old,{kind:'rename',path:'books/A.md',name:'新名稱.md'});
  const renamed=next.documents.find(doc=>doc.path==='books/新名稱.md'),other=next.documents.find(doc=>doc.path==='books/B.md');
  assert.equal(renamed.source,old.documents[0].source); assert.equal(renamed.revision,'A1');
  assert.equal(resolveDocumentPath(renamed,'assets/red.svg'),'books/assets/red.svg');
  assert.equal(resolveDocumentPath(other,'A.md'),'books/新名稱.md');
  assert.deepEqual(next.positions,[{...old.positions[0],path:renamed.path}]);
  assert.equal(next.assets[0].blob,old.assets[0].blob); assert.equal(next.current,renamed.path);
  assert.equal(JSON.stringify(old),before); assert.deepEqual(next.removedPaths,['books/A.md']);
});
test('repeated rename preserves old aliases and correctly remaps existing redirects',()=>{
  const a=planDocumentEdit(snapshot(),{kind:'rename',path:'books/A.md',name:'C.md'});
  const b=planDocumentEdit(a,{kind:'rename',path:'books/C.md',name:'D'});
  const docs=new Map(b.documents.map(doc=>[doc.path,doc]));
  assert.equal(resolveSavedDocument(docs,'books/A.md','A1').path,'books/D.md');
  assert.equal(resolveSavedDocument(docs,'books/C.md','A1').path,'books/D.md');
  assert.equal(resolveDocumentPath(docs.get('books/B.md'),'A.md'),'books/D.md');
  assert.equal(resolveSavedDocument(docs,'books/A.md','wrong'),undefined);
  docs.set('books/A.md',{path:'books/A.md',revision:'new-import'});
  assert.equal(resolveSavedDocument(docs,'books/A.md','A1'),undefined,'Exact reimported path must not reuse a prior revision bookmark');
});
test('delete removes only selected document and its progress, retaining shared images',()=>{
  const old=snapshot(),next=planDocumentEdit(old,{kind:'delete',path:'books/A.md'});
  assert.deepEqual(next.documents.map(d=>d.path),['books/B.md']);assert.equal(next.current,'books/B.md');
  assert.equal(next.positions.length,0);assert.equal(next.assets,old.assets);assert.equal(old.documents.length,2);
});
test('invalid or duplicate names and paths leave original snapshot unchanged',()=>{
  for (const name of ['', '.', '..', '../escape.md', 'A/B.md', 'A\\B.md', 'x:bad.md', 'x\u0000.md', 'note.html', 'A.md', 'B.md', 'X'.repeat(151)+'.md']) {
    const old=snapshot(),before=JSON.stringify(old);
    assert.throws(()=>planDocumentEdit(old,{kind:'rename',path:'books/A.md',name}),undefined,name);
    assert.equal(JSON.stringify(old),before);
  }
  assert.throws(()=>planDocumentEdit(snapshot(),{kind:'delete',path:'unknown.md'}));
});
test('rename metadata remains portable through actual binary backup codec',async()=>{
  const plan=planDocumentEdit(snapshot(),{kind:'rename',path:'books/A.md',name:'可攜.md'});
  const decoded=await decodeBackup(await encodeBackup(plan));
  assert.equal(resolveDocumentPath(decoded.documents.find(d=>d.path==='books/B.md'),'A.md'),'books/可攜.md');
  assert.equal(decoded.positions[0].path,'books/可攜.md');
  assert.equal(await decoded.assets[0].blob.text(),'red');
});
