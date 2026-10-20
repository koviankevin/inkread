import './style.css';
import {createIcons, Plus, Search, X, FolderOpen, ShieldCheck, CircleHelp, PanelLeft, ChevronRight, Minus, Moon, Sun, Printer, List, FileText, FileUp, BookOpen, ArrowUp, Copy, Check, Sparkles, ImageOff, ArrowLeftRight, FileCode2, ChartNoAxesCombined} from 'lucide';
import {renderMarkdown, sanitizeDiagram, safeDiagramSource, sanitizeFormula} from './renderer.js';
import {loadVendor} from './vendor-loader.js';
import {prepareOffline} from './offline.js';
import {normalizePath, resolvePath, isMarkdown, imageKind} from './paths.js';
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
let tocLinks = [];
let activeHeadingIndex = -1;
let measureHeadings = true;
let progressFrame = 0;
let fontSize = 16;
let toastTimer;
let dragDepth = 0;
let pasteCounter = 0;

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

function setFont(size) {
  fontSize = Math.min(22, Math.max(13,size));
  document.documentElement.style.setProperty('--reader-size', `${fontSize}px`);
  $('font-size').textContent = fontSize;
  $('font-minus').disabled = fontSize <= 13;
  $('font-plus').disabled = fontSize >= 22;
  preference('font-size',String(fontSize));
  requestAnimationFrame(updateTables);
}

function renderFiles() {
  const search = $('file-search').value.trim().toLocaleLowerCase();
  $('demo-files').replaceChildren();
  $('user-files').replaceChildren();
  let userCount = 0;
  let filteredCount = 0;
  for (const doc of documents.values()) {
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
  $('clear-files').hidden = !userCount;
  $('empty-files').hidden = filteredCount > 0;
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
      const path = resolvePath(current.path,entry.src);
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
  if (measureHeadings) {
    headingPositions = activeHeadings.map(heading => heading.getBoundingClientRect().top + window.scrollY);
    measureHeadings = false;
  }
  const top = window.scrollY + article.getBoundingClientRect().top;
  const length = Math.max(1, article.offsetHeight - window.innerHeight + 100);
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

function showDocument(doc, {preserveScroll = false, anchor = ''} = {}) {
  if (current !== doc) remoteAllowed = false;
  current = doc;
  const version = ++renderVersion;
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
  if (anchor) renderAllFeatures().then(() => { if (version === renderVersion) jumpToAnchor(anchor); });
  updateProgress();
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
        const bytes = textBytes(source);
        const doc = {path, source, bytes, name:path.split('/').pop()};
        if (!canStoreDocument(doc,bytes)) { skipped++; continue; }
        documents.set(path,doc);
        added.push(doc);
      } catch { failures++; }
    } else if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path)) {
      const retainedBytes = [...assetSizes.values()].reduce((sum,size)=>sum+size,0) - (assetSizes.get(path) || 0);
      if (file.size > MAX_IMAGE_BYTES || retainedBytes + file.size > MAX_ASSET_BYTES) { skipped++; continue; }
      const mime = file.type || ({svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon'})[path.split('.').pop().toLowerCase()];
      releaseAsset(path);
      assets.set(path,URL.createObjectURL(new Blob([file], {type:mime})));
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
    renderImages(currentImages);
    refreshIcons();
    toast(`已載入 ${assetCount} 張圖片${skipped ? `；${skipped} 份超過容量或數量限制已略過` : ''}。`);
  } else toast(skipped ? '超過匯入限制：單份文件 2 MiB、文件共 200 份／20 MiB、圖片單張 20 MiB／共 100 MiB、每次 1,000 份檔案。' : failures ? '檔案無法讀取，請重新選取。' : '沒有找到 Markdown 文件。支援 .md、.markdown 與 .txt。');
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
  if (typeof content === 'string') $('paste-content').value = content;
  $('paste-count').textContent = `${$('paste-content').value.length.toLocaleString()} 字元`;
  $('paste-dialog').showModal();
  setTimeout(() => $('paste-content').focus(),50);
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
$('clear-files').addEventListener('click', () => {
  for (const [path,doc] of documents) if (!doc.demo) documents.delete(path);
  for (const path of assets.keys()) if (!path.startsWith('範例/')) releaseAsset(path);
  $('file-search').value = '';
  $('paste-content').value = '';
  $('paste-name').value = '未命名文件.md';
  if (!current.demo) showDocument(demoDocs[0]);
  else renderFiles();
  toast('已清除匯入的文件與圖片。');
});
$('paste-button').addEventListener('click', () => openPaste());
$('paste-content').addEventListener('input', () => { $('paste-count').textContent = `${$('paste-content').value.length.toLocaleString()} 字元`; });
$('paste-submit').addEventListener('click', () => {
  const source = $('paste-content').value;
  if (!source.trim()) { $('paste-content').focus(); toast('先貼上一些文字，再開始閱讀。'); return; }
  let name = $('paste-name').value.trim() || '未命名文件.md';
  name = name.replace(/[\\/]/g,'-');
  if (!isMarkdown(name)) name += '.md';
  if (source.length > MAX_DOCUMENT_BYTES) { toast('單份文件上限為 2 MiB，請先分割內容。'); return; }
  const bytes = textBytes(source);
  const doc = {path:`貼上/${pasteCounter + 1}/${name}`, name, source, bytes, pasted:true};
  if (!canStoreDocument(doc,bytes)) { toast('超過容量限制：單份文件 2 MiB、文件共 200 份／20 MiB。'); return; }
  pasteCounter++;
  documents.set(doc.path,doc);
  $('paste-dialog').close();
  $('file-search').value = '';
  showDocument(doc);
  document.body.classList.remove('sidebar-mobile-open');
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
$('brand-home').addEventListener('click', e => { e.preventDefault(); $('file-search').value = ''; showDocument(demoDocs[0]); });
$('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('font-minus').addEventListener('click', () => setFont(fontSize - 1));
$('font-plus').addEventListener('click', () => setFont(fontSize + 1));
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
  const path = resolvePath(current.path,href);
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
new ResizeObserver(() => { measureHeadings = true; scheduleProgress(); }).observe($('document'));
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { updateTables(); updateProgress(); },100); });
window.addEventListener('beforeunload', () => { for (const url of assets.values()) URL.revokeObjectURL(url); });

setTheme(preference('theme') === 'dark' ? 'dark' : 'light',false);
const savedSize = Number(preference('font-size'));
setFont(Number.isFinite(savedSize) && savedSize >= 13 ? savedSize : 16);
$('loading').hidden = true;
$('app').hidden = false;
showDocument(current);
prepareOffline();
