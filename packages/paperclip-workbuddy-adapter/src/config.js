import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** @param {unknown} value @returns {string} */
export const text = value => typeof value === 'string' ? value : '';

/** @param {unknown} value @param {number} fallback */
function seconds(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400) throw new Error('Timeout must be between 0 and 86400 seconds.');
  return value;
}

/** @param {Record<string, unknown>} config */
export function resolveConfig(config) {
  const cwd = text(config.cwd).trim();
  if (!path.isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('cwd must be an existing absolute directory.');
  const executable = text(config.command).trim();
  const entry = text(config.cliPath).trim();
  if (executable && entry) throw new Error('Set command or cliPath, not both.');
  if (entry && (!path.isAbsolute(entry) || !existsSync(entry) || !statSync(entry).isFile() || !/\.[cm]?js$/i.test(entry))) throw new Error('cliPath must point to an existing absolute WorkBuddy JavaScript CLI entry.');
  if (executable && (/\.(cmd|bat|ps1)$/i.test(executable) || (/[\\/]/.test(executable) && (!path.isAbsolute(executable) || !existsSync(executable))))) throw new Error('command must be a native executable or a command on PATH, not a shell script.');
  const configDir = text(config.configDir).trim() || path.join(homedir(), '.workbuddy');
  if (!path.isAbsolute(configDir)) throw new Error('configDir must be an absolute path.');
  const permissionMode = text(config.permissionMode) || 'dontAsk';
  if (!['dontAsk', 'default'].includes(permissionMode)) throw new Error('permissionMode must be dontAsk or default.');
  /** @type {Record<string, string>} */
  const env = {};
  if (config.env != null) {
    if (typeof config.env !== 'object' || Array.isArray(config.env)) throw new Error('env must contain resolved string values.');
    for (const [key, value] of Object.entries(config.env)) {
      if (key.toUpperCase().startsWith('PAPERCLIP_')) throw new Error('env cannot override Paperclip run identity.');
      if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('env must contain valid names and resolved string values.');
      env[key] = value;
    }
  }
  return {
    cwd: realpathSync.native(cwd), command: entry ? process.execPath : executable || 'workbuddy',
    prefixArgs: entry ? [realpathSync.native(entry)] : [],
    configDir: path.normalize(configDir), env, permissionMode,
    model: text(config.model).trim(), effort: text(config.effort).trim(),
    timeoutSec: seconds(config.timeoutSec, 7200), graceSec: seconds(config.graceSec, 5),
    instructionsFilePath: text(config.instructionsFilePath), promptTemplate: text(config.promptTemplate),
  };
}

/** @param {unknown} value */
export function assertLocal(value) {
  if (value && typeof value === 'object' && ('remoteExecution' in value && value.remoteExecution || 'kind' in value && value.kind !== 'local')) throw new Error('This adapter supports local execution only.');
}

/** @param {string} a @param {string} b */
export function samePath(a, b) {
  const normal = (/** @type {string} */ p) => process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
  return normal(a) === normal(b);
}
