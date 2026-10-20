import {normalizePath,resolvePath} from './paths.js';

export const validLibraryPath=value=>typeof value==='string' && value.length>0 && value.length<=1024 && !/[\x00-\x1f\x7f:\\]/.test(value) && !value.startsWith('/') && !value.startsWith('範例/') && normalizePath(value)===value;

// Preserve Markdown exactly, including reference links and code examples.
// Redirect only local lookups; remote URLs never enter this map.
export function documentLinks(row) {
  if (row.linkBase===undefined && row.linkTargets===undefined) return {};
  if (!validLibraryPath(row.linkBase) || !Array.isArray(row.linkTargets) || row.linkTargets.length>1200) throw new Error('文件連結資料不正確。');
  const seen=new Set();
  const linkTargets=row.linkTargets.map(pair=>{
    if (!Array.isArray(pair) || pair.length!==2 || !pair.every(validLibraryPath) || seen.has(pair[0])) throw new Error('文件連結資料不正確。');
    seen.add(pair[0]); return [...pair];
  });
  return {linkBase:row.linkBase,linkTargets};
}

export function resolveDocumentPath(doc,url) {
  const path=resolvePath(doc.linkBase || doc.path,url);
  return path===null ? null : doc.linkTargets?.find(pair=>pair[0]===path)?.[1] || path;
}
