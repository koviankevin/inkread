import {isMarkdown} from './paths.js';
import {documentLinks,validLibraryPath} from './document-links.js';
import {validateLibraryCapacity} from './library-restore.js';

const fail=message=>{throw new Error(message);};

// Keep original Markdown and image paths intact. Redirect local links using
// the same portable metadata already used by keep-both backup restoration.
export function planDocumentEdit(snapshot,{kind,path,name}) {
  const original=snapshot.documents.find(doc=>doc.path===path);
  if (!original) fail('這份文件已變更或刪除，請重新選擇。');
  if (!['rename','delete'].includes(kind)) fail('請選擇文件操作。');
  let target;
  if (kind==='rename') {
    name=typeof name==='string' ? name.trim() : '';
    if (!name || name.length>150 || /[\x00-\x1f\x7f/\\:]/.test(name) || ['.','..'].includes(name)) fail('請輸入 1–150 字元的檔名，不可包含路徑或控制字元。');
    if (!name.includes('.')) name+='.md';
    if (!isMarkdown(name)) fail('檔名需以 .md、.markdown 或 .txt 結尾。');
    target=path.slice(0,path.lastIndexOf('/')+1)+name;
    if (!validLibraryPath(target)) fail('檔案路徑過長或不正確，請縮短名稱。');
    if (target===path) fail('請輸入與目前不同的名稱。');
    if ([...snapshot.documents,...snapshot.assets].some(row=>row.path===target)) fail('同一資料夾已有這個名稱，請使用其他名稱。');
  }
  const documents=snapshot.documents.filter(doc=>kind!=='delete' || doc.path!==path).map(doc=>{
    if (kind==='delete') return doc;
    const links=documentLinks(doc),targets=new Map((links.linkTargets || []).map(([from,to])=>[from,to===path ? target : to]));
    targets.set(path,target);
    const renamed=doc.path===path;
    return {...doc,...documentLinks({linkBase:links.linkBase || doc.path,linkTargets:[...targets]}),...(renamed ? {path:target,name:target.split('/').pop()} : {})};
  });
  const positions=snapshot.positions.filter(position=>kind!=='delete' || position.path!==path).map(position=>kind==='rename' && position.path===path ? {...position,path:target} : position);
  const current=snapshot.current===path ? target || documents[0]?.path || null : snapshot.current;
  validateLibraryCapacity(documents,snapshot.assets);
  return {documents,assets:snapshot.assets,positions,current,removedPaths:[path],rename:target ? {from:path,to:target} : null};
}

// Exact existing paths always win over aliases, including a newly reimported file.
export function resolveSavedDocument(documents,path,revision) {
  const exact=documents.get(path);
  if (exact) return !revision || exact.revision===revision ? exact : undefined;
  for (const doc of documents.values()) {
    if (doc.demo || revision && doc.revision!==revision) continue;
    if (doc.linkTargets?.some(([from,to])=>from===path && to===doc.path)) return doc;
  }
}
