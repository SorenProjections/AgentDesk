import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecurrence, nextOccurrence } from '../lib/recurrence.mjs';

const at = value => Date.parse(value);
test('daily calendar uses computer local time across month/year boundaries and exact matches', () => {
  const schedule = validateRecurrence({ frequency: 'daily', time: '00:05' });
  assert.equal(nextOccurrence(schedule, at('2026-12-31T23:59:00')), at('2027-01-01T00:05:00'));
  assert.equal(nextOccurrence(schedule, at('2027-01-01T00:05:00')), at('2027-01-02T00:05:00'));
});

test('weekly calendar supports multiple weekdays, Sunday, and the next week', () => {
  const schedule = validateRecurrence({ frequency: 'weekly', time: '09:30', weekdays: [0, 1, 5] });
  assert.equal(nextOccurrence(schedule, at('2026-11-05T12:00:00')), at('2026-11-06T09:30:00'));
  assert.equal(nextOccurrence(schedule, at('2026-11-06T09:30:00')), at('2026-11-08T09:30:00'));
  assert.equal(nextOccurrence(schedule, at('2026-11-08T09:30:00')), at('2026-11-09T09:30:00'));
  assert.equal(nextOccurrence(validateRecurrence({ frequency: 'weekly', time: '09:30', weekdays: [1] }), at('2026-11-09T09:30:00')), at('2026-11-16T09:30:00'));
});

test('invalid repeat rules cannot create a schedule', () => {
  for (const value of [false, {}, {frequency:'monthly',time:'09:00'}, {frequency:'daily',time:'24:00'}, {frequency:'daily',time:'09:60'}, {frequency:'daily',time:'9:00'}, {frequency:'weekly',time:'09:00',weekdays:[]}, {frequency:'weekly',time:'09:00',weekdays:[1,1]}, {frequency:'weekly',time:'09:00',weekdays:[7]}, {frequency:'weekly',time:'09:00',weekdays:['1']}, {frequency:'daily',time:'09:00',timezone:'UTC'}]) assert.throws(() => validateRecurrence(value));
});
