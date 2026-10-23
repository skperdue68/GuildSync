import test from 'node:test';
import assert from 'node:assert/strict';
import {Collection} from 'discord.js';
import fs from 'node:fs';
import {syncDiscordRolesAndMembers} from './discord-sync.js';
import {createOnboardingWorker} from './member-onboarding.js';
import {readOnboardingConfig} from './member-onboarding-config.js';

test('existing Discord role discovery includes newly created Gangsters without a whitelist',async()=>{
 const payloads=[];const guild={id:'1',name:'Guild',roles:{fetch:async()=>new Collection([
  ['1',{id:'1',name:'@everyone',position:0}],['2',{id:'2',name:'Gangsters',position:1,color:0}]
 ])},members:{list:async()=>new Collection()}};
 const socket={connected:true,emit:(event,payload,cb)=>{payloads.push({event,payload});cb({ok:true,roles_processed:1,members_processed:0,members_removed:0});}};
 await syncDiscordRolesAndMembers(guild,socket);
 assert.deepEqual(payloads[0].payload.roles.map(role=>role.role_name),['Gangsters']);
  assert.equal(payloads[0].payload.roles[0].role_position,1);
});
test('worker serializes startup/reconnect, observes true join timestamps and excludes bots',async()=>{
 const listeners=new Map(),socketListeners=new Map(),calls=[];
 const member={id:'2',guild:{id:'1'},user:{bot:false},joinedTimestamp:1001000};
 const bot={...member,id:'3',user:{bot:true}};
 const client={isReady:()=>true,on:(event,fn)=>listeners.set(event,fn),off(){},guilds:{fetch:async()=>({members:{list:async()=>new Collection([['2',member],['3',bot]])}})}};
 const socket={connected:true,id:'socket1',on:(event,fn)=>socketListeners.set(event,fn),off(){},timeout(){return this;},emit(event,payload,cb){
  calls.push({event,payload});setImmediate(()=>cb(null,{ok:true,result:event.endsWith('claim')?null:{}}));
 }};
 const worker=createOnboardingWorker({client,socket,guildId:'1',config:readOnboardingConfig({GUILDSYNC_ONBOARDING_ENABLED:'true',GUILDSYNC_ONBOARDING_CHANNEL_ID:'123'}),log:()=>{}});
 await Promise.all([worker.tick(),worker.tick()]);assert.equal(calls.filter(c=>c.event.endsWith('configure')).length,1);
 const observations=calls.filter(c=>c.event.endsWith('observe'));assert.equal(observations.length,1);assert.equal(observations[0].payload.member.joined_at,1001);
 socketListeners.get('disconnect')();socket.id='socket2';await worker.tick();worker.stop();
 assert.equal(calls.filter(c=>c.event.endsWith('configure')).length,2);
});
test('production startup wires worker, schema, and common confirmed-link hook',()=>{
 const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
 assert.match(read('./guildsync-discord-bot.js'),/createOnboardingWorker\(/);
 const actions=read('../../GuildSync-Backend-Server/guildsync-database-actions.js');
 assert.match(actions,/await initializeDiscordOnboardingSchema\(db\)/);
 assert.match(actions,/if \(\(link.linkStatus \|\| link.link_status\) === 'linked'\) await notifyDiscordConfirmedLink/);
});
