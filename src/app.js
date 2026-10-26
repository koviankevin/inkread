import './style.css';
import './library-ui.css';
import {createIcons, Plus, Search, X, FolderOpen, ShieldCheck, CircleHelp, PanelLeft, ChevronRight, Minus, Moon, Sun, Printer, List, FileText, FileUp, BookOpen, ArrowUp, Copy, Check, Sparkles, ImageOff, ArrowLeftRight, FileCode2, ChartNoAxesCombined} from 'lucide';
import {renderMarkdown, sanitizeDiagram, safeDiagramSource, sanitizeFormula} from './renderer.js';
import {loadVendor} from './vendor-loader.js';
import {prepareOffline} from './offline.js';
import {createLibraryStore,newRevision} from './library-store.js';
import {encodeBackup,decodeBackup} from './library-backup.js';
import {storedLibrarySnapshot,restoreConflicts,planRestore} from './library-restore.js';
import {normalizePath, isMarkdown, imageKind} from './paths.js';
import {documentLinks,resolveDocumentPath} from './document-links.js';
import {planDocumentEdit,resolveSavedDocument} from './library-management.js';
import {createLibraryHealth} from './library-health.js';
import {MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_ASSET_BYTES, MAX_IMPORT_FILES, textBytes} from './limits.js';
import introduction from '../samples/開始閱讀.md';
import charts from '../samples/圖表與公式.md';
import tables from '../samples/表格筆記.md';
import sampleImage from '../samples/assets/reading-flow.svg';

const $ = id => document.getElementById(id);
const icons = {Plus, Search, X, FolderOpen, ShieldCheck, CircleHelp, PanelLeft, ChevronRight, Minus, Moon, Sun, Printer, List, FileText, FileUp, BookOpen, ArrowUp, Copy, Check, Sparkles, ImageOff, ArrowLeftRight, FileCode2, ChartNoAxesCombined};
const refreshIcons = () => createIcons({icons, attrs:{'aria-hidden':'true'}});
const demoDocs = [
  {path:'範例/開始閱讀.md', source:introduction, name:'開始閱讀.md', demo:true, icon:'book-open'},
  {path:'範例/表格筆記.md', source:tables, name:'表格筆記.md', demo:true, icon:'file-text'},
  {path:'範例/圖表與公式.md', source:charts, name:'圖表與公式.md', demo:true, icon:'chart-no-axes-combined'},
];
const documents = new Map(demoDocs.map(doc => [doc.path,doc]));
const assets = new Map();
const assetSizes = new Map();
const assetBlobs = new Map();
const readingPositions = new Map();
const dirtyDocuments = new Map(), dirtyAssets = new Map(), dirtyPositions = new Map();
const sampleBlob = URL.createObjectURL(new Blob([sampleImage], {type:'image/svg+xml'}));
assets.set('範例/assets/reading-flow.svg', sampleBlob);
let current = demoDocs[0];
let remoteAllowed = false;
let currentImages = [];
let renderVersion = 0;
let activeRender = Promise.resolve();
let featureObservers = [];
let renderAllFeatures = () => Promise.resolve();
let activeHeadings = [];
let headingPositions = [];
let readingBlocks = [], blockPositions = [], layoutWidth = 0, layoutHeight = 0, layoutTop = 0, layoutArticleHeight = 0;
let restoredBlock;
let tocLinks = [];
let activeHeadingIndex = -1;
let measureHeadings = true;
let progressFrame = 0;
let fontSize = 18;
let toastTimer;
let dragDepth = 0;
let pasteCounter = 0;
let displayedDocument;
const printMedia=matchMedia('print');
let libraryLoading = true, libraryReady = false, libraryGeneration = 0;
let saveTimer, savePromise, pendingSelection, storageError, clearFailed = false, clearing = false, resumeTask;
let transferBusy=false, restoreCommitting=false, restoreSnapshot, importsInFlight=0;
let restoreBase, restorePreparing=false;
let managementBusy=false,managementPath,managementRevision;
let tabBookmarkTimer,lastTabBookmark=0;
const restoreChoices=new Map(), restorePreviewURLs=[];
const library = createLibraryStore(change=>{
  if (change?.type==='edit') { void syncEditedLibrary(); return; }
  libraryReady=false; storageError=undefined; clearFailed=false; resetLibraryMemory();
  toast('已同步其他分頁的文件庫變更，重新開啟可讀取最新文件庫。');
});
const health=createLibraryHealth(()=>({documents:[...documents.values()].filter(doc=>!doc.demo).length,images:assetBlobs.size,textBytes:[...documents.values()].filter(doc=>!doc.demo).reduce((sum,doc)=>sum+(doc.bytes || textBytes(doc.source)),0),imageBytes:[...assetSizes.values()].reduce((sum,size)=>sum+size,0),errorName:storageError?.name}));
try { history.scrollRestoration = 'manual'; } catch { /* Local-file browser policies vary. */ }

