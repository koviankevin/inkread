export const isMarkdown = name => /\.(md|markdown|txt)$/i.test(name);

export function normalizePath(path) {
  const result = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!result.length) return null;
      result.pop();
    } else result.push(part);
  }
  return result.join('/');
}

export function resolvePath(currentPath, url) {
  let decoded;
  try { decoded = decodeURIComponent(url.split(/[?#]/)[0]); } catch { return null; }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(decoded)) return null;
  const base = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  return normalizePath(decoded.startsWith('/') ? decoded.slice(1) : base + decoded);
}

export function headingSlug(text, used) {
  const base = text.toLowerCase().replace(/[`*~$]/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  const count = used.get(base) || 0;
  used.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

export function imageKind(url) {
  if (/^https?:\/\//i.test(url) || /^\/\//.test(url)) return 'remote';
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(url)) return 'data';
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return 'blocked';
  return 'local';
}
