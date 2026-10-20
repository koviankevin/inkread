import {normalizePath,isMarkdown} from './paths.js';
import {newRevision} from './library-store.js';
import {documentLinks} from './document-links.js';
import {MAX_DOCUMENTS,MAX_DOCUMENT_BYTES,MAX_TEXT_BYTES,MAX_IMAGE_BYTES,MAX_ASSET_BYTES,MAX_IMPORT_FILES,textBytes} from './limits.js';

const imagePath=path=>/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path);
const safePath=path=>typeof path==='string' && path && normalizePath(path)===path && !path.startsWith('/') && !path.startsWith('範例/');
function fail(code,message) { const error=new Error(message); error.code=code; throw error; }
function capacity(documents,assets) {
  // Stop per record: shared mappings can expand when serialized across many copies.
  let linkBytes=0;
  for (const {path,linkBase,linkTargets} of documents) {
    linkBytes+=textBytes(JSON.stringify({path,linkBase,linkTargets}));
    if (linkBytes>1024*1024) fail('RESTORE_LIMIT','文件連結資料超過 1 MiB，請減少文件庫內容後重試。');
  }
  if (documents.length>MAX_DOCUMENTS || documents.some(doc=>doc.bytes>MAX_DOCUMENT_BYTES) || documents.reduce((n,doc)=>n+doc.bytes,0)>MAX_TEXT_BYTES || assets.length>MAX_IMPORT_FILES || assets.some(asset=>asset.blob.size>MAX_IMAGE_BYTES) || assets.reduce((n,asset)=>n+asset.blob.size,0)>MAX_ASSET_BYTES) fail('RESTORE_LIMIT','合併後超過容量限制：文件最多 200 份／20 MiB，圖片最多 1,000 張／100 MiB。請減少文件庫內容，或改用取代。');
}
function validPosition(row,doc) {
  return doc && row.revision===doc.revision && Number.isFinite(row.y) && row.y>=0 && Number.isFinite(row.ratio) && row.ratio>=0 && row.ratio<=1 && Number.isFinite(row.fraction) && row.fraction>=0 && row.fraction<=1 && typeof row.anchor==='string' && row.anchor.length<=1000 && Number.isFinite(row.updatedAt);
}

// Read the latest committed destination, including its matching shutdown checkpoint.
export function storedLibrarySnapshot(saved) {
  const documents=saved.documents.map(row=>{
    if (!safePath(row.path) || !isMarkdown(row.path) || typeof row.source!=='string') fail('EXISTING_INVALID','目前文件庫有無法讀取的資料，請保留原始文件後再試。');
    return {path:row.path,name:row.path.split('/').pop(),source:row.source,bytes:textBytes(row.source),revision:typeof row.revision==='string' ? row.revision : newRevision(),pasted:row.pasted===true,...documentLinks(row)};
  });
  const assets=saved.assets.map(row=>{
    if (!safePath(row.path) || !imagePath(row.path) || !(row.blob instanceof Blob)) fail('EXISTING_INVALID','目前文件庫有無法讀取的圖片，請保留原始文件後再試。');
    return {path:row.path,blob:row.blob};
  });
  capacity(documents,assets);
  const docs=new Map(documents.map(doc=>[doc.path,doc])),positions=new Map();
  for (const row of [...saved.positions,saved.checkpoint?.position].filter(Boolean)) {
    if (validPosition(row,docs.get(row.path)) && (!positions.has(row.path) || row.updatedAt>positions.get(row.path).updatedAt)) positions.set(row.path,{...row});
  }
  const selected=(saved.checkpoint?.current?.updatedAt || 0)>(saved.current?.updatedAt || 0) ? saved.checkpoint.current : saved.current;
  return {documents,assets,positions:[...positions.values()],current:docs.has(selected?.path) ? selected.path : null,revision:saved.revision};
}

export function restoreConflicts(existing,incoming) {
  const result=[];
  for (const kind of ['documents','assets']) {
    const old=new Map(existing[kind].map(row=>[row.path,row]));
    for (const row of incoming[kind]) if (old.has(row.path)) result.push({key:`${kind}:${row.path}`,kind,path:row.path,existing:old.get(row.path),incoming:row});
  }
  return result;
}

export function planRestore(existing,incoming,mode,choices=new Map()) {
  if (!['merge','replace'].includes(mode)) fail('RESTORE_MODE','請選擇還原方式。');
  const conflicts=mode==='merge' ? restoreConflicts(existing,incoming) : [];
  const isolateImages=conflicts.some(row=>row.kind==='documents' && choices.get(row.key)==='both');
  if (conflicts.some(row=>!(row.kind==='assets' && isolateImages) && !['existing','backup','both'].includes(choices.get(row.key)))) fail('RESTORE_CONFLICT','請先為每一項同路徑文件與圖片選擇要保留的版本。');
  const renamed=[],mapping=new Map(),reserved=new Set([...existing.documents,...existing.assets,...incoming.documents,...incoming.assets].map(row=>row.path));
  for (const row of conflicts) if (choices.get(row.key)==='both' || (row.kind==='assets' && isolateImages)) {
    const dot=row.path.lastIndexOf('.'),slash=row.path.lastIndexOf('/')+1,directory=row.path.slice(0,slash),stem=row.path.slice(slash,dot),extension=row.path.slice(dot);
    let path;
    for (let number=1;;number++) {
      const suffix=` (備份 ${number})${extension}`;
      const available=1024-directory.length-suffix.length;
      if (available<1) fail('RESTORE_LIMIT','文件路徑過長，無法加入備份編號；請縮短原始路徑後重試。');
      path=directory+stem.slice(0,available).replace(/[\uD800-\uDBFF]$/,'')+suffix;
      if (!reserved.has(path)) break;
    }
    reserved.add(path); mapping.set(row.path,path); renamed.push({kind:row.kind,from:row.path,to:path});
  }
  const documents=new Map((mode==='merge' ? existing.documents : []).map(row=>[row.path,row]));
  const assets=new Map((mode==='merge' ? existing.assets : []).map(row=>[row.path,row]));
  const positions=new Map((mode==='merge' ? existing.positions : []).map(row=>[row.path,row]));
  const incomingPositions=new Map(incoming.positions.map(row=>[row.path,row]));
  for (const row of incoming.documents) {
    if (mode==='merge' && documents.has(row.path) && choices.get(`documents:${row.path}`)==='existing') continue;
    const path=mapping.get(row.path) || row.path,links=documentLinks(row),targets=new Map(mapping);
    for (const [from,to] of links.linkTargets || []) targets.set(from,mapping.get(to) || to);
    const doc={...row,...links,path,name:path.split('/').pop(),bytes:textBytes(row.source),revision:newRevision()};
    if (targets.size) Object.assign(doc,documentLinks({linkBase:links.linkBase || row.path,linkTargets:[...targets]}));
    documents.set(path,doc); positions.delete(path);
    const position=incomingPositions.get(row.path);
    if (position) positions.set(path,{...position,path,revision:doc.revision});
  }
  for (const row of incoming.assets) {
    const path=mapping.get(row.path) || row.path;
    if (mode==='merge' && !mapping.has(row.path) && assets.has(path) && choices.get(`assets:${row.path}`)==='existing') continue;
    assets.set(path,{...row,path});
  }
  const selected=mapping.get(incoming.current) || incoming.current;
  const result={documents:[...documents.values()],assets:[...assets.values()],positions:[...positions.values()],current:mode==='merge' && documents.has(existing.current) ? existing.current : documents.has(selected) ? selected : documents.keys().next().value || null,renamed};
  capacity(result.documents,result.assets);
  return result;
}
