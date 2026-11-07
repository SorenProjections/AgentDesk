import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const recurrenceUrl=new URL('../lib/recurrence.mjs',import.meta.url).href;
const uiUrl=new URL('../web/api.js',import.meta.url).href;
function inTimezone(timezone,code) {
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {validateRecurrence,nextOccurrence,localTimezone,syncLocalRecurrence} from ${JSON.stringify(recurrenceUrl)};
    import {localDateTimeInput,parseLocalDateTime,localDateFormat} from ${JSON.stringify(uiUrl)};
    ${code}
  `],{env:{...process.env,TZ:timezone},encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(child.status,0,child.stderr||child.stdout||String(child.error));
}

for(const timezone of ['UTC','Asia/Kolkata','America/New_York'])test(`schedules and date fields follow computer time in ${timezone}`,()=>{
  inTimezone(timezone,`
    const now=new Date(2026,10,7,8,45).getTime();
    const daily=validateRecurrence({frequency:'daily',time:'09:00'});
    assert.equal(daily.timezone,'local');
    assert.equal(nextOccurrence(daily,now),new Date(2026,10,7,9).getTime());
    const weekly=validateRecurrence({frequency:'weekly',time:'09:00',weekdays:[1]});
    assert.equal(nextOccurrence(weekly,now),new Date(2026,10,9,9).getTime());
    assert.equal(localDateTimeInput(now),'2026-11-07T08:45:00');
    assert.equal(parseLocalDateTime('2026-11-07T08:45'),now);
    assert.equal(parseLocalDateTime('2026-11-07T08:45:00'),now);
    assert.ok(Number.isNaN(parseLocalDateTime('2026-02-30T08:45')));
    assert.ok(Number.isNaN(parseLocalDateTime('2026-11-07T08:45Z')));
    assert.ok(localDateFormat({hour:'2-digit',minute:'2-digit',hour12:false}).format(now).includes('08:45'));
  `);
});

test('local recurrence follows 23-hour and 25-hour days and does not repeat the fallback hour',()=>{
  inTimezone('America/New_York',`
    const daily=validateRecurrence({frequency:'daily',time:'09:00'});
    const spring=new Date(2026,2,7,9).getTime();
    assert.equal(nextOccurrence(daily,spring)-spring,23*3600000);
    const fall=new Date(2026,9,31,9).getTime();
    assert.equal(nextOccurrence(daily,fall)-fall,25*3600000);
    const repeated=validateRecurrence({frequency:'daily',time:'01:30'});
    assert.equal(nextOccurrence(repeated,Date.parse('2026-11-01T01:40:00-04:00')),new Date(2026,10,2,1,30).getTime());
    const gap=validateRecurrence({frequency:'daily',time:'02:30'});
    assert.equal(nextOccurrence(gap,new Date(2026,2,8,0).getTime()),new Date(2026,2,8,3,30).getTime());
    assert.ok(Number.isNaN(parseLocalDateTime('2026-03-08T02:30')));
  `);
});

test('legacy tasks migrate and timezone changes adjust only future pending occurrences',()=>{
  inTimezone('UTC',`
    const now=new Date(2026,10,7,8).getTime();
    const task={trigger:{type:'time',recurrence:{frequency:'daily',time:'09:00',timezone:'Asia/Shanghai'}},times:[
      {id:'running',state:'running',at:now-7200000},
      {id:'overdue',state:'pending',at:now-3600000},
      {id:'future',state:'pending',at:now+7200000}
    ]};
    assert.equal(syncLocalRecurrence(task,now),true);
    assert.equal(task.trigger.recurrence.timezone,'local');
    assert.equal(task.times[0].at,now-7200000);assert.equal(task.times[1].at,now-3600000);
    assert.equal(task.times[2].at,new Date(2026,10,7,9).getTime());
    assert.equal(syncLocalRecurrence(task,now),false);
    process.env.TZ='Asia/Kolkata';
    assert.equal(syncLocalRecurrence(task,now),true);
    assert.equal(task.times[2].at,new Date(2026,10,8,9).getTime());
    assert.equal(task.trigger.scheduleTimezone,localTimezone());
    assert.equal(task.times[1].at,now-3600000);
    assert.equal(validateRecurrence({frequency:'daily',time:'09:00',timezone:'Asia/Shanghai'}).timezone,'local');
  `);
});