function hasPendingSave() { return dirtyDocuments.size || dirtyAssets.size || dirtyPositions.size || pendingSelection; }
function renderLibraryStatus() {
  const status=$('library-status');
  let state='saved', text='文件與進度會保存在此瀏覽器';
  if (libraryLoading) { state='loading'; text='正在恢復閱讀空間…'; }
  else if (transferBusy) { state='processing'; text=restoreCommitting ? '正在還原文件庫…' : '正在準備文件庫備份或還原…'; }
  else if (clearing) { state='saving'; text='正在清除已保存資料…'; }
  else if (storageError) { state='error'; text=clearFailed ? '清除失敗，資料仍保留' : '尚未保存，請保留原始文件'; }
  else if (savePromise || hasPendingSave()) { state='saving'; text='正在保存文件與閱讀進度…'; }
  else if (resumeTask) { state='restoring'; text='正在恢復閱讀位置…'; }
  else if (assetBlobs.size || [...documents.values()].some(doc=>!doc.demo)) text='文件、圖片與進度已保存在此瀏覽器';
  status.textContent=text; status.dataset.state=state;
  status.title=storageError ? '瀏覽器可能禁止儲存或空間不足。請重試；尚未保存的資料關閉後可能遺失。' : '只保存在這個瀏覽器，不會上傳；可按文件清單的清除按鈕刪除。';
  $('library-retry').hidden=state!=='error';
  $('library-retry').textContent=clearFailed ? '重試清除' : '重試保存';
  $('library-retry').disabled=storageError?.name==='LibraryEditConflict';
  if (storageError?.name==='LibraryEditConflict') $('library-retry').textContent='請先備份後重開';
  $('backup-library').disabled=transferBusy || clearing || libraryLoading || !([...documents.values()].some(doc=>!doc.demo) || assetBlobs.size);
  $('restore-library').disabled=transferBusy || clearing || libraryLoading;
  $('clear-files').disabled=transferBusy;
  $('manage-library').disabled=transferBusy || clearing || libraryLoading || !libraryReady || ![...documents.values()].some(doc=>!doc.demo);
  health.render();
}
function scheduleLibrarySave() {
  if (libraryLoading || clearing || storageError || saveTimer) return;
  saveTimer=setTimeout(()=>{ saveTimer=undefined; void flushLibrary(); },500);
  renderLibraryStatus();
}
function selectForSaving() {
  pendingSelection={path:current.path,updatedAt:Date.now()};
  scheduleLibrarySave();
}
function tabDocumentPath() {
  // Fragments survive tab/session restoration without sending local filenames
  // to the server. They identify a saved document, never carry document bytes.
  if (!location.hash.startsWith('#inkread=')) return;
  try { return decodeURIComponent(location.hash.slice(9).split('&position=')[0]); } catch { /* Invalid bookmark. */ }
}
function rememberTabDocument(immediate=true) {
  const elapsed=Date.now()-lastTabBookmark;
  // WebKit limits history writes. Coalesce continuous scrolling while keeping
  // document selection and page exit synchronous, including pending IDB saves.
  if (!immediate && elapsed<500) {
    if (!tabBookmarkTimer) tabBookmarkTimer=setTimeout(()=>{
      tabBookmarkTimer=undefined;
      if (libraryReady && !libraryLoading && !clearing) rememberTabDocument();
    },500-elapsed);
    return;
  }
  clearTimeout(tabBookmarkTimer); tabBookmarkTimer=undefined;
  lastTabBookmark=Date.now();
  try {
    let hash=`#inkread=${encodeURIComponent(current.path)}`;
    const position=readingPositions.get(current.path);
    // Each tab owns its URL snapshot. No shared tab ID or last-writer slot can
    // overwrite another reader, including duplicated tabs and full restarts.
    if (!current.demo && position?.revision===current.revision && library.epoch) hash+=`&position=${encodeURIComponent(JSON.stringify({epoch:library.epoch,position:{...position,anchor:''}}))}`;
    if (location.hash!==hash) history.replaceState(history.state,'',hash);
  }
  catch { /* Reading and shared-library recovery still work if history is blocked. */ }
}
function rememberPosition() {
  if (libraryLoading || clearing || managementBusy || restorePreparing || (transferBusy && restoreBase) || resumeTask || printMedia.matches || current.demo || displayedDocument!==current || documents.get(current.path)!==current) return;
  const y=window.scrollY, end=document.documentElement.scrollHeight;
  const index=Math.max(0,activeHeadingIndex), top=headingPositions[index];
  const height=Math.max(1,(headingPositions[index+1] || end) - (top || 0));
  // Keep the logical fraction across programmatic restores. Some engines round
  // scrollTo down to a pixel; repeatedly measuring it would accumulate drift.
  if(restoredBlock && (restoredBlock.version!==renderVersion || Math.abs(restoredBlock.y-y)>.5)) restoredBlock=undefined;
  const block=restoredBlock?.block || cachedReadingBlock(y+150);
  const position={path:current.path,revision:current.revision,y,ratio:y/Math.max(1,end-window.innerHeight),anchor:activeHeadings[index]?.id || '',fraction:Math.max(0,Math.min(1,(y+150-(top || 0))/height)),fontSize,...(block ? {block} : {}),atEnd:y+window.innerHeight>=end-5,updatedAt:Date.now()};
  const previous=readingPositions.get(current.path);
  if (previous && previous.fontSize===fontSize && previous.block?.index===block?.index && previous.block?.gap===block?.gap && Math.abs((previous.block?.fraction || 0)-(block?.fraction || 0))<1e-6 && Math.abs(previous.y-y)<1 && previous.anchor===position.anchor && previous.atEnd===position.atEnd && Math.abs(previous.fraction-position.fraction)<1e-6 && Math.abs(previous.ratio-position.ratio)<1e-6) return;
  readingPositions.set(current.path,position); dirtyPositions.set(current.path,position);
  rememberTabDocument(false);
  selectForSaving();
}
function checkpointLibrary() {
  if (libraryLoading || clearing || managementBusy || (transferBusy && restoreBase) || !libraryReady) return;
  if (!resumeTask) updateProgress();
  library.checkpoint(pendingSelection || {path:current.path,updatedAt:Date.now()},readingPositions.get(current.path));
}
function saveOnExit() {
  // A tab invalidated by another tab must not reload the library while leaving
  // and checkpoint its temporary guide over the newly restored selection.
  if (!libraryReady) return;
  checkpointLibrary(); rememberTabDocument(); void flushLibrary();
}
function flushLibrary() {
  clearTimeout(saveTimer); saveTimer=undefined;
  if (storageError?.name==='LibraryEditConflict') return Promise.resolve();
  if (libraryLoading || clearing) return Promise.resolve();
  if (savePromise) return savePromise;
  const generation=libraryGeneration;
  savePromise=(async()=>{
    try {
      if (!libraryReady) await hydrateLibrary(false);
      if (generation!==libraryGeneration || clearing || !hasPendingSave()) return;
      checkpointLibrary();
      const docs=[...dirtyDocuments.values()], images=[...dirtyAssets.values()], positions=[...dirtyPositions.values()], selected=pendingSelection;
      await library.write({documents:docs,assets:images,positions,current:selected});
      if (generation!==libraryGeneration) return;
      for (const [map,entries] of [[dirtyDocuments,docs],[dirtyAssets,images],[dirtyPositions,positions]]) for (const entry of entries) if (map.get(entry.path)===entry) map.delete(entry.path);
      if (pendingSelection===selected) pendingSelection=undefined;
      storageError=undefined; clearFailed=false;
    } catch(error) { if (generation===libraryGeneration) storageError=error; }
  })().finally(()=>{
    savePromise=undefined;
    if (!storageError && hasPendingSave()) scheduleLibrarySave();
    renderLibraryStatus();
  });
  renderLibraryStatus();
  return savePromise;
}
async function hydrateLibrary(resume) {
  const generation=libraryGeneration;
  const saved=await library.load();
  if (generation!==libraryGeneration) return;
  for (const row of saved.documents) {
    const path=typeof row.path==='string' && normalizePath(row.path);
    if (!path || path.startsWith('範例/') || !isMarkdown(path) || typeof row.source!=='string' || row.source.length>MAX_DOCUMENT_BYTES || documents.has(path)) continue;
    const bytes=textBytes(row.source);
    if (!canStoreDocument({path},bytes)) continue;
    documents.set(path,{path,source:row.source,bytes,name:path.split('/').pop(),revision:typeof row.revision==='string' ? row.revision : newRevision(),pasted:row.pasted===true,...documentLinks(row)});
    const pasted=/^貼上\/(\d+)\//.exec(path);
    if (pasted && Number(pasted[1])<=1e9) pasteCounter=Math.max(pasteCounter,Number(pasted[1]));
  }
  let total=[...assetSizes.values()].reduce((sum,bytes)=>sum+bytes,0);
  for (const row of saved.assets) {
    const path=typeof row.path==='string' && normalizePath(row.path);
    if (!path || path.startsWith('範例/') || !/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path) || assetBlobs.has(path) || !(row.blob instanceof Blob) || row.blob.size>MAX_IMAGE_BYTES || total+row.blob.size>MAX_ASSET_BYTES) continue;
    assetBlobs.set(path,row.blob); assetSizes.set(path,row.blob.size); assets.set(path,URL.createObjectURL(row.blob)); total+=row.blob.size;
  }
  const restorePosition=(position,tab=false)=>{
    const doc=position && documents.get(position.path);
    if (!doc || doc.demo || position.revision!==doc.revision || !Number.isFinite(position.y) || position.y<0 || !Number.isFinite(position.ratio) || position.ratio<0 || position.ratio>1 || !Number.isFinite(position.fraction) || position.fraction<0 || position.fraction>1 || typeof position.anchor!=='string' || position.anchor.length>1000 || !Number.isFinite(position.updatedAt)) return;
    if (tab || position.updatedAt>(readingPositions.get(doc.path)?.updatedAt || 0)) {
      const b=position.block;
      if(b!==undefined && (!b || !Number.isInteger(b.index) || b.index<0 || b.index>1000000 || !Number.isFinite(b.fraction) || b.fraction<0 || b.fraction>1 || (b.gap!==undefined && (!Number.isFinite(b.gap) || b.gap<0 || b.gap>1000000)))) {
        position={...position}; delete position.block;
      }
      if (position.fontSize===undefined && migrationFontSize) {
        position={...position,fontSize:migrationFontSize};
        dirtyPositions.set(doc.path,position);
      }
      readingPositions.set(doc.path,position);
    }
  };
  for (const position of saved.positions) restorePosition(position);
  restorePosition(saved.checkpoint?.position);
  // Validate the tab's snapshot with the same bounds as stored progress. A
  // cleared/replaced library or reimported file cannot revive an old position.
  try {
    const encoded=location.hash.split('&position=')[1];
    const bookmark=encoded?.length<=4096 && JSON.parse(decodeURIComponent(encoded));
    if (bookmark?.epoch===library.epoch && bookmark.position?.path===tabDocumentPath()) {
      const doc=resolveSavedDocument(documents,bookmark.position.path,bookmark.position.revision);
      if (doc) restorePosition({...bookmark.position,path:doc.path},true);
    }
  } catch { /* Invalid/old URLs safely use the saved document position. */ }
  const selected=(saved.checkpoint?.current?.updatedAt || 0)>(saved.current?.updatedAt || 0) ? saved.checkpoint.current : saved.current;
  libraryReady=true;
  const path=resolveSavedDocument(documents,tabDocumentPath())?.path || selected?.path;
  if (resume && documents.has(path)) current=documents.get(path);
  if (!resume) { renderFiles(); renderImages(currentImages); }
}
function resetLibraryMemory() {
  clearTimeout(tabBookmarkTimer); tabBookmarkTimer=undefined;
  libraryGeneration++; resumeTask=undefined; clearTimeout(saveTimer); saveTimer=undefined;
  dirtyDocuments.clear(); dirtyAssets.clear(); dirtyPositions.clear(); readingPositions.clear(); pendingSelection=undefined;
  for (const [path,doc] of documents) if (!doc.demo) documents.delete(path);
  for (const path of [...assetBlobs.keys()]) releaseAsset(path);
  pasteCounter=0; remoteAllowed=false;
  $('file-search').value=''; $('paste-content').value=''; $('paste-name').value='未命名文件.md';
  showDocument(demoDocs[0],{record:false}); renderLibraryStatus();
}
async function clearLibrary() {
  if (clearing || transferBusy) return;
  clearing=true; libraryGeneration++; resumeTask=undefined;
  clearTimeout(saveTimer); saveTimer=undefined; renderLibraryStatus();
  try {
    await library.clear();
    resetLibraryMemory(); libraryReady=true; storageError=undefined; clearFailed=false;
    toast('已刪除此瀏覽器保存的文件、圖片與閱讀進度。');
    health.changed();
  } catch(error) { storageError=error; clearFailed=true; }
  finally { clearing=false; renderLibraryStatus(); }
}

