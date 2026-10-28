import {isMarkdown} from './paths.js';
import {MAX_IMPORT_FILES} from './limits.js';

async function readDirectoryEntry(entry,result,parent='') {
  const path=parent+entry.name;
  if(entry.isFile){
    if(!isMarkdown(path) && !/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path))return;
    if(result.length>=MAX_IMPORT_FILES)throw new Error('Too many files');
    const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));
    result.push({file,path});
  }else if(entry.isDirectory){
    const reader=entry.createReader();let batch;
    do{
      batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
      for(const child of batch)await readDirectoryEntry(child,result,`${path}/`);
    }while(batch.length);
  }
}

export async function readDroppedFiles(dataTransfer) {
  // Retain the native File objects and entries while the drop event is active.
  const files=[...dataTransfer.files];
  const entries=[...(dataTransfer.items || [])].map(item=>{
    try{return item.webkitGetAsEntry?.();}catch{return null;}
  }).filter(Boolean);
  // Plain files already have the same readable objects supplied by a picker.
  // Reopening them through Entry.file adds a failure path with no useful data.
  if(files.length && !entries.some(entry=>entry.isDirectory))return files;
  const result=[];
  if(entries.length)for(const entry of entries)await readDirectoryEntry(entry,result);
  else result.push(...files);
  return result;
}
