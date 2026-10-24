import test from 'node:test';
import assert from 'node:assert/strict';
import { bankingSource } from './banking-source.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';

test('attribution retains the source prefix and fits the expanded column', () => {
  assert.equal(bankingSource('GuildSyncBanking', 'evainefaye'), 'GuildSyncBanking (evainefaye)');
  assert.equal(bankingSource('GuildSyncBanking', ''), 'GuildSyncBanking');
  assert.ok(Array.from(bankingSource('S'.repeat(64), 'x'.repeat(300))).length <= 255);
});

test('manual inserts store attribution for both raffle types', async () => {
  const { addManualBiweeklyTicketEntry } = await import('./guildsync-database-actions.js');
  const previous = process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED;
  process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED = 'false';
  try {
    for (const [type, prefix] of [['biweekly', 'ManualBiweeklyTicket'], ['monthly', 'ManualMonthlyTicket']]) {
      const db = { async execute(sql, params) {
        if (sql.includes('INSERT IGNORE')) {
          assert.equal(params[7], `${prefix} (evainefaye)`);
          assert.equal(params[8], 'FFTG');
        }
        return [{ affectedRows: 1 }];
      } };
      db.getConnection=async()=>({execute:db.execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){}});
      const result = await addManualBiweeklyTicketEntry(db, { account_name: 'Buyer', ticket_type: type, tickets: 5, gold_value: 0, addedBy: 'evainefaye', note: 'FFTG' });
      assert.equal(result.entry.dataSource, `${prefix} (evainefaye)`);
      assert.equal(result.entry.note, 'FFTG');
    }
  } finally {
    if (previous === undefined) delete process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED;
    else process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED = previous;
  }
});


test('manual banking and recovery queue commit together even while exports are disabled',async()=>{
 const {addManualBiweeklyTicketEntry}=await import('./guildsync-database-actions.js');
 const keys=['GUILDSYNC_GOOGLE_SHEETS_ENABLED','GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID'];const previous=keys.map(key=>process.env[key]);Object.assign(process.env,{GUILDSYNC_GOOGLE_SHEETS_ENABLED:'false',GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID:'working'});
 try{for(const fail of [false,true]){const events=[];const connection={async beginTransaction(){events.push('begin');},async commit(){events.push('commit');},async rollback(){events.push('rollback');},release(){events.push('release');},async execute(sql){if(sql.includes('guildsync_sheets_export_queue')){events.push('queue');if(fail)throw Error('queue failed');}else events.push('banking');return [{affectedRows:1}];}};
 const db={getConnection:async()=>connection,execute:async()=>{events.push('setting');return [{affectedRows:1}];}};
 const operation=addManualBiweeklyTicketEntry(db,{account_name:'Buyer',ticket_type:'monthly',tickets:1,gold_value:2500});
 if(fail){await assert.rejects(operation,/queue failed/);assert.deepEqual(events,['begin','banking','queue','rollback','release']);}else{await operation;assert.deepEqual(events,['begin','banking','queue','commit','release','setting']);}
 }}finally{keys.forEach((key,index)=>previous[index]===undefined?delete process.env[key]:process.env[key]=previous[index]);}
});
