import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { headingSlug } from './paths.js';

const md = new MarkdownIt({html:false, linkify:true, typographer:true, breaks:false});
md.use(taskLists, {enabled:false, label:false});
md.use(texmath, {engine:katex, delimiters:'dollars', katexOptions:{throwOnError:false, strict:'ignore', trust:false, maxExpand:1000, maxSize:20}});
export const escapeHTML = value => md.utils.escapeHtml(String(value));

md.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('id', headingSlug(tokens[index + 1]?.content || '', env.slugs));
  return self.renderToken(tokens, index, options);
};

md.renderer.rules.image = (tokens, index, options, env) => {
  const token = tokens[index];
  const entry = {src:token.attrGet('src') || '', alt:token.content || '', title:token.attrGet('title') || ''};
  const imageId = env.images.push(entry) - 1;
  return `<span class="pending-image" data-image-index="${imageId}"></span>`;
};

md.renderer.rules.fence = (tokens, index, options, env) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();
  if (language === 'mermaid') {
    const diagramId = env.diagrams.push(token.content) - 1;
    return `<div class="mermaid-container" data-diagram-index="${diagramId}" role="img" aria-label="Mermaid 圖表"><span>圖表繪製中…</span></div>`;
  }
  let code = escapeHTML(token.content);
  if (language && hljs.getLanguage(language)) {
    try { code = hljs.highlight(token.content, {language, ignoreIllegals:true}).value; } catch { /* render plain code */ }
  }
  return `<div class="code-block"><div class="code-bar"><span>${escapeHTML(language || 'text')}</span><button class="copy-code" type="button" aria-label="複製程式碼"><i data-lucide="copy"></i><span>複製</span></button></div><pre><code${language ? ` class="language-${escapeHTML(language)}"` : ''}>${code}</code></pre></div>`;
};

md.renderer.rules.table_open = () => '<div class="table-container"><div class="table-scroll" tabindex="0" role="region" aria-label="表格，可左右捲動"><table>\n';
md.renderer.rules.table_close = () => '</table></div></div>\n';

export function renderMarkdown(source) {
  const env = {images:[], diagrams:[], slugs:new Map()};
  const raw = md.render(source, env);
  const html = DOMPurify.sanitize(raw, {ADD_ATTR:['target'], FORBID_TAGS:['style','iframe','object','embed','form'], FORBID_ATTR:['srcdoc']});
  return {html, images:env.images, diagrams:env.diagrams};
}

export function sanitizeDiagram(svg) {
  const fragment = DOMPurify.sanitize(svg, {RETURN_DOM_FRAGMENT:true, USE_PROFILES:{html:true, svg:true, svgFilters:true}, ADD_TAGS:['style','foreignObject'], ADD_ATTR:['xmlns'], FORBID_TAGS:['script','image','a','iframe','use','img','input','form','video','audio'], FORBID_ATTR:['href','xlink:href','src','srcdoc']});
  // Keep Mermaid's scoped colors and label styles, while forbidding CSS requests.
  const unsafeCSS = value => /@import|@font-face|@namespace|expression\s*\(|javascript:|https?:|data:|\\|url\s*\(/i.test(value.replace(/url\(\s*(["']?)#[\w:.-]+\1\s*\)/gi,''));
  for (const style of fragment.querySelectorAll('style')) if (unsafeCSS(style.textContent)) style.remove();
  for (const element of fragment.querySelectorAll('[style]')) if (unsafeCSS(element.getAttribute('style'))) element.removeAttribute('style');
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  return wrapper.innerHTML;
}

export function safeDiagramSource(source) {
  const cleaned = source.replace(/^---\s*\n[\s\S]*?\n---\s*\n/,'').replace(/%%\{[\s\S]*?\}%%/g,'').replace(/^\s*click\s+.*$/gm,'');
  if (/@import|@font-face|\b(?:https?|ftp|data|javascript):|\burl\s*\(|\b(?:img|icon)\s*:|<(?:img|image|iframe|script|style|link|object|embed|svg|foreignObject)\b/i.test(cleaned)) throw new Error('External graph resources are disabled');
  return cleaned;
}
