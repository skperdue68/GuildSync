import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeScheduledSalesEnd} from './raffle-schedule.js';
import {readFile} from 'node:fs/promises';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const {getSheetsRaffleWindows,getActiveRaffleSummary,getAssociateTicketReportRaffleWindow,getRaffleRefreshSelection,getRaffleBonusOverrides,saveRaffleBonusOverride}=await import('./guildsync-database-actions.js');
const unix=value=>Date.parse(value)/1000;
const db=entries=>({execute:async sql=>sql.includes('JSON_ARRAYAGG')?[[{banking_json:entries}]]:[[]]});

test('raffles crossing fall-back and the following standard-time period stay at 7/8 PM Eastern',async()=>{
 for(const [reference,cutoff] of [['2026-10-30T16:00:00Z','2026-11-08T00:00:00Z'],['2026-11-10T16:00:00Z','2026-11-22T00:00:00Z']]){
  const windows=getSheetsRaffleWindows(unix(reference));
  const biweekly=windows.find(w=>w.type==='biweekly');
  assert.equal(biweekly.salesEnd,unix(cutoff));assert.equal(biweekly.drawTime,unix(cutoff)+3600);
  const summary=await getActiveRaffleSummary(db([]),unix(reference));
  assert.equal(summary.raffles.find(w=>w.type==='biweekly').drawTime,unix(cutoff)+3600);
 }
});

test('the extra fall-back hour belongs to the correct raffle, including exact cutoff',async()=>{
 const cutoff=unix('2026-11-08T00:00:00Z');
 const before=getAssociateTicketReportRaffleWindow({type:'biweekly',time:cutoff-1});
 assert.equal(before.salesEnd,cutoff);assert.equal(before.salesStart,unix('2026-10-24T23:00:00Z')+1);
 assert.equal(getAssociateTicketReportRaffleWindow({type:'biweekly',time:cutoff}).salesEnd,cutoff);
 assert.equal(getAssociateTicketReportRaffleWindow({type:'biweekly',time:cutoff+1}).salesEnd,unix('2026-11-22T00:00:00Z'));
 const entries=[{type:'biweekly',eventId:'last-hour',time:cutoff-1,amount:10001,ticketAmount:10},{type:'biweekly',eventId:'next',time:cutoff+1,amount:10001,ticketAmount:10}];
 const summary=await getActiveRaffleSummary(db(entries),cutoff+1800);
 assert.equal(summary.raffles[0].totalTickets,10);assert.equal(summary.raffles[0].drawTime,cutoff+3600);
 assert.equal((await getActiveRaffleSummary(db(entries),cutoff+3600)).raffles[0].totalTickets,10);
});

test('50/50 follows the last biweekly draw of the Eastern calendar month across DST',()=>{
 const window=getAssociateTicketReportRaffleWindow({type:'monthly',time:unix('2026-10-30T16:00:00Z')});
 assert.equal(window.salesStart,unix('2026-10-24T23:00:00Z')+1);
 assert.equal(window.salesEnd,unix('2026-11-22T00:00:00Z'));
 assert.equal(window.raffleTime,unix('2026-11-22T01:00:00Z'));
 const selection=getRaffleRefreshSelection('110726',unix('2026-10-30T16:00:00Z'),{biweekly:'ends'});
 assert.equal(selection.raffles.find(w=>w.type==='biweekly').start,unix('2026-10-24T23:00:00Z'));
});

test('spring-forward and the following daylight-time period retain the Eastern schedule',()=>{
 const before=getAssociateTicketReportRaffleWindow({type:'biweekly',time:unix('2027-03-10T16:00:00Z')});
 const after=getAssociateTicketReportRaffleWindow({type:'biweekly',time:unix('2027-03-20T16:00:00Z')});
 assert.equal(before.salesEnd,unix('2027-03-14T00:00:00Z'));
 assert.equal(after.salesEnd,unix('2027-03-27T23:00:00Z'));
 assert.equal(after.salesStart,before.salesEnd+1);
 assert.equal(after.salesEnd-before.salesEnd,14*86400-3600);
 const following=getAssociateTicketReportRaffleWindow({type:'biweekly',time:unix('2027-04-01T16:00:00Z')});
 assert.equal(following.salesEnd,unix('2027-04-10T23:00:00Z'));
 assert.equal(following.salesStart,after.salesEnd+1);
 assert.equal(following.raffleTime,unix('2027-04-11T00:00:00Z'));
 const monthly=getAssociateTicketReportRaffleWindow({type:'monthly',time:unix('2027-03-10T16:00:00Z')});
 assert.equal(monthly.salesStart,unix('2027-02-28T00:00:00Z')+1);
 assert.equal(monthly.salesEnd,after.salesEnd);
});

test('saved bonus overrides retain their raffle when a legacy UTC cutoff moves',async()=>{
 const legacy=unix('2026-11-07T23:00:00Z'),correct=unix('2026-11-08T00:00:00Z');
 const old={raffle_type:'biweekly',sales_end:legacy,enabled:1,tiers_json:'[{"hours":10,"percent":10}]'};
 const database={execute:async()=>[[old]]};
 assert.equal((await getRaffleBonusOverrides(database))[0].salesEnd,correct);
 // A subsequently saved canonical override takes precedence, including explicitly disabled.
 database.execute=async()=>[[{...old,sales_end:correct,enabled:0},old]];
 const saved=await getRaffleBonusOverrides(database);assert.equal(saved.length,1);assert.equal(saved[0].enabled,false);
});

test('resetting a corrected bonus override also removes its legacy alias atomically',async()=>{
 const legacy=unix('2026-11-07T23:00:00Z'),correct=unix('2026-11-08T00:00:00Z');
 const calls=[];
 await saveRaffleBonusOverride({execute:async(...args)=>{calls.push(args);return [{}];}},{raffleType:'biweekly',salesEnd:correct,resetToDefaults:true});
 assert.equal(calls.length,1);assert.match(calls[0][0],/sales_end IN/);
 assert.deepEqual(calls[0][1],['biweekly',correct,legacy]);
});

test('legacy cutoff correction is idempotent and leaves arbitrary or off-cadence dates alone',()=>{
 const correct=unix('2026-11-08T00:00:00Z');
 assert.equal(normalizeScheduledSalesEnd(unix('2026-11-07T23:00:00Z')),correct);
 assert.equal(normalizeScheduledSalesEnd(correct),correct);
 for(const value of [1000,correct+1,unix('2026-11-06T23:00:00Z'),unix('2026-10-24T23:00:00Z')])assert.equal(normalizeScheduledSalesEnd(value),value);
});

test('backend and both clients use identical calendar schedule helpers',async()=>{
 const backend=await readFile(new URL('./raffle-schedule.js',import.meta.url),'utf8');
 for(const file of ['./web/src/raffle-schedule.js','../../GO/GuildSync-Frontend-Client/frontend/src/raffle-schedule.js']){
  assert.equal(await readFile(new URL(file,import.meta.url),'utf8'),backend);
 }
});
