import {MAX_TEXT_BYTES,MAX_ASSET_BYTES} from './limits.js';

const bytes=value=>value<1024 ? `${value} B` : value<1024*1024 ? `${(value/1024).toFixed(1)} KiB` : `${(value/1024/1024).toFixed(1)} MiB`;
export function storageAdvice(name) {
  if (name==='LibraryEditConflict') return '其他分頁已修改文件庫。尚未保存的內容仍留在這個分頁，請先匯出備份，再重新開啟；不會自動覆寫其他分頁的資料。';
  if (name==='QuotaExceededError') return '瀏覽器儲存空間不足。請先匯出文件庫備份，再整理不需要的文件，然後重試保存。';
  if (name==='SecurityError' || name==='NotAllowedError') return '瀏覽器禁止保存。請檢查網站儲存設定，或改用一般瀏覽視窗；關閉前先匯出文件庫備份。';
  return '這次未能保存。請先匯出文件庫備份，再確認瀏覽器允許儲存並按「重試保存」。不要先清除網站資料。';
}

export function createLibraryHealth(getSnapshot) {
  const $=id=>document.getElementById(id),scope=new URL('./',location.href).href;
  const key=`inkread-library:${scope}:backup-info`,changeKey=`${key}:content`;
  const read=key=>{try{return localStorage.getItem(key);}catch{return null;}};
  const write=(key,value)=>{try{localStorage.setItem(key,value);return true;}catch{return false;}};
  const contentToken=()=>read(changeKey) || 'initial';
  let storageNotice=false;
  function render() {
    const s=getSnapshot();
    $('library-capacity').textContent=`${s.documents} 份文件 · ${s.images} 張圖片\n文字 ${bytes(s.textBytes)} / ${bytes(MAX_TEXT_BYTES)}\n圖片 ${bytes(s.imageBytes)} / ${bytes(MAX_ASSET_BYTES)}`;
    let backup;
    try { backup=JSON.parse(read(key)); } catch { /* Invalid optional history. */ }
    const valid=backup && Number.isFinite(backup.time) && backup.time>0 && backup.time<=Date.now()+60000 && typeof backup.token==='string';
    $('backup-history').textContent=valid ? `上次產生備份：${new Date(backup.time).toLocaleString('zh-TW')}。${backup.token!==contentToken() ? '之後有文件或圖片變更，建議再備份。' : '請確認備份檔已下載到你的裝置。'}` : s.documents || s.images ? '尚無匯出紀錄，建議先備份重要文件。' : '匯入文件後，可備份整個文件庫並搬到其他裝置。';
    if (storageNotice) $('backup-history').textContent+=' 此環境無法保存匯出紀錄，請自行保留備份。';
    const status=$('library-status');
    $('library-error-detail').hidden=status.dataset.state!=='error';
    if (status.dataset.state==='error') $('library-error-detail').textContent=storageAdvice(s.errorName);
    $('first-use').hidden=s.documents>0;
  }
  addEventListener('storage',event=>{if(event.key===key || event.key===changeKey) render();});
  return {
    render,contentToken,
    changed(){storageNotice=!write(changeKey,`${Date.now()}-${Math.random().toString(36).slice(2)}`);render();},
    exported(token){storageNotice=!write(key,JSON.stringify({time:Date.now(),token}));render();},
    diagnostic(){
      const s=getSnapshot();
      // Allowlisted metadata only: never include source, paths, URL fragments,
      // filenames, positions, error stacks, image bytes or clipboard contents.
      return {format:'inkread-diagnostic',version:document.querySelector('.version').textContent,createdAt:new Date().toISOString(),openingMode:location.protocol,secureContext:isSecureContext,online:navigator.onLine,programState:$('offline-status').dataset.state || 'unknown',libraryState:$('library-status').dataset.state,documents:s.documents,images:s.images,textBytes:s.textBytes,imageBytes:s.imageBytes,storageError:s.errorName || null};
    },
  };
}
