import path from 'node:path';

// Windows native records may contain extended-length paths and mixed separators.
export function pathKey(value = '') {
  const raw = String(value).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const windows = process.platform === 'win32' || /^[a-z]:[\\/]|^\\\\/i.test(raw);
  const normalized = (windows ? path.win32 : path).normalize(raw);
  return windows ? normalized.replace(/[\\/]+$/, '').toLowerCase() : normalized.replace(/\/$/, '') || '/';
}

export const samePath = (a, b) => pathKey(a) === pathKey(b);
export function containsPath(root, target) {
  const base = pathKey(root), child = pathKey(target);
  return base === child || child.startsWith(base === '/' ? '/' : base + (base.includes('\\') || /^[a-z]:$/i.test(base) ? '\\' : '/'));
}
