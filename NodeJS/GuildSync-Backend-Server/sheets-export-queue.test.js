import test from 'node:test';
import assert from 'node:assert/strict';
import {startSheetsExportRecovery,enqueueSheetsExports,initializeSheetsExportQueue} from './sheets-export-queue.js';
function fixture(){
 const rows=new Map();const calls=[];let fail=true,enabled=true,time=1000;
 const store={async enqueue(entries,settings){for(const e of entries){const id=String(e.eventId);if(!rows.has(id))rows.set(id,{event_id:id,uploaded_by:'Uploader',attempts:0,next_attempt_at:0});}},async pending(){return [...rows.values()].filter(r=>!r.done&&r.next_attempt_at<=time);},async attempted(items){for(const r of items){r.attempts++;r.next_attempt_at=time+60;}},async completed(ids){ids.forEach(id=>rows.get(String(id)).done=true);},async failed(items,error){items.forEach(r=>r.error=error.message);}};
 const config=()=>({enabled,spreadsheetId:'working'});
 const sync=async(entries,{onCompleted})=>{calls.push(entries);if(fail)throw Error('credential file unavailable');await onCompleted(entries.filter(e=>!e.deferred).map(e=>String(e.eventId)));return {enabled:true,synced:entries.length};};
 const options={store,config,sync,loadEntries:async()=>[{eventId:'1',type:'biweekly'},{eventId:'2',type:'monthly',deferred:true}],selectBootstrapEntries:e=>e,now:()=>time,schedule:false,log:async()=>{}};
 return {rows,calls,options,setFail:v=>fail=v,setTime:v=>time=v,setEnabled:v=>enabled=v};
}
test('failed Google writes survive worker restart and retry without another deposit',async()=>{
 const f=fixture();await startSheetsExportRecovery({},f.options).tick();assert.equal(f.rows.get('1').done,undefined);assert.match(f.rows.get('1').error,/credential/);
 f.setFail(false);f.setTime(1061);await startSheetsExportRecovery({},f.options).tick();assert.equal(f.rows.get('1').done,true);assert.equal(f.rows.get('2').done,undefined);
 f.setTime(1200);await startSheetsExportRecovery({},f.options).tick();assert.ok(f.calls.at(-1).every(e=>e.eventId!=='1'),'completed entry is not re-exported');
});
test('disabled exports do not load or write; overlapping ticks share the same operation',async()=>{
 const f=fixture();f.setEnabled(false);const worker=startSheetsExportRecovery({},f.options);await worker.tick();assert.equal(f.rows.size,0);f.setEnabled(true);f.setFail(false);await Promise.all([worker.tick(),worker.tick()]);assert.equal(f.calls.length,1);
});
test('queue schema is idempotent and enqueue deduplicates source/transaction keys without resetting completions',async()=>{
 const writes=[];const db={query:async sql=>writes.push({sql}),execute:async(sql,args)=>{writes.push({sql,args});return [{affectedRows:1}];}};
 await initializeSheetsExportQueue(db);await enqueueSheetsExports(db,[{eventId:'1',type:'biweekly'},{eventId:'1',type:'biweekly'},{eventId:'2',type:'other'}],{spreadsheetId:'working',uploadedBy:'Uploader'});
 assert.match(writes[0].sql,/CREATE TABLE IF NOT EXISTS/);assert.match(writes[0].sql,/PRIMARY KEY \(spreadsheet_id, event_id\)/);assert.match(writes[1].sql,/INSERT IGNORE/);assert.deepEqual(writes[1].args,['working','1','Uploader']);
});
