import test from 'node:test';
import assert from 'node:assert/strict';
import {startSheetsRollover} from './sheets-rollover-runtime.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const {getSheetsRaffleWindows}=await import('./guildsync-database-actions.js');
const unix=value=>Date.parse(value)/1000;

test('actual rollover runtime corrects saved legacy cutoffs before allowing an early automatic archive',async t=>{
 const env={GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID:'dst-source',GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED:'true',GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS:'0'};
 const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 let state={version:1,windows:[{type:'biweekly',salesEnd:unix('2026-11-07T23:00:00Z'),drawTime:unix('2026-11-08T00:00:00Z')},{type:'monthly',salesEnd:unix('2026-11-21T23:00:00Z'),drawTime:unix('2026-11-22T00:00:00Z')}],lastClosedSalesEnd:{},pending:null};
 let saved=0;
 const connection={release(){},async execute(sql,args){
  if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
  if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
  if(sql.startsWith('SELECT value'))return [[{value:JSON.stringify(state)}]];
  if(sql.startsWith('INSERT INTO guildsync_settings')){state=JSON.parse(args[1]);saved++;return [{}];}
  throw Error('Unexpected database operation: '+sql);
 }};
 const runtime=startSheetsRollover({getConnection:async()=>connection},getSheetsRaffleWindows,{now:()=>unix('2026-11-07T23:30:00Z'),schedule:false,loadCatchupEntries:async()=>assert.fail('must not copy/reset before true cutoff')});
 t.after(()=>runtime.stop());await runtime.run();
 assert.equal(saved,1);assert.equal(state.pending,null);
 assert.equal(state.windows[0].salesEnd,unix('2026-11-08T00:00:00Z'));
 assert.equal(state.windows[0].drawTime,unix('2026-11-08T01:00:00Z'));
});
