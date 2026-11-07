export const DESKTOP_EXPERT_ID_MAX = 120;

// Undefined is omission. Null/empty values never clear a persisted selection.
export function validateDesktopExpertId(value, provider) {
  if (value === undefined) return undefined;
  if (provider !== 'workbuddyDesktop') throw new Error('desktopExpertId 仅适用于 workbuddyDesktop。');
  if (typeof value !== 'string' || !value.trim() || value.length > DESKTOP_EXPERT_ID_MAX || /[\r\n\0]/.test(value)) {
    throw new Error('desktopExpertId 必须是非空、最长 120 字符的字符串；不能使用 null。');
  }
  return value.trim();
}
