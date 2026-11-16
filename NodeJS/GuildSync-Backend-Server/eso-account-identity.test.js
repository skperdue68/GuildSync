import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeEsoAccountIdentity,createEsoAccountRenames,resolveEsoAccountName,withEsoIdentityLock,registerEsoAccountRenameSocket,getEsoAccountRenameHistory,searchEsoAccountNames,afterEsoIdentityUnlock,getEsoIdentitySourceDB} from './eso-account-identity.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(`CREATE TABLE guildsync_eso_members(member_id TEXT PRIMARY KEY,current_name TEXT,name_key TEXT UNIQUE);
 CREATE TABLE guildsync_eso_account_aliases(alias_key TEXT PRIMARY KEY,account_name TEXT,member_id TEXT);
 CREATE TABLE guildsync_eso_account_renames(rename_id TEXT PRIMARY KEY,member_id TEXT,old_name TEXT,new_name TEXT,operator_discord_id TEXT,operator_name TEXT,actor_discord_id TEXT,renamed_at INTEGER);
 CREATE TABLE guildsync_roster_members(account_name TEXT PRIMARY KEY,rank_name TEXT,joined_timestamp TEXT,in_roster INTEGER);
 CREATE TABLE guildsync_roster_rank_history(account_name TEXT PRIMARY KEY,rank_name TEXT);
 CREATE TABLE guildsync_roster_events(event_id TEXT PRIMARY KEY,account_name TEXT,account_name_original TEXT,event_type TEXT,rank_name TEXT,event_timestamp TEXT,officer_account_name TEXT,officer_account_name_original TEXT);
 CREATE TABLE guildsync_roster_member_notes(note_id INTEGER PRIMARY KEY,account_name TEXT,account_name_original TEXT,officer_name TEXT,note_text TEXT,note_timestamp TEXT);
 CREATE TABLE guildsync_member_links(eso_account_name TEXT,discord_user_id TEXT,link_status TEXT,PRIMARY KEY(eso_account_name,discord_user_id));
 CREATE TABLE guildsync_banking_entries(event_id TEXT PRIMARY KEY,account_name TEXT,account_name_original TEXT,deposit_amount INTEGER,mail_status TEXT,
 transaction_type TEXT,event_timestamp TEXT,event_datetime TEXT,ticket_quantity INTEGER,data_source TEXT,note TEXT,mail_request_id TEXT,mail_batch_id TEXT,checked_out_by TEXT,checked_out_at TEXT,written_to_eso_at TEXT,sent_at TEXT,failed_reason TEXT);
 CREATE TABLE guildsync_applications(applicant_account TEXT,applicant_account_original TEXT,application_timestamp TEXT,application_text TEXT,officer_processing TEXT,officer_processing_original TEXT,discord_broadcast INTEGER,application_action TEXT,decline_message TEXT,blacklist_message TEXT,submitted_by_discord_id TEXT,PRIMARY KEY(applicant_account,application_timestamp));
 CREATE TABLE guildsync_settings(setting_key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE guildsync_users(discord_user_id TEXT PRIMARY KEY,guild_member_name TEXT,username TEXT,role TEXT,allowed INTEGER);
 INSERT INTO guildsync_eso_members VALUES('member-a','OldName','oldname');
 INSERT INTO guildsync_eso_account_aliases VALUES('oldname','OldName','member-a');
 INSERT INTO guildsync_roster_members VALUES('OldName','Soldier','100',1);
 INSERT INTO guildsync_roster_rank_history VALUES('OldName','Soldier');
 INSERT INTO guildsync_roster_events VALUES('123','OldName',NULL,'demoted','Soldier','101','Officer',NULL);
 INSERT INTO guildsync_roster_member_notes VALUES(1,'OldName',NULL,'Officer','Keep this note','102');
 INSERT INTO guildsync_member_links VALUES('OldName','200','linked');
 INSERT INTO guildsync_banking_entries(event_id,account_name,account_name_original,deposit_amount,mail_status) VALUES('456','@OldName',NULL,500,'sent');
 INSERT INTO guildsync_applications(applicant_account,applicant_account_original,application_timestamp,application_text,officer_processing,officer_processing_original,discord_broadcast) VALUES('@OldName',NULL,'99','Original application', 'Officer',NULL,1);
 INSERT INTO guildsync_users VALUES('200','@OldName','Member','user',1);`);
 sql.function('CHAR_LENGTH',value=>String(value).length);
 sql.function('LOCATE',(needle,haystack)=>String(haystack).indexOf(String(needle))+1);
 sql.function('FROM_UNIXTIME',value=>new Date(Number(value)*1000).toISOString());
 const state={locks:0,failAudit:false};
 const execute=async(query,args=[])=>{
  if(query.includes('GET_LOCK')){state.locks++;return [[{acquired:1}]];}
  if(query.includes('RELEASE_LOCK')){state.locks--;return [[{released:1}]];}
  if(state.failAudit && query.startsWith('INSERT INTO guildsync_eso_account_renames'))throw Error('audit unavailable');
  query=query.replaceAll(/LEFT\(([^,]+),1\)/g, 'substr($1,1,1)').replaceAll(/CONCAT\('@',\?\)/g, "('@' || ?)");
  query=query.replaceAll(/TRIM\(LEADING '@' FROM ([^)]+)\)/g,"TRIM($1, '@')").replaceAll(' FOR UPDATE','');
  query=query.replace(/INSERT IGNORE/gi,'INSERT OR IGNORE');
  if(query.includes('ON DUPLICATE KEY UPDATE')){
   const table=query.match(/INTO\s+(\w+)/i)[1];
   const keys={guildsync_settings:'setting_key',guildsync_roster_members:'account_name',guildsync_roster_rank_history:'account_name',guildsync_applications:'applicant_account,application_timestamp'};
   query=query.replace('ON DUPLICATE KEY UPDATE',`ON CONFLICT(${keys[table]}) DO UPDATE SET`).replace(/VALUES\((\w+)\)/g,'excluded.$1');
  }
  args=args.map(value=>Number.isSafeInteger(value)?BigInt(value):value);
  const statement=sql.prepare(query);
  return /^\s*(SELECT|WITH)/i.test(query)?[statement.all(...args)]:[{affectedRows:Number(statement.run(...args).changes)}];
 };
 const db={execute,query:execute,async getConnection(){return {...db,beginTransaction:async()=>sql.exec('BEGIN'),commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),release(){}};}};
 let now=1000;
 return {sql,db,state,setNow:value=>now=value,service:createEsoAccountRenames(db,{now:()=>now}),actor:{userId:'10',actorId:'10',sessionId:'session-a',name:'Officer'}};
}

test('preview then rename preserves identity, historical names, dates, bank and application status, and writes history',async()=>{
 const f=fixture(),input={accountName:'@OldName',newAccountName:'@NewName'};
 const preview=await f.service.preview(input,f.actor);
 assert.equal(preview.conflict,false);assert.equal(preview.counts.banking,1);assert.equal(preview.counts.events,1);
 await f.service.rename({...input,token:preview.token},f.actor);
 assert.equal(await resolveEsoAccountName(f.db,'@OLDNAME'),'@NewName');
 assert.equal(await resolveEsoAccountName(f.db,'OldName'),'NewName');
 assert.equal(f.sql.prepare('SELECT member_id FROM guildsync_eso_members').get().member_id,'member-a');
 const bank=f.sql.prepare('SELECT * FROM guildsync_banking_entries').get();
 assert.equal(bank.account_name,'@NewName');assert.equal(bank.account_name_original,'@OldName');assert.equal(bank.deposit_amount,500);assert.equal(bank.mail_status,'sent');
 const event=f.sql.prepare('SELECT * FROM guildsync_roster_events').get();assert.equal(event.account_name_original,'OldName');assert.equal(event.event_id,'123');assert.equal(event.event_timestamp,'101');
 assert.equal(f.sql.prepare('SELECT discord_broadcast FROM guildsync_applications').get().discord_broadcast,1);
 assert.equal(f.sql.prepare('SELECT joined_timestamp FROM guildsync_roster_members').get().joined_timestamp,'100');
 assert.equal(f.sql.prepare('SELECT operator_name FROM guildsync_eso_account_renames').get().operator_name,'Officer');
 const history=await getEsoAccountRenameHistory(f.db,'OldName');
 assert.match(history[0].details,/@OldName to @NewName by Officer/);assert.equal(history[0].timestamp,1000);
 assert.deepEqual(await searchEsoAccountNames(f.db,'@Old'),['NewName']);
 assert.equal(f.state.locks,0);
});

test('another existing target is a conflict and cannot be merged or overwritten',async()=>{
 const f=fixture();f.sql.exec("INSERT INTO guildsync_banking_entries(event_id,account_name,account_name_original,deposit_amount,mail_status) VALUES('789','NewName',NULL,2500,'unsent')");
 const input={accountName:'OldName',newAccountName:'NewName'},preview=await f.service.preview(input,f.actor);
 assert.equal(preview.conflict,true);assert.equal(preview.token,undefined);
 await assert.rejects(f.service.rename({...input,token:'forged'},f.actor));
 assert.equal(f.sql.prepare('SELECT current_name FROM guildsync_eso_members').get().current_name,'OldName');
});

test('confirmation is bound to account names, authenticated user/session, expiry and current preview',async()=>{
 const f=fixture(),input={accountName:'OldName',newAccountName:'NewName'},p=await f.service.preview(input,f.actor);
 for(const [change,actor] of [[{newAccountName:'OtherName'},f.actor],[{}, {...f.actor,userId:'20'}],[{}, {...f.actor,sessionId:'other'}]])
  await assert.rejects(f.service.rename({...input,...change,token:p.token},actor));
 f.setNow(1400);await assert.rejects(f.service.rename({...input,token:p.token},f.actor),/expired|preview/i);
});

test('new records after preview require another preview; audit failure rolls the rename back',async()=>{
 const f=fixture(),input={accountName:'OldName',newAccountName:'NewName'},p=await f.service.preview(input,f.actor);
 f.sql.exec("INSERT INTO guildsync_banking_entries(event_id,account_name,account_name_original,deposit_amount,mail_status) VALUES('789','OldName',NULL,500,'unsent')");
 await assert.rejects(f.service.rename({...input,token:p.token},f.actor),/preview|changed/i);
 const p2=await f.service.preview(input,f.actor);f.state.failAudit=true;
 await assert.rejects(f.service.rename({...input,token:p2.token},f.actor),/audit/);
 assert.equal(f.sql.prepare('SELECT account_name FROM guildsync_roster_members').get().account_name,'OldName');
 assert.equal(await resolveEsoAccountName(f.db,'OldName'),'OldName');assert.equal(f.state.locks,0);
});

test('repeated renames retain all aliases and originals; nested identity lock uses one connection',async()=>{
 const f=fixture();for(const [oldName,newName] of [['OldName','NewName'],['NewName','ThirdName']]){
  const input={accountName:oldName,newAccountName:newName},p=await f.service.preview(input,f.actor);await f.service.rename({...input,token:p.token},f.actor);
 }
 for(const name of ['OldName','NewName','ThirdName'])assert.equal(await resolveEsoAccountName(f.db,name),'ThirdName');
 assert.equal(f.sql.prepare('SELECT account_name_original FROM guildsync_banking_entries').get().account_name_original,'@OldName');
 await withEsoIdentityLock(f.db,async db=>withEsoIdentityLock(db,async()=>assert.equal(f.state.locks,1)));
 assert.equal(f.state.locks,0);
});

test('socket independently denies Viewer, revoked accounts and bots; uses authenticated identity',async()=>{
 for(const [role,allowed,authType,expected] of [['viewer',1,'GuildSync user',false],['user',0,'GuildSync user',false],['admin',1,'discord-bot',false],['user',1,'GuildSync user',true],['admin',1,'GuildSync user',true]]){
  const handlers=new Map();let seen;
  const socket={guildSyncAuthenticated:true,guildSyncAuthType:authType,guildSyncUser:{discord_user_id:'10',username:'Officer'},guildSyncActorId:'99',guildSyncRoleViewId:'session-a',on:(event,fn)=>handlers.set(event,fn)};
  registerEsoAccountRenameSocket(socket,{service:{preview:async(input,actor)=>{seen=actor;return {conflict:false};}},loginDB:{execute:async()=>[[{role,allowed}]]}});
  let out;await handlers.get('guildsync:preview-eso-account-rename')({accountName:'OldName',newAccountName:'NewName',userId:'forged'},r=>out=r);
  assert.equal(out.ok,expected);if(expected){assert.equal(seen.userId,'10');assert.equal(seen.actorId,'99');}
 }
});

function ingestionContext(){
 const source=readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const ctx=vm.createContext({afterEsoIdentityUnlock,getEsoIdentitySourceDB,resolveEsoAccountName,withEsoIdentityLock,validateEsoGuildImport(){},
  normalizeRosterEvents:value=>Array.isArray(value)?value:Object.values(value||{}),normalizeRosterTimestamp:value=>Number(value)||0,
  normalizeRosterAccountName:value=>String(value||'').trim().replace(/^@/,''),normalizeRosterRank:value=>String(value||''),normalizeRosterEventType:value=>value,
  normalizeGuildListMembers:value=>Array.isArray(value)?value:Object.values(value||{}),createAutomaticRosterEventId:()=> 'auto-removal',
  safeRollback:db=>db.rollback(),runMemberAutoLinking:async()=>{},getRosterDataJSON:async db=>(await db.execute('SELECT * FROM guildsync_roster_members'))[0],
  googleSheetsBankingConfig:()=>({enabled:false}),enqueueSheetsExports:async()=>{},bankingSource:source=>source,
  setSetting:async()=>{},getRaffleBonusVersions:async()=>[],getRaffleBonusOverrides:async()=>[],calculateBankingEntryBonus:()=>({}),
  normalizeDepositMailTicketType:value=>value,syncBankingEntriesToGoogleSheets:async()=>{},createSheetsExportStore:()=>({}),console});
 const parts=[['export async function processRosterData(','function normalizeGuildListMembers('],
 ['export async function insertBankingEntries(','export async function getRosterDataDate('],
 ['function normalizeApplicationRecord(','export async function getGuildSyncApplicationsByApplicantSearch('],
 ['export async function addManualBiweeklyTicketEntry(','export async function moveBankingEntry(']];
 for(const [start,end] of parts){
  const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);
  vm.runInContext(source.slice(a,b).replaceAll('export async','async'),ctx);
 }
 return ctx;
}

test('old-name snapshots, stream events, banking and repeat applications stay with the renamed member',async()=>{
 const f=fixture(),ctx=ingestionContext(),input={accountName:'OldName',newAccountName:'NewName'};
 const preview=await f.service.preview(input,f.actor);await f.service.rename({...input,token:preview.token},f.actor);
 await ctx.processRosterData(f.db,{data:{guildList:{listTimestamp:200,guildListMembers:[{accountName:'@OldName',rankName:'Soldier'}]}}});
 assert.deepEqual(f.sql.prepare('SELECT account_name,joined_timestamp FROM guildsync_roster_members').all().map(row=>({...row})),[{account_name:'NewName',joined_timestamp:'100'}]);
 await ctx.processRosterData(f.db,{data:{rosterEvents:[{eventId:'new-promotion',targetDisplayName:'OldName',eventType:'promoted',timestampS:210,rankName:'Capo'}]}});
 assert.equal(f.sql.prepare('SELECT rank_name FROM guildsync_roster_members').get().rank_name,'Capo');
 assert.equal(f.sql.prepare("SELECT account_name_original FROM guildsync_roster_events WHERE event_id='new-promotion'").get().account_name_original,'OldName');
 await ctx.insertBankingEntries(f.db,{entries:[{eventId:999,type:'biweekly',displayName:'@OldName',time:205,amount:500,ticketAmount:1}]});
 assert.equal(f.sql.prepare("SELECT account_name FROM guildsync_banking_entries WHERE event_id='999'").get().account_name,'@NewName');
 await ctx.insertBankingEntries(f.db,{entries:[{eventId:999,type:'biweekly',displayName:'@OldName',time:205,amount:500,ticketAmount:1}]});
 assert.equal(f.sql.prepare("SELECT COUNT(*) AS total FROM guildsync_banking_entries WHERE event_id='999'").get().total,1);
 await ctx.recordGuildSyncApplications(f.db,[{applicantAccount:'@OldName',applicationTimestamp:300,applicationText:'Next join',applicationAction:'accepted'}]);
 const app=f.sql.prepare("SELECT applicant_account,applicant_account_original FROM guildsync_applications WHERE application_timestamp='300'").get();
 assert.equal(app.applicant_account,'@NewName');assert.equal(app.applicant_account_original,'@OldName');
 const events=[{eventId:'left',targetDisplayName:'OldName',eventType:'left',timestampS:220},
 {eventId:'old-join',targetDisplayName:'OldName',eventType:'joined',timestampS:50}];
 await ctx.processRosterData(f.db,{data:{rosterEvents:events}});
 assert.equal(f.sql.prepare('SELECT COUNT(*) AS total FROM guildsync_roster_members').get().total,0);
 assert.equal(f.state.locks,0);
});

test('active receipt handoff blocks rename, note counts stay private, and history identifies the operator',async()=>{
 const f=fixture(),input={accountName:'OldName',newAccountName:'NewName'};
 let p=await f.service.preview(input,f.actor);assert.equal(Object.hasOwn(p.counts,'notes'),false);
 f.sql.exec("UPDATE guildsync_banking_entries SET mail_status='written_to_eso'");
 p=await f.service.preview(input,f.actor);assert.equal(p.conflict,true);assert.match(p.message,/receipts/);assert.equal(p.token,undefined);
});


test('invalid names, concurrent role revocation and preview replay fail without changes',async()=>{
 const f=fixture();for(const name of ['', 'New Name','@@','@<Name>','X'.repeat(33),'oldname']){
  await assert.rejects(f.service.preview({accountName:'OldName',newAccountName:name},f.actor));
 }
 const input={accountName:'OldName',newAccountName:'NewName'},p=await f.service.preview(input,f.actor);
 await assert.rejects(f.service.rename({...input,token:p.token},{...f.actor,authorize:async()=>{throw Error('User revoked');}}),/revoked/);
 assert.equal(await resolveEsoAccountName(f.db,'OldName'),'OldName');
 await f.service.rename({...input,token:p.token},f.actor);
 await assert.rejects(f.service.rename({...input,token:p.token},f.actor),/now @NewName|preview/);
});

test('link notifications run only after connection release and retain the registered source database',async()=>{
 const f=fixture(),steps=[];
 await withEsoIdentityLock(f.db,async connection=>{
  assert.equal(getEsoIdentitySourceDB(connection),f.db);
  await afterEsoIdentityUnlock(connection,async()=>{assert.equal(f.state.locks,0);steps.push('notification');});
  steps.push('write');
 });
 assert.deepEqual(steps,['write','notification']);
});


test('startup migrations backfill stable identities once and never reassign a former alias',async()=>{
 const f=fixture(),ddl=[];
 const db={...f.db,query:async query=>{ddl.push(query);return [[]];}};
 f.sql.exec("INSERT INTO guildsync_roster_members VALUES('FreshName','Associate','500',1)");
 await initializeEsoAccountIdentity(db);
 const id=f.sql.prepare("SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key='freshname'").get().member_id;
 const input={accountName:'OldName',newAccountName:'NewName'},p=await f.service.preview(input,f.actor);await f.service.rename({...input,token:p.token},f.actor);
 await initializeEsoAccountIdentity(db);
 assert.equal(f.sql.prepare("SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key='freshname'").get().member_id,id);
 assert.equal(f.sql.prepare("SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key='oldname'").get().member_id,'member-a');
 assert.equal(await resolveEsoAccountName(f.db,'OldName'),'NewName');
 assert.ok(ddl.some(sql=>sql.includes('CREATE TABLE IF NOT EXISTS guildsync_eso_account_renames')));
 assert.ok(ddl.some(sql=>sql.includes('ADD COLUMN IF NOT EXISTS account_name_original')));
 assert.doesNotMatch(ddl.join(' '),/DROP TABLE|DELETE FROM/);
});


for(const manual of [false,true])test(`${manual?'manual tickets':'banking imports'} release identity lock before a slow Sheets export`,async()=>{
 const f=fixture(),ctx=ingestionContext();let signal,release;
 const exporting=new Promise(resolve=>signal=resolve),finish=new Promise(resolve=>release=resolve);
 ctx.googleSheetsBankingConfig=()=>({enabled:true});ctx.getBankingDataJSON=async db=>{assert.equal(db,f.db);return [];};
 ctx.getRaffleBonusVersions=async db=>{assert.equal(db,f.db);return [];};ctx.getRaffleBonusOverrides=ctx.getRaffleBonusVersions;
 ctx.syncBankingEntriesToGoogleSheets=async()=>{assert.equal(f.state.locks,0);signal();await finish;};
 const operation=manual?ctx.addManualBiweeklyTicketEntry(f.db,{account_name:'OldName',tickets:2,gold_value:1000})
  :ctx.insertBankingEntries(f.db,{entries:[{eventId:999,type:'biweekly',displayName:'OldName',time:205,amount:500,ticketAmount:1}]});
 await exporting;
 try{
  const p=await f.service.preview({accountName:'OldName',newAccountName:'NewName'},f.actor);
  assert.equal(p.conflict,false);assert.equal(f.state.locks,0);
 }finally{release();await operation;}
});
