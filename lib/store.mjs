import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file) {
    this.file = file;
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
    this.data.settings = { queuePaused: false, pauseOnFailure: true, keepAwake: false, ...this.data.settings };
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
    renameSync(temporary, this.file);
  }
}
