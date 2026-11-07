export function validateRecurrence(value) {
  if (value == null) return null;
  if (!value || !['daily', 'weekly'].includes(value.frequency)) throw new Error('重复计划请选择每天或每周。');
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('请选择有效的每日执行时间。');
  if (value.timezone != null && !['local', 'Asia/Shanghai'].includes(value.timezone)) throw new Error('重复计划跟随电脑本地时区。');
  const weekdays = value.frequency === 'weekly' ? value.weekdays : [];
  if (!Array.isArray(weekdays) || (value.frequency === 'weekly' && (!weekdays.length || weekdays.length > 7)) || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(weekdays).size !== weekdays.length) throw new Error('请至少选择一个星期，且不能重复。');
  return { frequency: value.frequency, time: value.time, weekdays: [...weekdays].sort((a, b) => a - b), timezone: 'local' };
}

// Construct local calendar dates so the OS timezone and daylight saving apply.
export function nextOccurrence(recurrence, after) {
  const [hours, minutes] = recurrence.time.split(':').map(Number);
  const start = new Date(after);
  for (let day = 0; day <= 7; day++) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, hours, minutes);
    const at = candidate.getTime();
    if (at > after && (recurrence.frequency === 'daily' || recurrence.weekdays.includes(candidate.getDay()))) return at;
  }
  throw new Error('无法计算下一次执行时间。');
}

export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function syncLocalRecurrence(task, now, timezone = localTimezone()) {
  const trigger = task.trigger, recurrence = trigger?.recurrence;
  if (!recurrence || trigger.type !== 'time') return false;
  if (recurrence.timezone === 'local' && trigger.scheduleTimezone === timezone) return false;
  recurrence.timezone = 'local'; trigger.scheduleTimezone = timezone;
  // Keep overdue occurrences for the existing catch-up policy and leave active runs intact.
  for (const slot of task.times) if (slot.state === 'pending' && slot.at > now) slot.at = nextOccurrence(recurrence, now);
  return true;
}
