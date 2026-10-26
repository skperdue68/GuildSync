import test from 'node:test';
import assert from 'node:assert/strict';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const {getActiveRaffleSummary}=await import('./guildsync-database-actions.js');
const cutoff=1781996400;
const row={eventId:'1',displayName:'A',type:'biweekly',time:cutoff-100,amount:10001,ticketAmount:10};
const db=entries=>({execute:async sql=>sql.includes('JSON_ARRAYAGG')?[[{banking_json:entries}]]:[[]]});
const revision=async rows=>(await getActiveRaffleSummary(db(rows),cutoff-1)).raffles[0].purchaseRevision;
test('raffle purchase revision detects new purchases but ignores receipt acknowledgements and row ordering',async()=>{
 const first=await revision([row]);assert.match(first,/^[a-f0-9]{64}$/);
 assert.equal(first,await revision([{...row,mail_sent:true,checked_out_by:'123'}]));
 const second={...row,eventId:'2',time:cutoff-99};
 assert.notEqual(first,await revision([row,second]));
 assert.equal(await revision([row,second]),await revision([second,row]));
 assert.notEqual(first,await revision([{...row,ticketAmount:20}]));
});
test('non-ticket, future, and other-period deposits do not change the current purchase revision',async()=>{
 const initial=await revision([row]);
 for(const extra of [{...row,eventId:'2',ticketAmount:0},{...row,eventId:'3',type:'other'},{...row,eventId:'4',time:cutoff+1}])assert.equal(initial,await revision([row,extra]));
});
