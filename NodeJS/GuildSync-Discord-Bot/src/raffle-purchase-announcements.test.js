import test from 'node:test';
import assert from 'node:assert/strict';
import {createRaffleAnnouncer} from './raffle.js';
import {createLiveConfiguration} from './live-configuration.js';
import {startRaffleAnnouncements} from './raffle-announcements.js';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
function fixture(announceOnPurchase=true){
 let time=1000,state;const sent=[];
 const raffle={id:'b:1',type:'biweekly',salesEnd:100000,drawTime:103600,salesOpen:true,prizeGold:100,totalTickets:10,purchaseRevision:'initial'};
 const options={channelId:'123',intervalHours:1,thresholds:{biweekly:100,monthly:100},announceOnPurchase,
  now:()=>time,fetchRaffles:async()=>({asOf:time,raffles:[{...raffle}]}),loadState:async()=>state,
  saveState:async value=>{state=structuredClone(value);},send:async(snapshot,delivery)=>sent.push({snapshot,delivery})};
 return {raffle,options,sent,at:value=>{time=value;},state:()=>state};
}
test('purchase mode posts changes immediately, suppresses interval/threshold posts, and deduplicates on restart',async()=>{
 const f=fixture(),worker=createRaffleAnnouncer(f.options);await worker.tick();assert.equal(f.sent.length,1);
 f.at(1001);f.raffle.purchaseRevision='new-purchase';await worker.tick();assert.equal(f.sent.length,2);
 await worker.tick();await createRaffleAnnouncer(f.options).tick();assert.equal(f.sent.length,2);
 f.at(6000);f.raffle.prizeGold=1000;await worker.tick();assert.equal(f.sent.length,2);
 await createRaffleAnnouncer({...f.options,announceOnPurchase:false}).tick();assert.equal(f.sent.length,3);
});
test('purchase mode is opt-in and retains existing scheduled behavior when off',async()=>{
 const f=fixture(false),worker=createRaffleAnnouncer(f.options);await worker.tick();
 f.at(1001);f.raffle.purchaseRevision='new';await worker.tick();assert.equal(f.sent.length,1);
 f.at(4600);await worker.tick();assert.equal(f.sent.length,2);
});
test('recovering a pending delivery also checks newer purchases in the same tick',async()=>{
 const f=fixture();let fail=false;
 const worker=createRaffleAnnouncer({...f.options,send:async(...args)=>{if(fail){fail=false;throw Error('send failed');}return f.options.send(...args);}});
 await worker.tick();f.at(1001);f.raffle.purchaseRevision='pending-purchase';fail=true;
 await assert.rejects(worker.tick(),/send failed/);assert.ok(f.state().pending);
 f.at(1002);f.raffle.purchaseRevision='latest-purchase';await createRaffleAnnouncer(f.options).tick();
 assert.deepEqual(f.sent.map(item=>item.snapshot.raffles[0].purchaseRevision),['initial','pending-purchase','latest-purchase']);
 assert.equal(f.state().raffles.biweekly.purchaseRevision,'latest-purchase');
});
test('purchase switch supports .env baseline, live overrides and returning to default',async()=>{
 const key='GUILDSYNC_RAFFLE_ANNOUNCE_ON_PURCHASE',seen=[];
 const service=createLiveConfiguration({env:{[key]:'true'},start:env=>{seen.push(env[key]);return [];}});
 const keys=[{key,defaultValue:false}];await service.apply({revision:0,keys,overrides:{}});
 await service.apply({revision:1,keys,overrides:{[key]:false}});await service.apply({revision:2,keys,overrides:{}});
 assert.deepEqual(seen,['true','false','true']);assert.equal(service.defaults(keys)[key],'true');
});

test('purchase wake arriving during a post is rechecked and listeners are removed on stop',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'guildsync-purchase-wake-'));
 const sent=[],logs=[];let releaseFirst,firstStarted,revision='initial';
 const started=new Promise(resolve=>firstStarted=resolve),gate=new Promise(resolve=>releaseFirst=resolve);
 const socket=new EventEmitter();socket.connected=true;
 socket.timeout=()=>({emit:(event,payload,callback)=>callback(null,{ok:true,asOf:Math.floor(Date.now()/1000),raffles:[{id:'b:1',type:'biweekly',prizeGold:100,totalTickets:10,drawCount:1,salesEnd:Math.floor(Date.now()/1000)+86400,drawTime:Math.floor(Date.now()/1000)+90000,salesOpen:true,purchaseRevision:revision}]})});
 const channel={id:'456',guildId:'789',isTextBased:()=>true,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>new Map()},send:async options=>{
  sent.push(options);if(sent.length===1){firstStarted();await gate;}
  return {...options,id:String(100+sent.length),author:{id:'123'}};
 }};
 const client={isReady:()=>true,user:{id:'123'},channels:{fetch:async()=>channel}};
 const stop=startRaffleAnnouncements(client,socket,line=>logs.push(line),{DISCORD_GUILD_ID:'789',GUILDSYNC_RAFFLE_CHANNEL_ID:'456',GUILDSYNC_RAFFLE_ANNOUNCE_ON_PURCHASE:'true',GUILDSYNC_RAFFLE_STATE_FILE:path.join(dir,'state.json')});
 t.after(async()=>{releaseFirst();await stop();await rm(dir,{recursive:true,force:true});});
 await Promise.race([started,new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('First post did not start: '+logs.join('\n'))),3000);timer.unref();})]);
 revision='new-purchase';socket.emit('guildsync:raffle-purchases-updated');releaseFirst();
 for(let attempts=0;attempts<100&&sent.length<2;attempts++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(sent.length,2);assert.equal(socket.listenerCount('guildsync:raffle-purchases-updated'),1);
 await stop();assert.equal(socket.listenerCount('guildsync:raffle-purchases-updated'),0);assert.equal(socket.listenerCount('connect'),0);
 assert.ok(!logs.some(line=>line.includes('failed')),logs.join('\n'));
});
