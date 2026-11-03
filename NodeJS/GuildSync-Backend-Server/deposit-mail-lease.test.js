import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {releaseExpiredDepositMailCheckouts} from './deposit-mail-lease.js';

test('only expired, unwritten checkouts from the safe handoff protocol can be released',async()=>{
 let query;
 assert.equal(await releaseExpiredDepositMailCheckouts({execute:async sql=>{query=sql;return [{affectedRows:2}];}}),2);
 assert.match(query,/mail_status = 'checked_out'/);assert.match(query,/mail_handoff_version = 1/);
 assert.match(query,/checkout_expires_at <= NOW\(\)/);assert.match(query,/written_to_eso_at IS NULL/);
 assert.match(query,/mail_batch_id = NULL/);assert.match(query,/checked_out_by = NULL/);
 assert.doesNotMatch(query,/mail_request_id = NULL/);
});

test('the backend refuses expired safe handoffs and makes successful handoffs nonexpiring',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const a=source.indexOf('export async function markDepositMailWrittenToESO('),b=source.indexOf('export async function markDepositMailSent(',a);
 const row={event_id:'1',mail_status:'checked_out',mail_batch_id:'batch',checked_out_by:'one',expired:true,protocol:1};
 const connection={beginTransaction:async()=>{},commit:async()=>{},release(){},query:async(raw)=>{
  const sql=raw.replace(/\s+/g,' ').trim();
  if(sql.startsWith('UPDATE')){
   assert.match(sql,/mail_handoff_version = 0 OR checkout_expires_at > NOW\(\)/);
   assert.match(sql,/checkout_expires_at = NULL/);
   if(row.mail_status!=='checked_out'||(row.protocol===1&&row.expired))return [{affectedRows:0}];
   row.mail_status='written_to_eso';return [{affectedRows:1}];
  }
  return [row.mail_status==='written_to_eso'?[{...row}]:[]];
 }};
 const ctx=vm.createContext({releaseExpiredDepositMailCheckouts:async()=>0,safeRollback:async()=>{},normalizeDepositMailRow:r=>r});
 vm.runInContext(source.slice(a,b).replace('export async','async'),ctx);
 const db={getConnection:async()=>connection},payload={checked_out_by:'one',mail_batch_id:'batch',event_ids:['1']};
 assert.equal((await ctx.markDepositMailWrittenToESO(db,payload)).records.length,0);
 row.expired=false;assert.equal((await ctx.markDepositMailWrittenToESO(db,payload)).records_written_to_eso,1);
 row.expired=true;
 const retry=await ctx.markDepositMailWrittenToESO(db,payload);
 assert.equal(retry.records_written_to_eso,0);assert.equal(retry.records.length,1);
});

for(const client of ['web/src','../../GO/GuildSync-Frontend-Client/frontend/src']) {
 function harness(response,connected=true) {
  const source=fs.readFileSync(new URL(`./${client}/main.js`,import.meta.url),'utf8');
  const a=source.indexOf('async function processPendingDepositMailBatches('),b=source.indexOf('async function refreshESORunningStatus(',a);
  const calls=[],removed=[];
  const ctx=vm.createContext({depositMailPendingWriteAutoTimer:null,depositMailPendingWriteRunning:false,canEditGuildSyncData:()=>true,
    loadPendingDepositMailBatches:()=>[{mail_batch_id:'old',records:[{eventId:'1'},{eventId:'2'}]}],normalizeBankingEntries:r=>r,
    refreshESORunningStatus:async()=>{},esoRunningStatus:{running:false},updateBankingDataView(){},addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:1,
    WriteDepositMailToGuildSyncBanking:async records=>{calls.push({write:records});return {ok:true};},socket:{connected},
    emitSocketWithAck:async()=>{calls.push({authorize:true});return response;},removePendingDepositMailBatch:id=>removed.push(id),
    refreshBankingDataFromBackend:async()=>{},formatError:String});
  vm.runInContext(source.slice(a,b),ctx);return {ctx,calls,removed};
 }
 test(`${client} obtains backend authorization before writing only still-reserved records`,async()=>{
  const h=harness({ok:true,records:[{eventId:'2'}]});await h.ctx.processPendingDepositMailBatches();
  assert.ok(h.calls[0].authorize);assert.deepEqual(h.calls[1].write.map(r=>r.eventId),['2']);
  assert.deepEqual(h.removed,['old']);
 });
 test(`${client} discards expired local batches without touching SavedVariables`,async()=>{
  const h=harness({ok:true,records:[]});await h.ctx.processPendingDepositMailBatches();
  assert.equal(h.calls.some(c=>c.write),false);assert.deepEqual(h.removed,['old']);
 });
 test(`${client} cannot write queued mail while backend is disconnected`,async()=>{
  const h=harness({ok:true,records:[{eventId:'1'}]},false);await h.ctx.processPendingDepositMailBatches();
  assert.equal(h.calls.length,0);assert.equal(h.removed.length,0);
 });
}
