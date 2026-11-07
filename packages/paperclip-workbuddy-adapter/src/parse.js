import { text } from './config.js';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/;
/** @param {unknown} value @returns {Record<string, any>} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** @param {unknown} value */
const tokens = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Parse only structured result fields. Assistant prose never classifies authentication. */
export function createParser() {
  let buffer = '', sessionId = '', invalid = false;
  /** @type {Record<string, any> | null} */
  let final = null;
  const line = (/** @type {string} */ input) => {
    let event;
    try { event = object(JSON.parse(input)); } catch { return; }
    const id = text(event.session_id);
    if (id && SESSION_ID.test(id)) {
      if (sessionId && sessionId !== id) invalid = true;
      sessionId = id;
    }
    if (event.type === 'result') final = event;
  };
  return {
    /** @param {string} chunk */
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const next = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (next.length > 4 * 1024 * 1024) invalid = true; else line(next);
      }
      if (buffer.length > 4 * 1024 * 1024) { invalid = true; buffer = ''; }
    },
    finish() {
      if (buffer.trim()) line(buffer); buffer = '';
      const usage = object(final?.usage);
      const input = tokens(usage.input_tokens), output = tokens(usage.output_tokens);
      const cacheRead = tokens(usage.cache_read_input_tokens), cacheWrite = tokens(usage.cache_creation_input_tokens);
      const hasUsage = input !== null && output !== null;
      const cost = final?.total_cost_usd;
      const costUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
      const denied = Array.isArray(final?.permission_denials) && final.permission_denials.length > 0;
      const subtype = text(final?.subtype);
      const failed = !!final?.is_error || denied || subtype !== 'success';
      const cancelled = ['cancelled', 'canceled', 'interrupted'].includes(subtype);
      const summary = text(final?.result) || text(final?.response);
      const errors = Array.isArray(final?.errors) ? final.errors.filter((/** @type {unknown} */ e) => typeof e === 'string').join('\n') : '';
      return {
        sessionId: sessionId || null, finalSeen: final !== null, invalid, cancelled,
        success: final !== null && !failed && !invalid && !!summary.trim(), summary,
        error: invalid ? 'Invalid or conflicting stream identity.' : !final ? 'CLI exited without a final result; delivery is uncertain. Do not replay automatically.'
          : denied ? 'WorkBuddy denied one or more tool operations.' : failed ? errors || summary || `WorkBuddy returned ${subtype || 'an invalid result'}.`
            : !summary.trim() ? 'Final result has no response; inspect the session before retrying.' : '',
        usage: hasUsage ? { inputTokens: input + (cacheWrite ?? 0), outputTokens: output, cachedInputTokens: cacheRead ?? 0, cacheWriteTokens: cacheWrite ?? 0 } : undefined,
        usageComplete: hasUsage, costUsd, costStatus: /** @type {'reported' | 'unpriced'} */ (costUsd !== null ? 'reported' : 'unpriced'),
      };
    },
  };
}
