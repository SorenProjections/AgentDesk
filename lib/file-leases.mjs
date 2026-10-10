import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const pathKey = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
export const overlaps = (a, b) => {
  const x = pathKey(a), y = pathKey(b);
  return x === y || x.startsWith(y.endsWith(path.sep) ? y : y + path.sep) || y.startsWith(x.endsWith(path.sep) ? x : x + path.sep);
};

// Resolve existing ancestors too, so a missing file under a junction cannot escape.
export function scopedPath(root, relative) {
  if (typeof relative !== 'string' || !relative.trim() || relative.includes('\0') || path.isAbsolute(relative) ||
      /^[a-z]:/i.test(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('路径必须是项目内的相对路径，不能包含 ..。');
  const base = realpathSync.native(root), target = path.resolve(base, relative);
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(realpathSync.native(ancestor), path.relative(ancestor, target));
  const key = pathKey(base), child = pathKey(resolved);
  if (child !== key && !child.startsWith(key.endsWith(path.sep) ? key : key + path.sep)) throw new Error('路径通过链接或目录跳出了项目范围。');
  return resolved;
}

export class FileLeases {
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store; this.clock = clock;
    store.data.fileLeases ||= [];
  }
  resources(cwd, paths = ['.']) { return paths.map(p => scopedPath(cwd, p)); }
  conflict(owner, resources, access = 'write') {
    return this.store.data.fileLeases.find(l => l.state === 'held' && l.owner !== owner &&
      (access === 'write' || l.access === 'write') && resources.some(a => l.resources.some(b => overlaps(a, b))));
  }
  acquire({ owner, cwd, paths = ['.'], access = 'write', provider, threadId, runId }) {
    const resources = this.resources(cwd, paths), conflict = this.conflict(owner, resources, access);
    if (conflict) throw new Error('文件占用冲突：' + conflict.owner + ' 正在占用重叠路径。');
    let lease = this.store.data.fileLeases.find(l => l.owner === owner && l.state === 'held');
    if (lease && (lease.access !== access || resources.length !== lease.resources.length ||
        resources.some(p => !lease.resources.some(q => pathKey(p) === pathKey(q))))) throw new Error('不能在持有占用期间更改文件范围。');
    if (!lease) {
      lease = { id: randomUUID(), owner, cwd, paths, resources, access, provider, threadId: threadId || null,
        runId, state: 'held', acquiredAt: this.clock() };
      this.store.data.fileLeases.push(lease);
    } else Object.assign(lease, { runId, provider, threadId: threadId || lease.threadId });
    this.store.save();
    return lease;
  }
  bind(owner, threadId) {
    const lease = this.store.data.fileLeases.find(l => l.owner === owner && l.state === 'held');
    if (lease) { lease.threadId = threadId; this.store.save(); }
  }
  release(owner, reason) {
    for (const lease of this.store.data.fileLeases.filter(l => l.owner === owner && l.state === 'held')) {
      Object.assign(lease, { state: 'released', releasedAt: this.clock(), reason });
    }
    this.store.save();
  }
}
