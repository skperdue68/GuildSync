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

test('broadcast ACK identifies one application rather than all applications for an account',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('./guildsync-backend-server.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/await markGuildSyncApplicationBroadcasted\(applicationDB, record.applicant_account\)/);
  const {default:vm}=await import('node:vm');
  const actions=readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
  const start=actions.indexOf('export async function markGuildSyncApplicationRecordBroadcasted('),end=actions.indexOf('export async function getGuildSyncApplicationByApplicantAccount(',start);
  const context=vm.createContext({});
  vm.runInContext(actions.slice(start,end).replace('export async','async'),context);
  const {markGuildSyncApplicationRecordBroadcasted}=context;
  let query,params;
  await markGuildSyncApplicationRecordBroadcasted({execute:async(sql,args)=>{query=sql;params=args;}},'@Alice','2000');
  assert.match(query,/AND application_timestamp = \?/);
  assert.deepEqual([...params],['@Alice','2000']);
});

test('import keeps separate application timestamps for repeat joins and same-second captures',async()=>{
  const {readFileSync}=await import('node:fs');
  const {default:vm}=await import('node:vm');
  const source=readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
  const start=source.indexOf('function normalizeApplicationRecord('),end=source.indexOf('export async function getGuildSyncApplicationsByApplicantSearch(',start);
  const context=vm.createContext({validateEsoGuildImport(){}});
  vm.runInContext(source.slice(start,end).replace('export async','async'),context);
  const stored=new Map();
  await context.recordGuildSyncApplications({execute:async(sql,args)=>{
    stored.set(`${args[0]}:${args[2]}`,args[1]);return [{}];
  }},[
    {applicantAccount:'@Alice',capturedAt:1000,applicationText:'First join'},
    {applicantAccount:'@Alice',capturedAt:2000,applicationText:'Second join'},
    {applicantAccount:'@Alice',capturedAt:3000,applicationText:'Third join'},
    {applicantAccount:'@Alice',capturedAt:'3000.000001',applicationText:'Separate same-second capture'}
  ]);
  assert.equal(stored.size,4);
  assert.equal(stored.get('@Alice:1000'),'First join');
  assert.equal(stored.get('@Alice:3000.000001'),'Separate same-second capture');
});
