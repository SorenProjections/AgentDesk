import { samePath, text } from './config.js';

/** @param {unknown} raw */
function decode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = /** @type {Record<string, unknown>} */ (raw);
  const sessionId = text(value.sessionId), cwd = text(value.cwd), configDir = text(value.configDir), command = text(value.command);
  if (!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/.test(sessionId) || !cwd || !configDir || !command) return null;
  return { sessionId, cwd, configDir, command };
}

/** @type {import('@paperclipai/adapter-utils').AdapterSessionCodec} */
export const sessionCodec = {
  deserialize: decode, serialize: decode,
  getDisplayId: raw => decode(raw)?.sessionId ?? null,
};

/** @param {unknown} raw @param {ReturnType<import('./config.js').resolveConfig>} config */
export function resumableSession(raw, config) {
  const value = decode(raw);
  const command = config.prefixArgs[0] || config.command;
  return value && samePath(value.cwd, config.cwd) && samePath(value.configDir, config.configDir) && value.command === command ? value.sessionId : null;
}
