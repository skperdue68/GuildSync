import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupPublicRaffleSummaries} from './public-raffle-cleanup.js';
import {formatRaffles} from './raffle.js';
const content=formatRaffles({asOf:1000,raffles:[{type:'biweekly',prizeGold:200000,totalTickets:1,drawCount:1,drawTime:2000,salesEnd:1900}]});
const entry=(id,overrides={})=>({id:String(id),author:{id:'bot'},content,flags:{has:()=>false},...overrides});
const collection=items=>{const map=new Map(items.map(m=>[m.id,m]));map.last=()=>items.at(-1);return map;};
test('keeps newest bot summary while deleting older generated summaries, including slash replies',async()=>{
 const deleted=[],logs=[];const current=entry(1000);
 const old=entry(900,{interactionMetadata:{},delete:async()=>deleted.push('900')});
 const older=entry(800,{delete:async()=>deleted.push('800')});
 const untouched=[entry(700,{author:{id:'human'}}),entry(600,{author:{id:'other-bot'}}),entry(500,{content:'Archived raffle sheet HERE'}),entry(400,{content:content+'\n\n**Your tickets (person)**\nPrivate data'}),entry(300,{flags:{has:()=>true}})];
 await cleanupPublicRaffleSummaries({messages:{fetch:async()=>collection([current,old,older,...untouched])}},current,'bot',line=>logs.push(line));
 assert.deepEqual(deleted,['900','800']);
});
test('paginates history and deletes individually so very old messages can be removed',async()=>{
 const deleted=[],requests=[];const current=entry(1000);
 const first=Array.from({length:100},(_,i)=>entry(999-i,{content:'unrelated'}));
 const old=entry(100,{delete:async()=>deleted.push('100')});
 const channel={messages:{fetch:async options=>{requests.push(options);return collection(options.before?[old]:first);}}};
 await cleanupPublicRaffleSummaries(channel,current,'bot',()=>{});
 assert.deepEqual(requests,[{limit:100},{limit:100,before:'900'}]);assert.deepEqual(deleted,['100']);
});
test('concurrent newer summary wins and cleanup failures do not fail the published post',async()=>{
 const deleted=[],logs=[];const current=entry(1000,{delete:async()=>deleted.push('1000')});
 const newer=entry(1100);const denied=entry(900,{delete:async()=>{throw Error('Missing permissions');}});
 await assert.doesNotReject(cleanupPublicRaffleSummaries({messages:{fetch:async()=>collection([newer,current,denied])}},current,'bot',line=>logs.push(line)));
 assert.deepEqual(deleted,['1000']);assert.ok(logs.some(l=>l.includes('Missing permissions')));
 await assert.doesNotReject(cleanupPublicRaffleSummaries({messages:{fetch:async()=>{throw Error('History denied');}}},current,'bot',line=>logs.push(line)));
 assert.ok(logs.some(l=>l.includes('History denied')));
});
test('unconfirmed or unrelated new posts never trigger history deletion',async()=>{
 const channel={messages:{fetch:async()=>assert.fail('must not read history')}};
 await cleanupPublicRaffleSummaries(channel,undefined,'bot');
 await cleanupPublicRaffleSummaries(channel,entry(1,{content:'archive notification'}),'bot');
});
test('an older persisted snapshot retried later cannot replace a fresher public summary',async()=>{
 const deleted=[];
 const retry=entry(200,{content:content.replace('As of <t:1000:f>','As of <t:900:f>'),delete:async()=>deleted.push('200')});
 const fresher=entry(100);
 await cleanupPublicRaffleSummaries({messages:{fetch:async()=>collection([retry,fresher])}},retry,'bot',()=>{});
 assert.deepEqual(deleted,['200']);
});