async function syncEditedLibrary() {
  if (dirtyDocuments.size || dirtyAssets.size || importsInFlight) {
    // Keep unsaved imports visible/exportable; silently rehydrating would lose
    // them, while replaying an old edit could resurrect another tab's deletion.
    clearTimeout(saveTimer); saveTimer=undefined;
    storageError=new Error('Unsaved content retained after another tab edited the library');
    storageError.name='LibraryEditConflict'; libraryReady=false;
    renderLibraryStatus(); return;
  }
  const path=current.path,position=readingPositions.get(path);
  libraryReady=false; libraryLoading=true;
  resetLibraryMemory();
  const generation=libraryGeneration;
  try {
    await hydrateLibrary(false);
    if (generation!==libraryGeneration) return;
    const doc=resolveSavedDocument(documents,path,position?.revision) || [...documents.values()].find(doc=>!doc.demo) || demoDocs[0];
    if (position && doc.revision===position.revision) readingPositions.set(doc.path,{...position,path:doc.path});
    libraryLoading=false; storageError=undefined;
    showDocument(doc,{record:false,resume:true});
    toast('文件庫已更新，已保留這個分頁的閱讀位置。');
  } catch(error) { if (generation===libraryGeneration) { storageError=error; libraryLoading=false; renderLibraryStatus(); } }
}

function confirmAction(title,message,label) {
  const dialog=$('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent=title; $('confirm-message').textContent=message; $('confirm-accept').textContent=label;
  dialog.returnValue='cancel'; dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));
}

function selectManagedDocument() {
  const doc=documents.get($('manage-document').value);
  managementPath=doc?.path; managementRevision=doc?.revision;
  $('manage-name').value=doc?.name || ''; $('manage-error').textContent='';
}
function openManagement() {
  if (transferBusy || clearing || libraryLoading || !libraryReady) return;
  updateProgress();
  const select=$('manage-document'); select.replaceChildren();
  for (const doc of documents.values()) if (!doc.demo) {
    const option=document.createElement('option'); option.value=doc.path; option.textContent=doc.path; select.append(option);
  }
  if (!select.options.length) return;
  if (!current.demo) select.value=current.path;
  selectManagedDocument(); $('manage-dialog').showModal();
}
async function editManagedDocument(kind) {
  if (managementBusy || transferBusy || clearing || !managementPath) return;
  if (kind==='delete' && !await confirmAction('刪除這份文件？',`將刪除「${managementPath}」及其閱讀進度。圖片會保留，避免影響其他文件；硬碟上的原始檔不受影響。`,'刪除文件')) return;
  if (transferBusy || clearing || libraryLoading) return;
  updateProgress(); managementBusy=true; transferBusy=true;
  $('manage-rename').disabled=true; $('manage-delete').disabled=true; $('manage-cancel').disabled=true;
  $('manage-error').textContent=''; renderLibraryStatus();
  try {
    for (let i=0;i<3 && hasPendingSave();i++) await flushLibrary();
    if (storageError || hasPendingSave()) throw new Error('文件庫尚未保存。請先重試保存；目前資料仍保留。');
    const snapshot=storedLibrarySnapshot(await library.load());
    if (snapshot.documents.find(doc=>doc.path===managementPath)?.revision!==managementRevision) throw new Error('這份文件已在其他分頁變更，請關閉後重新選擇。');
    const plan=planDocumentEdit({...snapshot,current:current.path},{kind,path:managementPath,name:$('manage-name').value});
    await library.edit({...plan,current:{path:plan.current,updatedAt:Date.now()}},snapshot.revision);
    health.changed();
    await syncEditedLibrary();
    $('manage-dialog').close();
    toast(kind==='rename' ? '已重新命名，圖片、文件連結與閱讀進度皆保留。' : '已刪除文件與其進度，其他文件和圖片仍保留。');
  } catch(error) { $('manage-error').textContent=error.code==='LIBRARY_CHANGED' ? '其他分頁已更新文件庫，這次未變更。請關閉後重新確認。' : ['QuotaExceededError','SecurityError','NotAllowedError'].includes(error.name) ? '操作未完成，原文件與進度仍保留。請先備份，確認瀏覽器允許儲存且空間足夠，再重試。' : error.message || '操作未完成，原資料仍保留。請重試。'; }
  finally {
    managementBusy=false; transferBusy=false;
    for (const id of ['manage-rename','manage-delete','manage-cancel']) $(id).disabled=false;
    renderLibraryStatus();
  }
}

