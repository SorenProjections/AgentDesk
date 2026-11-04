const DAY = 86400000;
const OFFSET = 8 * 3600000;

export function validateRecurrence(value) {
  if (value == null) return null;
  if (!value || !['daily', 'weekly'].includes(value.frequency)) throw new Error('重复计划请选择每天或每周。');
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('请选择有效的每日执行时间。');
  if (value.timezone != null && value.timezone !== 'Asia/Shanghai') throw new Error('重复计划使用北京时间。');
  const weekdays = value.frequency === 'weekly' ? value.weekdays : [];
  if (!Array.isArray(weekdays) || (value.frequency === 'weekly' && (!weekdays.length || weekdays.length > 7)) || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(weekdays).size !== weekdays.length) throw new Error('请至少选择一个星期，且不能重复。');
  return { frequency: value.frequency, time: value.time, weekdays: [...weekdays].sort((a, b) => a - b), timezone: 'Asia/Shanghai' };
}

// Use UTC arithmetic with a fixed UTC+8 offset, independently of the host timezone.
export function nextOccurrence(recurrence, after) {
  const [hours, minutes] = recurrence.time.split(':').map(Number);
  const start = Math.floor((after + OFFSET) / DAY) * DAY - OFFSET;
  for (let day = 0; day <= 7; day++) {
    const at = start + day * DAY + hours * 3600000 + minutes * 60000;
    if (at > after && (recurrence.frequency === 'daily' || recurrence.weekdays.includes(new Date(at + OFFSET).getUTCDay()))) return at;
  }
  throw new Error('无法计算下一次执行时间。');
}
