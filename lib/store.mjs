import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file, { replaceFile = renameSync, platform = process.platform } = {}) {
    this.file = file;
    this.replaceFile = replaceFile; this.platform = platform;
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'));
        if (![1, 2].includes(this.data.version) || !Array.isArray(this.data.tasks) || !Array.isArray(this.data.runs)) throw new Error('不支持的数据格式');
      } catch (error) {
        throw new Error(`任务文件无法读取，原文件已保留：${file}。${error.message}`);
      }
    } else {
      this.data = { version: 2, applicationId: randomUUID(), tasks: [], runs: [] };
      this.save();
    }
    this.data.version = 2;
    this.data.settings = { queuePaused: false, pauseOnFailure: true, keepAwake: false, maxConcurrentRuns: 4, ...this.data.settings };
    this.data.tasks.forEach((task, index) => {
      task.provider ||= 'codex';
      task.trigger ||= { type: 'time' };
      task.order ??= index;
      task.revision ??= 1;
    });
    this.data.runs.forEach(run => { run.provider ||= 'codex'; });
  }

  save() {
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    const descriptor = openSync(temporary, 'r+');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    // Windows indexers/readers can briefly deny replacement of an existing file.
    // Retry the atomic rename; never unlink the last durable task file.
    for (let attempt=0;;attempt++) {
      try { this.replaceFile(temporary, this.file); break; }
      catch (error) {
        if (this.platform!=='win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20*(attempt+1));
      }
    }
  }
}