function transferAvailable() {
  if (transferBusy || clearing || libraryLoading || importsInFlight) { toast('文件庫正在處理資料，請稍候再試。'); return false; }
  if (!globalThis.crypto?.subtle) { toast('備份與還原需要 HTTPS、localhost 或解壓縮後的本機版本。'); return false; }
  return true;
}
async function backupLibrary() {
  if (!transferAvailable()) return;
  measureHeadings=true; updateProgress();
  const snapshot={documents:[...documents.values()].filter(doc=>!doc.demo).map(doc=>({...doc})),assets:[...assetBlobs].map(([path,blob])=>({path,blob})),positions:[...readingPositions.values()].filter(position=>position.revision===documents.get(position.path)?.revision),current:current.path};
  const backupToken=health.contentToken();
  transferBusy=true; renderLibraryStatus();
  try {
    const blob=await encodeBackup(snapshot);
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url; link.download=`墨閱文件庫-${new Date().toISOString().slice(0,10)}.inkread`;
    document.body.append(link); link.click(); link.remove();
    health.exported(backupToken);
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    toast('已產生文件庫備份，請確認瀏覽器的下載檔案。');
  } catch { toast('無法產生備份，請保留目前文件並重試。'); }
  finally { transferBusy=false; renderLibraryStatus(); }
}
async function previewRestore(file) {
  if (!file || !transferAvailable()) return;
  measureHeadings=true; updateProgress(); restorePreparing=true;
  transferBusy=true; renderLibraryStatus();
  try {
    restoreSnapshot=await decodeBackup(file);
    await refreshRestoreDestination(true);
    $('restore-mode').value='merge';
    $('restore-summary').textContent=`${file.name}：${restoreSnapshot.documents.length} 份文件、${restoreSnapshot.assets.length} 張圖片、${restoreSnapshot.positions.length} 份閱讀進度。`;
    renderRestoreOptions(); $('restore-dialog').showModal();
  } catch {
    const validBackup=!!restoreSnapshot;
    restoreBase=undefined;
    restoreSnapshot=undefined; transferBusy=false; renderLibraryStatus();
    toast(validBackup ? '目前文件庫尚未保存或無法讀取，請重試保存後再還原。原資料仍保留。' : '無法讀取備份：格式不支援、內容損壞或超過容量限制。目前文件庫未變更。');
  } finally { restorePreparing=false; }
}
async function refreshRestoreDestination(flush) {
  if (flush) {
    for (let attempt=0;attempt<3;attempt++) {
      await flushLibrary();
      if (storageError || !hasPendingSave()) break;
    }
    if (storageError || hasPendingSave()) throw new Error('Existing library not saved');
  }
  restoreBase=storedLibrarySnapshot(await library.load()); restoreChoices.clear();
}
function clearRestorePreviews() { for (const url of restorePreviewURLs.splice(0)) URL.revokeObjectURL(url); }
function restoreVersionLabel(conflict,row,positions) {
  if (conflict.kind==='assets') return `${(row.blob.size/1024).toFixed(1)} KiB`;
  const position=positions.find(position=>position.path===row.path);
  return `${row.source.length.toLocaleString()} 字元，${position ? `已讀 ${Math.round((position.atEnd ? 1 : position.ratio)*100)}%` : '尚無閱讀進度'}`;
}
function renderRestoreOptions() {
  clearRestorePreviews(); $('restore-conflicts').replaceChildren();
  if ($('restore-mode').value==='merge') for (const conflict of restoreConflicts(restoreBase,restoreSnapshot)) {
    const row=document.createElement('div'); row.className='restore-conflict';
    const label=document.createElement('label'); label.textContent=`${conflict.kind==='documents' ? '文件' : '圖片'}：${conflict.path}`;
    const select=document.createElement('select'); select.className='text-input'; select.dataset.kind=conflict.kind; select.dataset.path=conflict.path;
    select.setAttribute('aria-label',`保留版本：${conflict.path}`);
    for (const [value,text] of [['','請選擇要保留的版本'],['existing',`目前版本（${restoreVersionLabel(conflict,conflict.existing,restoreBase.positions)}）`],['backup',`備份版本（${restoreVersionLabel(conflict,conflict.incoming,restoreSnapshot.positions)}）`],['both','保留兩份（自動重新命名備份版本）']]) {
      const option=document.createElement('option'); option.value=value; option.textContent=text; select.append(option);
    }
    select.value=restoreChoices.get(conflict.key) || '';
    select.addEventListener('change',()=>{ restoreChoices.set(conflict.key,select.value); updateRestorePreview(); });
    label.append(select); row.append(label);
    const details=document.createElement('details'),summary=document.createElement('summary');
    summary.textContent=conflict.kind==='documents' ? '比較文件內容與進度' : '比較圖片'; details.append(summary);
    details.addEventListener('toggle',()=>{
      if (!details.open || details.childElementCount>1) return;
      for (const [title,entry] of [['目前版本',conflict.existing],['備份版本',conflict.incoming]]) {
        const heading=document.createElement('h4'); heading.textContent=title; details.append(heading);
        if (conflict.kind==='documents') {
          const pre=document.createElement('pre'); pre.textContent=entry.source.slice(0,2000)+(entry.source.length>2000 ? '\n…（僅預覽前 2,000 字元）' : ''); details.append(pre);
        } else {
          const img=document.createElement('img'),url=URL.createObjectURL(entry.blob); restorePreviewURLs.push(url); img.src=url; img.alt=title; details.append(img);
        }
      }
    });
    row.append(details); $('restore-conflicts').append(row);
  }
  updateRestorePreview();
}
function updateRestorePreview() {
  const mode=$('restore-mode').value,merge=mode==='merge';
  const isolateImages=merge && restoreConflicts(restoreBase,restoreSnapshot).some(row=>row.kind==='documents' && restoreChoices.get(row.key)==='both');
  for (const select of $('restore-conflicts').querySelectorAll('select[data-kind="assets"]')) {
    select.disabled=isolateImages; select.value=isolateImages ? 'both' : restoreChoices.get(`assets:${select.dataset.path}`) || '';
  }
  $('restore-warning').textContent=merge ? `保留目前 ${restoreBase.documents.length} 份文件與 ${restoreBase.assets.length} 張圖片，加入不重複的備份內容。以完整路徑判斷同名衝突，各版本保留自己的閱讀進度。選擇「保留兩份」文件時，同路徑圖片也會自動保留兩份，維持各自的圖片連結。` : `將取代目前 ${restoreBase.documents.length} 份文件、${restoreBase.assets.length} 張圖片與閱讀進度。請先備份目前文件庫；硬碟上的原始文件不受影響。`;
  $('restore-confirm').textContent=merge ? '合併文件庫' : '還原並取代文件庫';
  $('restore-error').textContent=''; $('restore-confirm').disabled=false;
  try {
    const plan=planRestore(restoreBase,restoreSnapshot,mode,restoreChoices);
    $('restore-result').textContent=`完成後：${plan.documents.length} 份文件、${plan.assets.length} 張圖片、${plan.positions.length} 份閱讀進度。`+(plan.renamed.length ? '\n自動重新命名：\n'+plan.renamed.map(row=>`${row.from} → ${row.to}`).join('\n') : '');
  } catch(error) {
    $('restore-result').textContent=error.message; $('restore-confirm').disabled=true;
  }
}
async function restoreLibrary() {
  if (!restoreSnapshot || !restoreBase || restoreCommitting || $('restore-confirm').disabled) return;
  restoreCommitting=true; $('restore-confirm').disabled=true; $('restore-cancel').disabled=true;
  $('restore-options').disabled=true;
  $('restore-error').textContent=''; renderLibraryStatus();
  let committed=false;
  try {
    const snapshot=planRestore(restoreBase,restoreSnapshot,$('restore-mode').value,restoreChoices);
    clearing=true; libraryGeneration++;
    const restoredDocuments=snapshot.documents,positions=snapshot.positions;
    const selected=snapshot.current || restoredDocuments[0]?.path || demoDocs[0].path;
    await library.replace({documents:restoredDocuments,assets:snapshot.assets,positions,current:{path:selected,updatedAt:Date.now()}},restoreBase.revision);
    committed=true;
    health.changed();
    resetLibraryMemory();
    for (const doc of restoredDocuments) {
      documents.set(doc.path,doc);
      const pasted=/^貼上\/(\d+)\//.exec(doc.path);
      if (pasted && Number(pasted[1])<=1e9) pasteCounter=Math.max(pasteCounter,Number(pasted[1]));
    }
    for (const {path,blob} of snapshot.assets) { assetBlobs.set(path,blob); assetSizes.set(path,blob.size); assets.set(path,URL.createObjectURL(blob)); }
    for (const position of positions) readingPositions.set(position.path,position);
    libraryReady=true; storageError=undefined; clearFailed=false;
    showDocument(documents.get(selected) || demoDocs[0],{record:false,resume:true});
    restoreCommitting=false; $('restore-dialog').close();
    toast('已還原文件、圖片與閱讀進度，可離線接續閱讀。');
  } catch(error) {
    if (['LIBRARY_CHANGED','LIBRARY_CLEARED'].includes(error.code)) {
      try {
        await refreshRestoreDestination(false); renderRestoreOptions();
        $('restore-error').textContent='其他分頁已更新文件庫，尚未還原。已重新檢查，請再次確認並選擇衝突版本。';
      } catch { $('restore-error').textContent='無法重新讀取文件庫，請取消後重試。原資料仍保留。'; }
    } else $('restore-error').textContent=committed ? '資料已保存，請重新開啟墨閱以讀取還原的文件庫。' : '還原未完成，原文件庫仍保留。請確認瀏覽器允許儲存且空間足夠，再重試。';
  } finally {
    clearing=false; restoreCommitting=false;
    if (restoreBase && restoreSnapshot) {
      try { planRestore(restoreBase,restoreSnapshot,$('restore-mode').value,restoreChoices); $('restore-confirm').disabled=false; } catch { $('restore-confirm').disabled=true; }
    }
    $('restore-options').disabled=false; $('restore-cancel').disabled=false; renderLibraryStatus();
  }
}
const blockSelector='p,li,pre,table,h1,h2,h3,h4,h5,h6,.mermaid-container';
function documentBlocks() {
  return [...$('document').querySelectorAll(blockSelector)].filter(el=>!el.parentElement.closest(blockSelector));
}
function cachedReadingBlock(y) {
  let low=0,high=blockPositions.length;
  while(low<high) { const middle=(low+high)>>>1; if(blockPositions[middle].top<=y) low=middle+1; else high=middle; }
  const index=Math.max(0,low-1),rect=blockPositions[index];
  if(rect) { const gap=Math.max(0,y-rect.top-rect.height);return {index,fraction:Math.max(0,Math.min(1,(y-rect.top)/Math.max(1,rect.height))),...(gap ? {gap} : {})}; }
}
function readingBlock(y) {
  const blocks=documentBlocks();
  let low=0,high=blocks.length;
  while (low<high) {
    const middle=(low+high)>>>1;
    if (blocks[middle].getBoundingClientRect().top+scrollY<=y) low=middle+1;
    else high=middle;
  }
  const element=blocks[Math.max(0,low-1)];
  if (!element) return;
  const rect=element.getBoundingClientRect();
  return {element,fraction:Math.max(0,Math.min(1,(y-rect.top-scrollY)/Math.max(1,rect.height))),gap:Math.max(0,y-rect.top-scrollY-rect.height)};
}
function blockTarget(point) {
  const rect=point.element.getBoundingClientRect();
  return rect.top+scrollY+point.fraction*rect.height+(point.gap || 0)-150;
}
async function resumePosition(position,task) {
  try {
    await renderAllFeatures();
    await Promise.race([Promise.allSettled([...$('document').querySelectorAll('img')].map(img=>img.decode())),new Promise(resolve=>setTimeout(resolve,5000))]);
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if (resumeTask!==task || task.version!==renderVersion) return;
    const index=activeHeadings.findIndex(heading=>heading.id===position.anchor);
    const targetAtSize=()=>{
      if (index<0) return position.ratio*Math.max(0,document.documentElement.scrollHeight-innerHeight);
      const top=activeHeadings[index].getBoundingClientRect().top+scrollY;
      const end=activeHeadings[index+1] ? activeHeadings[index+1].getBoundingClientRect().top+scrollY : document.documentElement.scrollHeight;
      return top+position.fraction*Math.max(1,end-top)-150;
    };
    const block=position.block,element=block && documentBlocks()[block.index];
    let point=element ? {element,fraction:block.fraction,gap:block.gap} : undefined;
    if (!point && !position.atEnd && Number.isInteger(position.fontSize) && position.fontSize>=13 && position.fontSize<=22 && position.fontSize!==fontSize) {
      // Reconstruct the saved layout before interpreting its section fraction.
      // Reflow can change different paragraphs by different amounts.
      try {
        document.documentElement.style.setProperty('--reader-size',`${position.fontSize}px`);
        point=readingBlock(targetAtSize()+150);
      } finally { document.documentElement.style.setProperty('--reader-size',`${fontSize}px`); }
    }
    const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);
    const target=point ? blockTarget(point) : targetAtSize();
    window.scrollTo({top:position.atEnd ? max : Math.max(0,Math.min(max,target)),behavior:'instant'});
    if(element && !position.atEnd) restoredBlock={version:renderVersion,y:scrollY,block:position.block};
  } catch {
    if (resumeTask===task && task.version===renderVersion) window.scrollTo({top:position.y,behavior:'instant'});
  } finally {
    if (resumeTask===task) { resumeTask=undefined; measureHeadings=true; updateProgress(); renderLibraryStatus(); }
  }
}

