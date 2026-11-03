import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('another sender receives no already-reserved deposit and candidates are locked before assignment',async()=>{
  const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
  const start=source.indexOf('export async function checkoutDepositMail('),end=source.indexOf('export async function markDepositMailWrittenToESO',start);
  const row={event_id:'10',mail_status:'unsent'},queries=[];
  const connection={beginTransaction:async()=>{},commit:async()=>{},release(){},query:async(raw,args=[])=>{
    const sql=raw.replace(/\s+/g,' ').trim();queries.push(sql);
    if(sql.startsWith('SELECT event_id FROM')){
      assert.match(sql,/mail_status = 'unsent'/);assert.match(sql,/FOR UPDATE$/);
      return [row.mail_status==='unsent'?[{event_id:row.event_id}]:[]];
    }
    if(sql.startsWith('UPDATE')){
      assert.match(sql,/WHERE mail_status = 'unsent'/);
      row.mail_status='checked_out';row.mail_batch_id=args[0];row.checked_out_by=args[1];return [{affectedRows:1}];
    }
    return [[{...row}].filter(r=>r.checked_out_by===args[1] && r.mail_batch_id===args[0])];
  }};
  const ctx=vm.createContext({releaseExpiredDepositMailCheckouts:async()=>0,randomUUID:()=> 'batch',normalizePositiveInteger:(n,d)=>n||d,
    getRaffleBonusVersions:async()=>[],getRaffleBonusOverrides:async()=>[],addRenderedDepositMailContent:row=>row,safeRollback:async()=>{}});
  vm.runInContext(source.slice(start,end).replace('export async','async'),ctx);
  const db={getConnection:async()=>connection};
  const first=await ctx.checkoutDepositMail(db,{checked_out_by:'sender1',mail_batch_id:'one'});
  const second=await ctx.checkoutDepositMail(db,{checked_out_by:'sender2',mail_batch_id:'two'});
  assert.equal(first.records_checked_out,1);assert.equal(second.records_checked_out,0);
  assert.equal(row.checked_out_by,'sender1');
  assert.ok(queries.findIndex(q=>q.includes('FOR UPDATE'))<queries.findIndex(q=>q.startsWith('UPDATE')));
});
