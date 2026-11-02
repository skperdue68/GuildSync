import test from 'node:test';
import assert from 'node:assert/strict';
import {getApplicationHistory, registerApplicationHistorySocket} from './application-history.js';
import {canPerformGuildSyncEvent} from './role-permissions.js';

test('history selects the exact account, not similarly named applicants, with optional @', async () => {
  const calls=[];
  const db={execute:async (...args)=>{calls.push(args);return [[{applicant_account:'@Alice',application_text:'Welcome'}]];}};
  assert.equal((await getApplicationHistory(db,' Alice '))[0].application_text,'Welcome');
  assert.deepEqual(calls[0][1],['Alice']);
  assert.match(calls[0][0],/LOWER\(TRIM\(LEADING '@' FROM applicant_account\)\) = LOWER\(\?\)/);
  assert.doesNotMatch(calls[0][0],/LIKE/);
  assert.match(calls[0][0],/application_timestamp AS UNSIGNED\) DESC/);
  await assert.rejects(()=>getApplicationHistory(db,' '),/account name/);
  await assert.rejects(()=>getApplicationHistory(db,'a'.repeat(51)),/account name/);
  assert.equal(calls.length,1);
});

test('history socket rechecks approval; viewers may read, bot and revoked accounts cannot',async()=>{
  const handlers={};let queries=0,allowed=1;
  const socket={guildSyncAuthenticated:true,guildSyncUser:{discord_user_id:'123'},on:(e,h)=>handlers[e]=h};
  registerApplicationHistorySocket(socket,{
    db:{execute:async()=>{queries++;return [[]];}},
    loginDB:{execute:async()=>[[{allowed,role:'viewer'}]]}
  });
  const invoke=async payload=>{let result;await handlers['guildsync:request-application-history'](payload,r=>result=r);return result;};
  assert.equal((await invoke({account_name:'Alice'})).ok,true);
  assert.equal(queries,1);
  allowed=0;assert.equal((await invoke({account_name:'Alice'})).ok,false);
  socket.guildSyncAuthType='discord-bot';allowed=1;assert.equal((await invoke({account_name:'Alice'})).ok,false);
  socket.guildSyncAuthType='user';socket.guildSyncAuthenticated=false;
  assert.equal((await invoke({account_name:'Alice'})).ok,false);
  assert.equal(queries,1);
});

test('read policy permits approved viewers to request application history',()=>{
  assert.equal(canPerformGuildSyncEvent('viewer','guildsync:request-application-history'),true);
});

test('database failure returns a safe empty history result',async()=>{
  const handlers={};
  registerApplicationHistorySocket({guildSyncAuthenticated:true,guildSyncUser:{discord_user_id:'123'},on:(e,h)=>handlers[e]=h},{
    db:{execute:async()=>{throw Error('secret database path');}},loginDB:{execute:async()=>[[{allowed:1,role:'user'}]]}
  });
  let response;await handlers['guildsync:request-application-history']({account_name:'Alice'},r=>response=r);
  assert.equal(response.ok,false);assert.deepEqual(response.records,[]);
  assert.doesNotMatch(response.message,/secret/);
});