function preference(key, value) {
  try {
    if (value !== undefined) localStorage.setItem(`inkread-${key}`, value);
    else return localStorage.getItem(`inkread-${key}`);
  } catch { /* Storage can be disabled for local files. */ }
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
}

function configureMermaid(mermaid) {
  const dark = document.documentElement.dataset.theme === 'dark';
  mermaid.initialize({startOnLoad:false, htmlLabels:false, securityLevel:'strict', suppressErrorRendering:true, theme:'base', fontFamily:'"Segoe UI", "Microsoft JhengHei", sans-serif', maxTextSize:50000, maxEdges:500, themeVariables:{primaryColor:dark ? '#2f4b38' : '#e4eee2', primaryTextColor:dark ? '#e4eee2' : '#294436', primaryBorderColor:dark ? '#73947c' : '#9fb69c', lineColor:dark ? '#88a894' : '#6b8a75', secondaryColor:dark ? '#263e32' : '#f3f5ed', tertiaryColor:dark ? '#25372a' : '#eef1e7', background:dark ? '#232d25' : '#f1f3ec', mainBkg:dark ? '#2f4b38' : '#e4eee2', nodeBorder:dark ? '#73947c' : '#9fb69c', textColor:dark ? '#e4eee2' : '#294436', actorTextColor:dark ? '#e4eee2' : '#294436', actorBkg:dark ? '#2f4b38' : '#e4eee2', actorBorder:dark ? '#73947c' : '#9fb69c', signalColor:dark ? '#ced7ce' : '#294436', signalTextColor:dark ? '#ced7ce' : '#294436', noteBkgColor:dark ? '#33402d' : '#edf0df', noteTextColor:dark ? '#e4eee2' : '#294436', noteBorderColor:dark ? '#73947c' : '#9fb69c', fontSize:'14px'}, flowchart:{htmlLabels:false, useMaxWidth:true}, sequence:{useMaxWidth:true}});
}

function setTheme(theme, rerender = true) {
  document.documentElement.dataset.theme = theme;
  preference('theme', theme);
  $('theme-toggle').innerHTML = `<i data-lucide="${theme === 'dark' ? 'sun' : 'moon'}"></i>`;
  const label = theme === 'dark' ? '切換淺色模式' : '切換深色模式';
  $('theme-toggle').title = label;
  $('theme-toggle').setAttribute('aria-label',label);
  if (rerender) showDocument(current, {preserveScroll:true});
  refreshIcons();
}

function setFont(size, manual = false) {
  let position;
  if(manual) {
    updateProgress();
    position={block:readingPositions.get(current.path)?.block || cachedReadingBlock(scrollY+150),atStart:scrollY<5,atEnd:scrollY+innerHeight>=document.documentElement.scrollHeight-5};
  }
  fontSize = Math.min(22, Math.max(13,size));
  document.documentElement.style.setProperty('--reader-size', `${fontSize}px`);
  $('font-size').textContent = fontSize;
  $('font-minus').disabled = fontSize <= 13;
  $('font-plus').disabled = fontSize >= 22;
  if (manual) preference('font-size-choice',String(fontSize));
  preference('font-size',String(fontSize));
  measureHeadings=true;
  if(position?.block && readingBlocks[position.block.index]) {
    updateTables();
    const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);
    window.scrollTo({top:position.atStart ? 0 : position.atEnd ? max : Math.max(0,Math.min(max,blockTarget({element:readingBlocks[position.block.index],...position.block}))),behavior:'instant'});
    if(!position.atEnd && !position.atStart) restoredBlock={version:renderVersion,y:scrollY,block:position.block};
    updateProgress();
  } else requestAnimationFrame(updateTables);
}

let demoOpenBeforeSearch;
function renderFiles() {
  const search = $('file-search').value.trim().toLocaleLowerCase();
  $('demo-files').replaceChildren();
  $('user-files').replaceChildren();
  let userCount = 0;
  let filteredCount = 0;
  const rows=[...documents.values()],sort=$('file-sort').value;
  if (sort==='name') rows.sort((a,b)=>a.path.localeCompare(b.path,'zh-Hant'));
  if (sort==='recent') rows.sort((a,b)=>(readingPositions.get(b.path)?.updatedAt || 0)-(readingPositions.get(a.path)?.updatedAt || 0));
  for (const doc of rows) {
    if (!doc.demo) userCount++;
    if (search && !doc.path.toLocaleLowerCase().includes(search)) continue;
    if (!doc.demo) filteredCount++;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `file-item${current.path === doc.path ? ' active' : ''}`;
    button.title = doc.path;
    if (current.path === doc.path) button.setAttribute('aria-current','page');
    const icon = document.createElement('i');
    icon.dataset.lucide = doc.icon || 'file-text';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = doc.name;
    button.append(icon,name);
    button.addEventListener('click', () => {
      showDocument(doc);
      document.body.classList.remove('sidebar-mobile-open');
    });
    (doc.demo ? $('demo-files') : $('user-files')).append(button);
  }
  $('file-count').textContent = String(userCount).padStart(2,'0');
  $('clear-files').hidden = !userCount && !assetBlobs.size;
  const demoSection=$('demo-section'),demoMatches=$('demo-files').childElementCount;
  if (search) {
    if (demoOpenBeforeSearch===undefined) demoOpenBeforeSearch=demoSection.open;
    demoSection.hidden=!demoMatches; demoSection.open=demoMatches>0;
  } else {
    demoSection.hidden=false;
    if (demoOpenBeforeSearch!==undefined) { demoSection.open=demoOpenBeforeSearch; demoOpenBeforeSearch=undefined; }
  }
  $('empty-files').hidden = filteredCount > 0 || !!(search && demoMatches);
  $('empty-files').textContent = search ? '沒有符合的文件。' : userCount ? '沒有符合的文件。' : '把散落的想法，\n放進同一個閱讀空間。';
  refreshIcons();
}

function imagePlaceholder(entry, reason, allow = false) {
  const holder = document.createElement('span');
  holder.className = 'image-placeholder';
  const icon = document.createElement('i');
  icon.dataset.lucide = 'image-off';
  const details = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = entry.alt || '文件圖片';
  const info = document.createElement('span');
  info.textContent = reason;
  details.append(title,info);
  if (allow) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '允許此文件載入遠端圖片';
    button.addEventListener('click', () => { remoteAllowed = true; renderImages(currentImages); refreshIcons(); });
    details.append(document.createElement('br'),button);
  }
  holder.append(icon,details);
  return holder;
}

function renderImages(entries) {
  for (const slot of $('document').querySelectorAll('[data-image-index]')) {
    const entry = entries[Number(slot.dataset.imageIndex)];
    if (!entry) continue;
    const kind = imageKind(entry.src);
    let src;
    let replacement;
    if (kind === 'remote' && !remoteAllowed) {
      replacement = imagePlaceholder(entry,'此圖片需要連線；文件目前不會對外取得圖片。',true);
    } else if (kind === 'blocked') {
      replacement = imagePlaceholder(entry,'此圖片使用不支援的網址格式。');
    } else if (kind === 'local') {
      const path = resolveDocumentPath(current,entry.src);
      src = path && assets.get(path);
      if (!src) replacement = imagePlaceholder(entry,'找不到本機圖片。請匯入包含文件與圖片的共同上層資料夾。');
    } else src = kind === 'remote' && entry.src.startsWith('//') ? `https:${entry.src}` : entry.src;
    if (src) {
      const image = document.createElement('img');
      image.src = src;
      image.alt = entry.alt;
      image.title = entry.title;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('load', updateProgress);
      image.addEventListener('error', () => {
        const fallback = imagePlaceholder(entry, '圖片無法載入，請確認檔案或連線。');
        fallback.dataset.imageIndex = slot.dataset.imageIndex;
        image.replaceWith(fallback);
        refreshIcons();
      }, {once:true});
      replacement = image;
    }
    replacement.dataset.imageIndex = slot.dataset.imageIndex;
    slot.replaceWith(replacement);
  }
}

function updateTables() {
  for (const container of $('document').querySelectorAll('.table-container')) {
    const scroll = container.querySelector('.table-scroll');
    const table = scroll.querySelector('table');
    table.classList.toggle('wide-table', table.rows[0]?.cells.length > 6);
    const wide = scroll.scrollWidth > scroll.clientWidth + 1;
    scroll.tabIndex = wide ? 0 : -1;
    let hint = container.querySelector('.table-hint');
    if (wide && !hint) {
      hint = document.createElement('div');
      hint.className = 'table-hint';
      hint.innerHTML = '<i data-lucide="arrow-left-right"></i><span>左右捲動，查看完整表格</span>';
      container.append(hint);
    }
    if (hint) hint.hidden = !wide;
  }
  refreshIcons();
}

