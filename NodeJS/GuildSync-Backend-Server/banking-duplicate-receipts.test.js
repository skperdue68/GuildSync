import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('receipt acknowledgements are locked, confirm retries, and never rewrite an already sent row',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const a=source.indexOf('export async function markDepositMailSent('),b=source.indexOf('export async function insertBankingEntries(',a);
 let writes=0;const row={mail_request_id:'deposit_1',mail_status:'written_to_eso',checked_out_by:'one'};
 const connection={beginTransaction:async()=>{},commit:async()=>{},release(){},query:async(raw,args)=>{
   const sql=raw.replace(/\s+/g,' ').trim();
   if(sql.startsWith('UPDATE')){
     assert.doesNotMatch(sql,/IN \('written_to_eso', 'checked_out', 'sent'\)/);
     if(row.mail_status==='sent')return [{affectedRows:0}];row.mail_status='sent';writes++;return [{affectedRows:1}];
   }
   if(sql.includes("AND mail_status IN"))assert.match(sql,/FOR UPDATE$/);
   return [[row].filter(r=>r.checked_out_by===args.at(-1))];
 }};
 const ctx=vm.createContext({safeRollback:async()=>{},normalizeDepositMailRow:r=>r});
 vm.runInContext(source.slice(a,b).replace('export async','async'),ctx);
 const db={getConnection:async()=>connection};
 const request={checked_out_by:'one',mail_request_ids:['deposit_1','deposit_1']};
 const first=await ctx.markDepositMailSent(db,request);const retry=await ctx.markDepositMailSent(db,request);
 assert.equal(first.records_marked_sent,1);assert.equal(retry.records_marked_sent,0);
 assert.equal(retry.records_confirmed_sent,1);assert.equal(writes,1);
 const wrong=await ctx.markDepositMailSent(db,{...request,checked_out_by:'two'});
 assert.equal(wrong.records_confirmed_sent,0);
});

test('reimported banking event does not reset mail state or enqueue another sheet export',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const a=source.indexOf('export async function insertBankingEntries('),b=source.indexOf('export async function getRosterDataDate(',a);
 const saved=new Map(),queued=[];let synced=0;
 const connection={beginTransaction:async()=>{},commit:async()=>{},release(){},execute:async(sql,args)=>{
   if(sql.includes('INSERT IGNORE INTO guildsync_banking_entries')) {
     if(saved.has(args[0]))return [{affectedRows:0}];
     saved.set(args[0],{status:'unsent'});return [{affectedRows:1}];
   }return [{}];
 }};
 const ctx=vm.createContext({validateEsoGuildImport(){},bankingSource:()=> 'test',normalizeDepositMailTicketType:v=>v,
   googleSheetsBankingConfig:()=>({enabled:false}),enqueueSheetsExports:async(_db,entries)=>queued.push(...entries),
   syncBankingEntriesToGoogleSheets:async()=>{synced++;},safeRollback:async()=>{}});
 vm.runInContext(source.slice(a,b).replace('export async','async'),ctx);
 const db={getConnection:async()=>connection},payload={entries:[{eventId:123,type:'biweekly',displayName:'Alice',time:1000,amount:500}]};
 const first=await ctx.insertBankingEntries(db,payload);saved.get(123).status='sent';
 const retry=await ctx.insertBankingEntries(db,payload);
 assert.equal(first.banking_entries_inserted,1);assert.equal(retry.banking_entries_inserted,0);
 assert.equal(saved.get(123).status,'sent');assert.equal(queued.length,1);assert.equal(synced,1);
});
