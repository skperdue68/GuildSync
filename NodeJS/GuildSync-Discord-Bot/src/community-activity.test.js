import test from 'node:test';
import assert from 'node:assert/strict';
import {recordDiscordPost, recordDiscordReaction} from './community-activity.js';

const user={id:'123',username:'Actor',bot:false};
const message={id:'456',guildId:'789',author:user,member:{displayName:'Guild name'},content:'private text',attachments:['private']};
const fixture=()=>{const calls=[];return {calls,socket:{connected:true,emit:(...args)=>calls.push(args)}};};
test('posts send stable identifiers and display name without message content',()=>{
 const {calls,socket}=fixture();recordDiscordPost(socket,message,'789');recordDiscordPost(socket,message,'789');
 assert.equal(calls.length,2);assert.equal(calls[0][0],'guildsync:record-discord-activity');
 assert.equal(calls[0][1].eventKey,calls[1][1].eventKey);assert.equal(calls[0][1].type,'post');
 assert.equal(calls[0][1].displayName,'Guild name');assert.ok(!JSON.stringify(calls).includes('private'));
});
test('reaction deduplication distinguishes actor and emoji but not delivery repeats',()=>{
 const {calls,socket}=fixture();const reaction={message,emoji:{id:null,name:'👍'}};
 recordDiscordReaction(socket,reaction,user,'789');recordDiscordReaction(socket,reaction,user,'789');
 recordDiscordReaction(socket,{...reaction,emoji:{id:'987',name:'custom'}},user,'789');
 recordDiscordReaction(socket,reaction,{...user,id:'124'},'789');
 assert.equal(calls[0][1].type,'reaction');assert.equal(calls[0][1].eventKey,calls[1][1].eventKey);
 assert.notEqual(calls[0][1].eventKey,calls[2][1].eventKey);assert.notEqual(calls[0][1].eventKey,calls[3][1].eventKey);
 assert.equal(calls[0][1].userId,'123');assert.ok(!JSON.stringify(calls).includes('private'));
});
test('bots, system posts, DMs, other guilds, and disconnected sockets are excluded',()=>{
 const {calls,socket}=fixture();
 for(const modified of [{author:{...user,bot:true}},{system:true},{guildId:null},{guildId:'999'}])recordDiscordPost(socket,{...message,...modified},'789');
 recordDiscordPost({...socket,connected:false},message,'789');
 recordDiscordReaction(socket,{message,emoji:{name:'👍'}},{...user,bot:true},'789');
 recordDiscordReaction(socket,{message:{...message,guildId:'999'},emoji:{name:'👍'}},user,'789');
 assert.equal(calls.length,0);
});
test('rejected activity writes are logged without interfering with Discord events',()=>{
 const logs=[];const socket={connected:true,emit:(event,payload,callback)=>callback({ok:false,message:'Database unavailable'})};
 assert.doesNotThrow(()=>recordDiscordPost(socket,message,'789',{log:line=>logs.push(line)}));
 assert.match(logs[0],/Database unavailable/);
});
test('an old or unavailable backend times out instead of keeping acknowledgement callbacks forever',()=>{
 const logs=[];let timeout;
 const socket={connected:true,timeout:ms=>{timeout=ms;return {emit:(event,payload,callback)=>callback(Error('timed out'))};}};
 recordDiscordPost(socket,message,'789',{log:line=>logs.push(line)});
 assert.equal(timeout,10000);assert.match(logs[0],/timed out/);
});