function buildTOC() {
  const headings = [...$('document').querySelectorAll('h1,h2,h3,h4,h5,h6')];
  document.title = `${headings[0]?.textContent || current.name} · 墨閱 Inkread`;
  const tocHeadings = headings.filter(el => el.tagName === 'H2' || el.tagName === 'H3');
  activeHeadings = tocHeadings.length ? tocHeadings : headings;
  tocLinks = [];
  activeHeadingIndex = -1;
  measureHeadings = true;
  $('toc-links').replaceChildren();
  for (const heading of activeHeadings) {
    const link = document.createElement('a');
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.textContent = heading.textContent;
    link.className = `level-${heading.tagName.slice(1)}`;
    link.addEventListener('click', e => {
      e.preventDefault();
      heading.scrollIntoView({block:'start'});
      document.body.classList.remove('toc-open');
      requestAnimationFrame(updateProgress);
    });
    $('toc-links').append(link);
    tocLinks.push(link);
  }
  if (!activeHeadings.length) {
    const text = document.createElement('span');
    text.textContent = '此文件尚無標題';
    text.style.cssText = 'color:var(--muted);padding-left:14px';
    $('toc-links').append(text);
  }
}

function scheduleProgress() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => { progressFrame = 0; updateProgress(); });
}

function updateProgress() {
  const article = $('document');
  const top = window.scrollY + article.getBoundingClientRect().top;
  const articleHeight=article.offsetHeight;
  const changed=layoutWidth!==innerWidth || layoutHeight!==innerHeight;
  const saved=changed && !resumeTask && displayedDocument===current && readingPositions.get(current.path);
  if(changed || Math.abs(top-layoutTop)>.5 || articleHeight!==layoutArticleHeight) measureHeadings=true;
  if (measureHeadings) {
    readingBlocks=documentBlocks();
    blockPositions=readingBlocks.map(el=>{const r=el.getBoundingClientRect();return {top:r.top+scrollY,height:r.height};});
    headingPositions = activeHeadings.map(heading => heading.getBoundingClientRect().top + window.scrollY);
    layoutWidth=innerWidth; layoutHeight=innerHeight;
    layoutTop=top;
    layoutArticleHeight=articleHeight;
    measureHeadings = false;
  }
  if(saved && saved.revision===current.revision && saved.block && readingBlocks[saved.block.index]) {
    const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);
    window.scrollTo({top:saved.atEnd ? max : Math.max(0,Math.min(max,blockTarget({element:readingBlocks[saved.block.index],fraction:saved.block.fraction,gap:saved.block.gap}))),behavior:'instant'});
    if(!saved.atEnd) restoredBlock={version:renderVersion,y:scrollY,block:saved.block};
  }
  const length = Math.max(1, articleHeight - window.innerHeight + 100);
  const progress = Math.max(0, Math.min(100, (window.scrollY - top + 100) / length * 100));
  const finished = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 5;
  const percent = finished ? 100 : Math.round(progress);
  $('progress-bar').style.width = `${percent}%`;
  $('toc-progress').style.width = `${percent}%`;
  $('reading-percent').textContent = `${percent}%`;
  let low = 0, high = headingPositions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (headingPositions[middle] <= window.scrollY + 150) low = middle + 1;
    else high = middle;
  }
  const next = headingPositions.length ? Math.max(0,low - 1) : -1;
  if (next !== activeHeadingIndex) {
    const previous = tocLinks[activeHeadingIndex];
    previous?.classList.remove('active');
    previous?.removeAttribute('aria-current');
    const selected = tocLinks[next];
    selected?.classList.add('active');
    selected?.setAttribute('aria-current','location');
    activeHeadingIndex = next;
  }
  rememberPosition();
}

async function renderDiagrams(diagrams, version) {
  if (!diagrams.length || version !== renderVersion) return;
  let mermaid;
  try {
    // Mermaid may decode math delimiters from entities; share a ready KaTeX instance.
    [mermaid] = await Promise.all([loadVendor('diagrams'),loadVendor('math')]);
    if (version !== renderVersion) return;
    configureMermaid(mermaid);
  } catch { mermaid = undefined; /* Each diagram retains its source if feature files are missing. */ }
  for (let index = 0; index < diagrams.length; index++) {
    if (version !== renderVersion) return;
    const container = $('document').querySelector(`[data-diagram-index="${index}"]`);
    if (!container) continue;
    try {
      const {svg} = await mermaid.render(`ink-diagram-${version}-${index}`, safeDiagramSource(diagrams[index]));
      if (version !== renderVersion) return;
      container.innerHTML = sanitizeDiagram(svg);
      const rendered = container.querySelector('svg');
      if (rendered) { rendered.setAttribute('role','img'); rendered.setAttribute('aria-label','Mermaid 圖表'); }
    } catch {
      if (version !== renderVersion) return;
      container.className = 'render-error';
      container.removeAttribute('role');
      const text = document.createElement('p');
      text.textContent = '圖表無法繪製，請確認 Mermaid 語法；圖表中的外部資源已停用。原始內容如下：';
      const pre = document.createElement('pre');
      pre.textContent = diagrams[index];
      container.replaceChildren(text,pre);
    }
  }
  if (version === renderVersion) updateProgress();
}

async function renderFormulas(formulas,version) {
  if (!formulas.length || version !== renderVersion) return;
  let katex;
  try { katex = await loadVendor('math'); } catch { /* Retain readable source. */ }
  if (version !== renderVersion) return;
  for (const slot of $('document').querySelectorAll('[data-math-index]')) {
    const formula = formulas[Number(slot.dataset.mathIndex)];
    if (!formula) continue;
    try {
      slot.innerHTML = sanitizeFormula(katex.renderToString(formula.source,formula.options));
      slot.classList.remove('pending-math');
    } catch {
      slot.textContent = formula.source;
      slot.title = '公式無法繪製，已保留原始內容。';
    }
    delete slot.dataset.mathIndex;
  }
  scheduleProgress();
}

function prepareFeatures(rendered,version) {
  featureObservers.forEach(observer=>observer.disconnect());
  featureObservers = [];
  let diagramTask, formulaTask;
  const startDiagrams = () => {
    if (!diagramTask) {
      // Mermaid has shared state, so keep renders serialized across documents.
      diagramTask = activeRender = activeRender.catch(()=>{}).then(()=>renderDiagrams(rendered.diagrams,version));
    }
    return diagramTask;
  };
  const startFormulas = () => formulaTask ??= renderFormulas(rendered.formulas || [],version);
  const watch = (selector,start) => {
    const targets = $('document').querySelectorAll(selector);
    if (!targets.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry=>entry.isIntersecting)) { observer.disconnect(); start(); }
    },{rootMargin:'300px 0px'});
    targets.forEach(target=>observer.observe(target));
    featureObservers.push(observer);
  };
  renderAllFeatures = () => Promise.all([startDiagrams(),startFormulas()]);
  watch('[data-diagram-index]',startDiagrams);
  watch('[data-math-index]',startFormulas);
}

