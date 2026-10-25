import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommunityStatistics} from './community-statistics.js';

test('raffle spending uses inclusive original purchase times over rolling 90 days',()=>{
 const now=10000000, cutoff=now-90*86400;
 const banking=[{displayName:'Alice',type:'monthly',time:cutoff,purchasedTickets:2,amount:2001},{displayName:'alice',type:'biweekly',time:now,purchasedTickets:3,amount:3003},{displayName:'Old',type:'monthly',time:cutoff-1,purchasedTickets:99,amount:99000},{displayName:'Future',type:'monthly',time:now+1,purchasedTickets:99,amount:99000},{displayName:'Bonus',type:'monthly',time:now,purchasedTickets:0,totalTickets:10,amount:10000}];
 const report=buildCommunityStatistics({now,banking,windows:[{type:'monthly',salesStart:1,salesEnd:now}]});
 const card=report.highlights.find(h=>h.id==='raffle-spending');
 assert.equal(card.title,'Raffle spending (last 90 days)');
 assert.deepEqual(card.rows.map(r=>[r.name,r.value]),[['Alice',5000]]);
 assert.equal(report.overview.find(r=>r.label==='Raffle spending (last 90 days, gold)').value,5000);
 assert.equal(report.highlights.find(h=>h.id==='tickets-monthly').rows[0].name,'Old');
 assert.equal(buildCommunityStatistics({now:now+90*86400+2,banking}).highlights.find(h=>h.id==='raffle-spending').rows.length,0);
});
