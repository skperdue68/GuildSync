import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollover } from './raffle-sheet-rollover.js';
const old = Date.parse('2026-11-07T23:00:00Z') / 1000;
const fixed = old + 3600;
const windows = end => ['biweekly', 'monthly'].map(type => ({type,salesEnd:end,drawTime:end+3600}));
function fixture(pending = null) {
  let state = {version:1, windows:windows(old), lastClosedSalesEnd:{biweekly:old-1209600}, pending};
  let saves=0; const copies=[]; const resets=[];
  const io = {time:old-100, failSave:false, copies, resets, state:()=>structuredClone(state), saves:()=>saves};
  io.tick=()=>createRollover({now:()=>io.time, getWindows:()=>windows(fixed+1209600),
    normalizeWindow:w=>{ const shift=[old,old+1209600].includes(w.salesEnd)?3600:0; return {...w,salesEnd:w.salesEnd+shift,drawTime:w.drawTime+shift}; },
    loadState:async()=>state,saveState:async next=>{if(io.failSave)throw Error('save failed');state=structuredClone(next);saves++;},
    archive:async job=>{copies.push(job);return 'new-copy';},reset:async job=>{resets.push(job);}
  }).tick(); return io;
}
function pending(extra={}) { return {key:`raffle-rollover-${old}`,salesEnd:old,manual:false,readyAt:old+3600+600,deadlineBasis:'draw',name:'261107 raffle',raffles:windows(old),nextWindows:windows(old+1209600),archiveId:null,...extra}; }
test('corrects armed November 7 cutoff to 7 PM Eastern without changing closed history',async()=>{
 const io=fixture();await io.tick();assert.equal(io.state().windows[0].salesEnd,fixed);assert.equal(io.state().windows[0].drawTime,fixed+3600);assert.equal(io.state().lastClosedSalesEnd.biweekly,old-1209600);
});
for(const basis of ['draw',undefined])test(`unstarted ${basis||'sales'} deadline preserves saved delay and key once`,async()=>{
 const job=pending({deadlineBasis:basis,readyAt:old+(basis?3600:0)+600});const io=fixture(job);io.time=old+3600;
 await io.tick();const migrated=io.state().pending;assert.equal(migrated.salesEnd,fixed);assert.equal(migrated.nextWindows[0].salesEnd,fixed+1209600);assert.equal(migrated.raffles[0].drawTime,fixed+3600);assert.equal(migrated.readyAt,fixed+3600+600);assert.equal(migrated.key,job.key);assert.equal(migrated.deadlineBasis,'draw');assert.equal(io.copies.length,0);
 await io.tick();assert.equal(io.state().pending.readyAt,migrated.readyAt);assert.equal(io.saves(),1);
 io.time=migrated.readyAt;await io.tick();assert.equal(io.copies.length,1);
});
for(const extra of [{manual:true},{archiveId:'existing-copy'},{readyAt:undefined}])test(`preserves started/manual recovery ${JSON.stringify(extra)}`,async()=>{
 const job=pending(extra);const io=fixture(job);io.time=old+3600+600;await io.tick();assert.deepEqual(io.resets[0].nextWindows,job.nextWindows);if(!extra.archiveId)assert.deepEqual(io.copies[0].raffles,job.raffles);
});
test('failed migration persistence prevents archive and reset',async()=>{const io=fixture(pending());io.time=old+3600+600;io.failSave=true;await assert.rejects(io.tick(),/save failed/);assert.equal(io.copies.length,0);assert.equal(io.resets.length,0);assert.equal(io.state().pending.salesEnd,old);});
test('single-raffle pending hold corrects only its closing payload and both next windows',async()=>{
 const job=pending({raffles:windows(old).slice(0,1)});const io=fixture(job);await io.tick();
 assert.deepEqual(io.state().pending.raffles,windows(fixed).slice(0,1));
 assert.deepEqual(io.state().pending.nextWindows,windows(fixed+1209600));
});
test('copied recovery normalizes its newly armed windows before another cutoff decision',async()=>{
 const job=pending({archiveId:'existing-copy'});const io=fixture(job);io.time=old+1209600+1800;
 await io.tick();
 assert.equal(io.resets.length,1);assert.deepEqual(io.resets[0].nextWindows,job.nextWindows);
 assert.equal(io.copies.length,0);assert.equal(io.state().pending,null);
 assert.deepEqual(io.state().windows,windows(fixed+1209600));
});