function showDocument(doc, {preserveScroll = false, anchor = '',record = true,resume = record} = {}) {
  if (record) updateProgress();
  resumeTask=undefined;
  if (current !== doc) remoteAllowed = false;
  current = doc;
  // An invalidated tab temporarily displays the guide until it reloads the
  // new library. Keep its real file URL instead of bookmarking that placeholder.
  if (libraryReady || record) rememberTabDocument();
  const version = ++renderVersion;
  const position=resume && !preserveScroll && !anchor && readingPositions.get(doc.path);
  if (position && position.revision===doc.revision && position.y>5) resumeTask={version};
  const scrollPosition = window.scrollY;
  let rendered;
  try { rendered = renderMarkdown(doc.source); } catch {
    $('document').textContent = doc.source;
    toast('部分語法無法解析，已顯示原始文字。');
    rendered = {images:[],diagrams:[]};
  }
  if (rendered.html !== undefined) $('document').innerHTML = rendered.html;
  currentImages = rendered.images;
  $('current-file').textContent = doc.name;
  $('doc-origin').textContent = doc.demo ? '墨閱使用指南' : doc.pasted ? '貼上的文件' : '本機文件';
  const count = doc.source.replace(/\s/g,'').length;
  $('word-count').textContent = `${count.toLocaleString()} 字元`;
  $('reading-time').textContent = `約 ${Math.max(1,Math.ceil(count / 500))} 分鐘`;
  renderFiles();
  renderImages(rendered.images);
  for (const link of $('document').querySelectorAll('a')) {
    if (/^https?:|^mailto:/i.test(link.getAttribute('href') || '')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  buildTOC();
  updateTables();
  if (!preserveScroll) window.scrollTo({top:0,behavior:'instant'});
  else window.scrollTo({top:scrollPosition,behavior:'instant'});
  refreshIcons();
  prepareFeatures(rendered,version);
  displayedDocument=doc;
  if (record) {
    selectForSaving();
    // A browser can terminate before unload or the deferred IndexedDB write.
    // Save the selection with its existing position, including a pending restore.
    checkpointLibrary();
  }
  if (anchor) renderAllFeatures().then(() => { if (version === renderVersion) jumpToAnchor(anchor); });
  if (resumeTask) void resumePosition(position,resumeTask);
  updateProgress();
  renderLibraryStatus();
}

function jumpToAnchor(anchor) {
  let id;
  try { id = decodeURIComponent(anchor.replace(/^#/,'')); } catch { return; }
  const heading = document.getElementById(id);
  if (heading && $('document').contains(heading)) heading.scrollIntoView({block:'start'});
  else toast('此文件找不到對應的章節。');
}

function releaseAsset(path) {
  const url = assets.get(path);
  if (url && !path.startsWith('範例/')) URL.revokeObjectURL(url);
  assets.delete(path);
  assetSizes.delete(path);
  assetBlobs.delete(path);
}

function canStoreDocument(doc, bytes) {
  if (bytes > MAX_DOCUMENT_BYTES) return false;
  let count = documents.has(doc.path) ? 0 : 1;
  let total = bytes;
  for (const stored of documents.values()) {
    if (stored.demo) continue;
    count++;
    if (stored.path !== doc.path) total += stored.bytes;
  }
  return count <= MAX_DOCUMENTS && total <= MAX_TEXT_BYTES;
}

async function importFiles(fileEntries) {
  if (clearing || transferBusy || libraryLoading) { toast('文件庫正在處理資料，請稍候再匯入。'); return; }
  importsInFlight++;
  try {
  const generation=libraryGeneration;
  const added = [];
  let assetCount = 0;
  let failures = 0;
  let skipped = Math.max(0,fileEntries.length - MAX_IMPORT_FILES);
  for (const entry of fileEntries.slice(0,MAX_IMPORT_FILES)) {
    const file = entry.file || entry;
    let path = normalizePath(entry.path || file.webkitRelativePath || file.name);
    if (!path) continue;
    // Keep bundled examples separate from user-provided paths.
    if (path.startsWith('範例/')) path = `匯入/${path}`;
    if (isMarkdown(path)) {
      if (file.size > MAX_DOCUMENT_BYTES || !canStoreDocument({path},file.size)) { skipped++; continue; }
      try {
        const source = (await file.text()).replace(/^\uFEFF/,'');
        if (generation!==libraryGeneration) return;
        const bytes = textBytes(source);
        const previous=documents.get(path);
        const revision=previous?.source===source ? previous.revision : newRevision();
        const doc = {path, source, bytes, name:path.split('/').pop(),revision};
        if (!canStoreDocument(doc,bytes)) { skipped++; continue; }
        if (previous?.revision!==revision) { readingPositions.delete(path); dirtyPositions.delete(path); }
        documents.set(path,doc);
        dirtyDocuments.set(path,doc);
        added.push(doc);
      } catch { failures++; }
    } else if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path)) {
      const retainedBytes = [...assetSizes.values()].reduce((sum,size)=>sum+size,0) - (assetSizes.get(path) || 0);
      if (file.size > MAX_IMAGE_BYTES || retainedBytes + file.size > MAX_ASSET_BYTES || (!assetBlobs.has(path) && assetBlobs.size>=MAX_IMPORT_FILES)) { skipped++; continue; }
      const mime = file.type || ({svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon'})[path.split('.').pop().toLowerCase()];
      releaseAsset(path);
      const blob=new Blob([file], {type:mime});
      assets.set(path,URL.createObjectURL(blob)); assetBlobs.set(path,blob);
      dirtyAssets.set(path,{path,blob});
      assetSizes.set(path,file.size);
      assetCount++;
    }
  }
  if (added.length) {
    $('file-search').value = '';
    showDocument(added[0]);
    toast(`已開啟 ${added.length} 份文件${assetCount ? `，載入 ${assetCount} 張圖片` : ''}${failures ? `；${failures} 份檔案無法讀取` : ''}${skipped ? `；${skipped} 份超過容量或數量限制已略過` : ''}。`);
    document.body.classList.remove('sidebar-mobile-open');
  } else if (assetCount) {
    renderFiles();
    renderImages(currentImages);
    refreshIcons();
    toast(`已載入 ${assetCount} 張圖片${skipped ? `；${skipped} 份超過容量或數量限制已略過` : ''}。`);
  } else toast(skipped ? '超過匯入限制：單份文件 2 MiB、文件共 200 份／20 MiB、圖片單張 20 MiB／共 100 MiB、每次 1,000 份檔案。' : failures ? '檔案無法讀取，請重新選取。' : '沒有找到 Markdown 文件。支援 .md、.markdown 與 .txt。');
  if (added.length || assetCount) { health.changed(); await flushLibrary(); }
  } finally { importsInFlight--; }
}

async function readDirectoryEntry(entry, result, parent = '') {
  const path = parent + entry.name;
  if (entry.isFile) {
    if (!isMarkdown(path) && !/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path)) return;
    if (result.length >= MAX_IMPORT_FILES) throw new Error('Too many files');
    const file = await new Promise((resolve,reject) => entry.file(resolve,reject));
    result.push({file,path});
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve,reject) => reader.readEntries(resolve,reject));
      for (const child of batch) await readDirectoryEntry(child,result,`${path}/`);
    } while (batch.length);
  }
}

function openPaste(content) {
  if (transferBusy || clearing) { toast('文件庫正在處理資料，請稍候。'); return; }
  if (typeof content === 'string') $('paste-content').value = content;
  $('paste-count').textContent = `${$('paste-content').value.length.toLocaleString()} 字元`;
  $('paste-dialog').showModal();
  $('paste-content').focus();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else throw new Error('fallback');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;left:-10000px;top:0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Copy unavailable');
  }
}

