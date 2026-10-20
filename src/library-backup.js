import {normalizePath,isMarkdown} from './paths.js';
import {documentLinks} from './document-links.js';
import {MAX_DOCUMENTS,MAX_DOCUMENT_BYTES,MAX_TEXT_BYTES,MAX_IMAGE_BYTES,MAX_ASSET_BYTES,MAX_IMPORT_FILES} from './limits.js';

const MAGIC=new Uint8Array([73,78,75,82,69,65,68,0]); // INKREAD followed by NUL.
const HEADER=44, MAX_MANIFEST=2*1024*1024;
export const MAX_BACKUP_BYTES=HEADER+MAX_MANIFEST+MAX_TEXT_BYTES+MAX_ASSET_BYTES;
const mimeTypes=Object.assign(Object.create(null),{png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',bmp:'image/bmp',ico:'image/x-icon'});
const invalid=()=>{throw new Error('備份格式不正確、內容損壞或超過容量限制。');};
const digest=async blob=>new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const validPath=value=>typeof value==='string' && value.length>0 && value.length<=1024 && !/[\x00-\x1f\x7f:\\]/.test(value) && !value.startsWith('/') && !value.startsWith('範例/') && normalizePath(value)===value;

function positionFor(row,paths) {
  if (!row || !paths.has(row.path) || !Number.isFinite(row.y) || row.y<0 || row.y>1e9 || !Number.isFinite(row.ratio) || row.ratio<0 || row.ratio>1 || !Number.isFinite(row.fraction) || row.fraction<0 || row.fraction>1 || typeof row.anchor!=='string' || row.anchor.length>1000 || typeof row.atEnd!=='boolean' || !Number.isFinite(row.updatedAt) || row.updatedAt<0) invalid();
  return {path:row.path,y:row.y,ratio:row.ratio,fraction:row.fraction,anchor:row.anchor,atEnd:row.atEnd,updatedAt:row.updatedAt};
}

// A small hashed JSON manifest followed by original UTF-8 text and image bytes.
// No base64 expansion, external requests, executable markup or ZIP dependency.
export async function encodeBackup(snapshot) {
  if (snapshot.documents.length>MAX_DOCUMENTS || snapshot.assets.length>MAX_IMPORT_FILES || snapshot.positions.length>MAX_DOCUMENTS) invalid();
  const chunks=[], documents=[], assets=[];
  const seen=new Set(); let textTotal=0,assetTotal=0;
  for (const doc of snapshot.documents) {
    const blob=new Blob([doc.source]);
    if (!validPath(doc.path) || !isMarkdown(doc.path) || seen.has(doc.path) || blob.size>MAX_DOCUMENT_BYTES) invalid();
    seen.add(doc.path); textTotal+=blob.size;
    if (textTotal>MAX_TEXT_BYTES) invalid();
    documents.push({path:doc.path,size:blob.size,sha256:hex(await digest(blob)),pasted:doc.pasted===true,...documentLinks(doc)});
    chunks.push(blob);
  }
  for (const asset of snapshot.assets) {
    if (!validPath(asset.path) || !mimeTypes[asset.path.split('.').pop().toLowerCase()] || seen.has(asset.path) || !(asset.blob instanceof Blob) || asset.blob.size>MAX_IMAGE_BYTES) invalid();
    seen.add(asset.path); assetTotal+=asset.blob.size;
    if (assetTotal>MAX_ASSET_BYTES) invalid();
    assets.push({path:asset.path,size:asset.blob.size,sha256:hex(await digest(asset.blob))});
    chunks.push(asset.blob);
  }
  const paths=new Set(documents.map(doc=>doc.path));
  const version=documents.some(doc=>doc.linkBase!==undefined) ? 2 : 1;
  const manifest=new Blob([JSON.stringify({format:'inkread-library',version,createdAt:new Date().toISOString(),documents,assets,positions:snapshot.positions.map(row=>positionFor(row,paths)),current:paths.has(snapshot.current) ? snapshot.current : null})]);
  if (manifest.size>MAX_MANIFEST) invalid();
  const header=new Uint8Array(HEADER);
  header.set(MAGIC); new DataView(header.buffer).setUint32(8,manifest.size,true); header.set(await digest(manifest),12);
  const backup=new Blob([header,manifest,...chunks],{type:'application/octet-stream'});
  if (backup.size>MAX_BACKUP_BYTES) invalid();
  return backup;
}

export async function decodeBackup(file) {
  if (!(file instanceof Blob) || file.size<HEADER || file.size>MAX_BACKUP_BYTES) invalid();
  const header=new Uint8Array(await file.slice(0,HEADER).arrayBuffer());
  if (!MAGIC.every((byte,index)=>header[index]===byte)) invalid();
  const length=new DataView(header.buffer).getUint32(8,true);
  if (length<2 || length>MAX_MANIFEST || HEADER+length>file.size) invalid();
  const manifestBlob=file.slice(HEADER,HEADER+length);
  if (!(await digest(manifestBlob)).every((byte,index)=>header[index+12]===byte)) invalid();
  let manifest;
  try { manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await manifestBlob.arrayBuffer())); } catch { invalid(); }
  if (!manifest || manifest.format!=='inkread-library' || ![1,2].includes(manifest.version) || typeof manifest.createdAt!=='string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.documents) || manifest.documents.length>MAX_DOCUMENTS || !Array.isArray(manifest.assets) || manifest.assets.length>MAX_IMPORT_FILES || !Array.isArray(manifest.positions) || manifest.positions.length>MAX_DOCUMENTS) invalid();
  const paths=new Set(),docPaths=new Set();
  let offset=HEADER+length,textTotal=0,assetTotal=0;
  const entries=[];
  for (const [rows,images] of [[manifest.documents,false],[manifest.assets,true]]) {
    for (const row of rows) {
      const type=typeof row?.path==='string' && mimeTypes[row.path.split('.').pop().toLowerCase()];
      if (!row || !validPath(row.path) || paths.has(row.path) || (images ? !type : !isMarkdown(row.path)) || !Number.isSafeInteger(row.size) || row.size<0 || row.size>(images ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES) || typeof row.sha256!=='string' || !/^[a-f0-9]{64}$/.test(row.sha256) || (!images && typeof row.pasted!=='boolean')) invalid();
      paths.add(row.path);
      if (images) assetTotal+=row.size; else { textTotal+=row.size; docPaths.add(row.path); }
      if (textTotal>MAX_TEXT_BYTES || assetTotal>MAX_ASSET_BYTES) invalid();
      entries.push({row,images,type,start:offset}); offset+=row.size;
    }
  }
  if (offset!==file.size || (manifest.current!==null && !docPaths.has(manifest.current))) invalid();
  const positionPaths=new Set();
  const positions=manifest.positions.map(row=>{
    const position=positionFor(row,docPaths);
    if (positionPaths.has(position.path)) invalid();
    positionPaths.add(position.path); return position;
  });
  const documents=[],assets=[];
  for (const {row,images,type,start} of entries) {
    const blob=file.slice(start,start+row.size,images ? type : 'text/plain');
    if (hex(await digest(blob))!==row.sha256) invalid();
    if (images) assets.push({path:row.path,blob});
    else {
      let source;
      try { source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await blob.arrayBuffer()); } catch { invalid(); }
      if (manifest.version===1 && (row.linkBase!==undefined || row.linkTargets!==undefined)) invalid();
      documents.push({path:row.path,source,bytes:row.size,pasted:row.pasted,...documentLinks(row)});
    }
  }
  return {documents,assets,positions,current:manifest.current,createdAt:manifest.createdAt};
}