$('open-button').addEventListener('click', () => $('file-input').click());
$('sidebar-open').addEventListener('click', () => $('file-input').click());
$('folder-button').addEventListener('click', () => $('folder-input').click());
for (const id of ['file-input','folder-input']) $(id).addEventListener('change', async event => {
  const files = [...event.target.files];
  event.target.value = '';
  await importFiles(files);
});
$('file-search').addEventListener('input',renderFiles);
$('clear-files').addEventListener('click',async()=>{
  if (transferBusy || clearing || libraryLoading) return;
  if (await confirmAction('清除整個文件庫？',`將刪除 ${[...documents.values()].filter(doc=>!doc.demo).length} 份文件、${assetBlobs.size} 張圖片與全部閱讀進度，並同步到其他墨閱分頁。請先備份重要資料；硬碟上的原始檔不受影響。`,'清除文件庫')) await clearLibrary();
});
$('manage-library').addEventListener('click',openManagement);
$('manage-document').addEventListener('change',selectManagedDocument);
$('manage-name').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void editManagedDocument('rename');}});
$('manage-rename').addEventListener('click',()=>void editManagedDocument('rename'));
$('manage-delete').addEventListener('click',()=>void editManagedDocument('delete'));
$('manage-dialog').addEventListener('cancel',event=>{if (managementBusy) event.preventDefault();});
$('file-sort').value=['imported','name','recent'].includes(preference('file-sort')) ? preference('file-sort') : 'imported';
$('file-sort').addEventListener('change',()=>{preference('file-sort',$('file-sort').value);renderFiles();});
$('backup-library').addEventListener('click',()=>{ void backupLibrary(); });
$('support-button').addEventListener('click',()=>{
  $('diagnostic-content').value=JSON.stringify(health.diagnostic(),null,2); $('diagnostic-copy').textContent='複製診斷資訊'; $('support-dialog').showModal();
});
$('diagnostic-copy').addEventListener('click',async()=>{
  try { await copyText($('diagnostic-content').value); $('diagnostic-copy').textContent='已複製'; }
  catch { toast('無法自動複製，請選取診斷文字後手動複製。'); }
});
$('restore-library').addEventListener('click',()=>{ if (transferAvailable()) $('backup-input').click(); });
$('backup-input').addEventListener('change',event=>{
  const file=event.target.files[0]; event.target.value=''; void previewRestore(file);
});
$('restore-confirm').addEventListener('click',()=>{ void restoreLibrary(); });
$('restore-mode').addEventListener('change',renderRestoreOptions);
$('restore-dialog').addEventListener('cancel',event=>{ if (restoreCommitting) event.preventDefault(); });
$('restore-dialog').addEventListener('close',()=>{
  clearRestorePreviews(); restoreChoices.clear(); restoreBase=undefined; restoreSnapshot=undefined; transferBusy=false; renderLibraryStatus(); scheduleProgress();
});
$('library-retry').addEventListener('click',()=>{
  if (clearFailed) void clearLibrary();
  else { storageError=undefined; void flushLibrary(); }
});
$('paste-button').addEventListener('click', () => openPaste());
$('paste-content').addEventListener('input', () => { $('paste-count').textContent = `${$('paste-content').value.length.toLocaleString()} 字元`; });
$('paste-submit').addEventListener('click', () => {
  if (clearing || transferBusy) { toast('文件庫正在處理資料，請稍候。'); return; }
  const source = $('paste-content').value;
  if (!source.trim()) { $('paste-content').focus(); toast('先貼上一些文字，再開始閱讀。'); return; }
  let name = $('paste-name').value.trim() || '未命名文件.md';
  name = name.replace(/[\\/]/g,'-');
  if (!isMarkdown(name)) name += '.md';
  if (source.length > MAX_DOCUMENT_BYTES) { toast('單份文件上限為 2 MiB，請先分割內容。'); return; }
  const bytes = textBytes(source);
  const doc = {path:`貼上/${pasteCounter + 1}/${name}`, name, source, bytes, pasted:true,revision:newRevision()};
  if (!canStoreDocument(doc,bytes)) { toast('超過容量限制：單份文件 2 MiB、文件共 200 份／20 MiB。'); return; }
  pasteCounter++;
  documents.set(doc.path,doc);
  dirtyDocuments.set(doc.path,doc);
  health.changed();
  $('paste-dialog').close();
  $('file-search').value = '';
  showDocument(doc);
  document.body.classList.remove('sidebar-mobile-open');
  void flushLibrary();
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', e => { if (e.target === dialog && !(dialog.id==='restore-dialog' && restoreCommitting) && !(dialog.id==='manage-dialog' && managementBusy)) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
$('brand-home').addEventListener('click', e => { e.preventDefault(); $('file-search').value = ''; showDocument(demoDocs[0]); });
$('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('font-minus').addEventListener('click', () => setFont(fontSize - 1, true));
$('font-plus').addEventListener('click', () => setFont(fontSize + 1, true));
$('print-button').addEventListener('click', async () => {
  $('print-button').disabled = true;
  await renderAllFeatures();
  const images = [...$('document').querySelectorAll('img')];
  images.forEach(img => { img.loading = 'eager'; });
  await Promise.race([Promise.allSettled(images.map(img => img.decode())),new Promise(resolve => setTimeout(resolve,5000))]);
  await document.fonts.ready;
  $('print-button').disabled = false;
  window.print();
});
$('sidebar-toggle').addEventListener('click', () => {
  const mobile = matchMedia('(max-width:720px)').matches;
  if (mobile) document.body.classList.toggle('sidebar-mobile-open');
  else document.body.classList.toggle('sidebar-collapsed');
  $('sidebar-toggle').setAttribute('aria-expanded',String(mobile ? document.body.classList.contains('sidebar-mobile-open') : !document.body.classList.contains('sidebar-collapsed')));
  requestAnimationFrame(updateTables);
});
$('toc-toggle').addEventListener('click', () => {
  const narrow = matchMedia('(max-width:1000px)').matches;
  if (narrow) document.body.classList.toggle('toc-open');
  else document.body.classList.toggle('toc-hidden');
  $('toc-toggle').setAttribute('aria-expanded',String(narrow ? document.body.classList.contains('toc-open') : !document.body.classList.contains('toc-hidden')));
  requestAnimationFrame(updateTables);
});
document.addEventListener('click', e => {
  if (document.body.classList.contains('sidebar-mobile-open') && !$('sidebar').contains(e.target) && !$('sidebar-toggle').contains(e.target)) document.body.classList.remove('sidebar-mobile-open');
  if (document.body.classList.contains('toc-open') && !$('toc').contains(e.target) && !$('toc-toggle').contains(e.target)) document.body.classList.remove('toc-open');
});
$('back-top').addEventListener('click', () => window.scrollTo({top:0}));
$('document').addEventListener('click', async e => {
  const copy = e.target.closest('.copy-code');
  if (copy) {
    try {
      await copyText(copy.closest('.code-block').querySelector('code').textContent);
      copy.innerHTML = '<i data-lucide="check"></i><span>已複製</span>';
      refreshIcons();
      setTimeout(() => { if (copy.isConnected) { copy.innerHTML = '<i data-lucide="copy"></i><span>複製</span>'; refreshIcons(); } },2000);
    } catch { toast('瀏覽器無法存取剪貼簿，請選取程式碼後手動複製。'); }
    return;
  }
  const link = e.target.closest('a');
  if (!link) return;
  const href = link.getAttribute('href') || '';
  if (/^https?:|^mailto:/i.test(href)) return;
  e.preventDefault();
  if (href.startsWith('#')) { jumpToAnchor(href); return; }
  if (href.startsWith('//')) { window.open(`https:${href}`,'_blank','noopener,noreferrer'); return; }
  const path = resolveDocumentPath(current,href);
  const doc = path && documents.get(path);
  if (doc) showDocument(doc,{anchor:href.includes('#') ? href.slice(href.indexOf('#')) : ''});
  else toast('找不到連結的文件，請匯入包含相關文件的共同上層資料夾。');
});
document.addEventListener('keydown', e => {
  const editable = e.target.closest('input,textarea,[contenteditable=true]');
  if (e.key === 'Escape') { document.body.classList.remove('sidebar-mobile-open','toc-open'); return; }
  if (editable || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 'o') { e.preventDefault(); $('file-input').click(); }
  if (e.key === '/') { e.preventDefault(); if (matchMedia('(max-width:720px)').matches) document.body.classList.add('sidebar-mobile-open'); else document.body.classList.remove('sidebar-collapsed'); $('file-search').focus(); }
});
document.addEventListener('paste', e => {
  if (e.target.closest('input,textarea,[contenteditable=true]') || document.querySelector('dialog[open]')) return;
  const content = e.clipboardData?.getData('text/plain');
  if (content) { e.preventDefault(); openPaste(content); }
});
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false;
});
window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', e => { e.preventDefault(); dragDepth = Math.max(0,dragDepth - 1); if (!dragDepth) $('drop-overlay').hidden = true; });
window.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
  if (!e.dataTransfer) return;
  // Obtain entries synchronously before the drag event's data store is cleared.
  const entries = [...e.dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  const fallbackFiles = [...e.dataTransfer.files];
  try {
    const result = [];
    if (entries.length) for (const entry of entries) await readDirectoryEntry(entry,result);
    else result.push(...fallbackFiles);
    await importFiles(result);
  } catch { toast('資料夾無法完整讀取，請改用「匯入資料夾」。'); }
});
window.addEventListener('scroll',scheduleProgress,{passive:true});
const cancelResume=event=>{
  if (!resumeTask) return;
  // File navigation must leave the old restore pending until showDocument saves
  // its position; the temporary top-of-page layout is not a new reading choice.
  if (event.target instanceof Element && event.target.closest('#sidebar,#sidebar-toggle,#open-button,dialog,#document a[href]:not([href^="#"])')) return;
  resumeTask=undefined; renderLibraryStatus();
};
window.addEventListener('wheel',cancelResume,{passive:true});
window.addEventListener('touchstart',cancelResume,{passive:true});
window.addEventListener('pointerdown',cancelResume,{passive:true});
window.addEventListener('keydown',event=>{ if (['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)) cancelResume(event); });
document.addEventListener('visibilitychange',()=>{ if (document.hidden) saveOnExit(); });
window.addEventListener('pagehide',saveOnExit);
window.addEventListener('hashchange',()=>{
  if (libraryLoading || !libraryReady) return;
  const doc=documents.get(tabDocumentPath());
  if (doc && doc!==current) showDocument(doc);
  else rememberTabDocument(); // Keep the tab identity after the native skip link.
});
const headingLayoutObserver=new ResizeObserver(() => { measureHeadings = true; scheduleProgress(); });
headingLayoutObserver.observe($('document'));
headingLayoutObserver.observe(document.querySelector('.offline-state'));
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { updateTables(); updateProgress(); },100); });
window.addEventListener('beforeunload', () => {
  saveOnExit();
  for (const url of assets.values()) URL.revokeObjectURL(url);
});

setTheme(preference('theme') === 'dark' ? 'dark' : 'light',false);
const savedSize = Number(preference('font-size'));
const chosenSize = Number(preference('font-size-choice'));
const hasChosenSize = Number.isInteger(chosenSize) && chosenSize >= 13 && chosenSize <= 22;
const migrationFontSize=!hasChosenSize && savedSize===16 ? 16 : undefined;
// Legacy versions saved the default on startup, without recording user intent.
// Upgrade their 16px value once; explicit choices made since this version win.
setFont(hasChosenSize ? chosenSize : savedSize !== 16 && Number.isFinite(savedSize) && savedSize >= 13 ? savedSize : 18);
async function startReader() {
  try { await hydrateLibrary(true); } catch(error) { storageError=error; }
  libraryLoading=false;
  $('loading').hidden = true;
  $('app').hidden = false;
  showDocument(current);
  prepareOffline();
}
void startReader();
