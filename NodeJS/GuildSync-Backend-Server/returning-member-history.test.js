import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {getReturningMemberHistory} from './returning-member-history.js';
test('accepted application uses exact ESO account and latest rank change before acceptance',async()=>{
 const calls=[];
 const db={execute:async(sql,args)=>{calls.push([sql,args]);return sql.includes('guildsync_roster_events')?[[{rank_name:'Soldier',event_timestamp:'100'}]]:[[{discord_user_id:'123'}]];}};
 const result=await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'@Alice',application_timestamp:'200',submitted_by_discord_id:'777'});
 assert.equal(result.rankName,'Soldier');assert.deepEqual(result.discordUserIds,['123']);
 assert.equal(result.actorDiscordId,'777');
 assert.match(calls[0][0],/event_type IN \('promoted', 'demoted'\)/);assert.match(calls[0][0],/ORDER BY CAST\(event_timestamp AS UNSIGNED\) DESC/);
 assert.match(calls[0][0],/LIMIT 1/);assert.doesNotMatch(calls[0][0],/LIKE/);
 assert.deepEqual(calls[0][1],['Alice',200]);
});
test('application import captures the authenticated submitter and ignores a forged record submitter',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const a=source.indexOf('function normalizeApplicationRecord('),b=source.indexOf('export async function getGuildSyncApplicationsByApplicantSearch(',a);
 const ctx=vm.createContext({validateEsoGuildImport(){}});
 vm.runInContext(source.slice(a,b).replace('export async','async'),ctx);
 const writes=[];const db={execute:async(sql,args)=>{writes.push(args);return [{}];}};
 const records=[{applicant_account:'Alice',application_timestamp:200,application_action:'accepted',submitted_by_discord_id:'forged'}];
 await ctx.recordGuildSyncApplications(db,records,{submittedBy:'777'});
 assert.equal(writes[0].at(-1),'777');assert.ok(!writes[0].includes('forged'));
 await ctx.recordGuildSyncApplications(db,records);
 assert.equal(writes[1].at(-1),null);
});
test('declined applications, first-time members, and missing dates do not restore roles',async()=>{
 let queries=0;const db={execute:async()=>{queries++;return [[]];}};
 assert.equal(await getReturningMemberHistory(db,{application_action:'declined'}),null);
 assert.equal(await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'Alice'}),null);
 assert.equal(queries,0);
 assert.equal(await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'Alice',application_timestamp:200}),null);
 // rank change lookup, then the older roster-activity fallback
 assert.equal(queries,2);
});

for (const latestType of ['demoted','promoted']) {
 test(`latest ESO ${latestType} rank supersedes an earlier rank change`,async()=>{
  const events=[
   {account:'alice',event_type:latestType==='demoted'?'promoted':'demoted',rank_name:'Capo',event_timestamp:100},
   {account:'alice',event_type:latestType,rank_name:'Soldier',event_timestamp:150},
   {account:'alice',event_type:'promoted',rank_name:'Kingpin',event_timestamp:250},
   {account:'someoneelse',event_type:'promoted',rank_name:'Kingpin',event_timestamp:190}
  ];
  const db={execute:async(sql,args)=>{
   if(!sql.includes('guildsync_roster_events'))return [[{discord_user_id:'123'}]];
   const types=[...sql.matchAll(/'(promoted|demoted)'/g)].map(match=>match[1]);
   return [events.filter(event=>event.account===args[0].toLowerCase() && event.event_timestamp<=args[1] && types.includes(event.event_type))
    .sort((a,b)=>b.event_timestamp-a.event_timestamp).slice(0,1)];
  }};
  const result=await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'@Alice',application_timestamp:200});
  assert.equal(result.rankName,'Soldier');
 });
}

test('roster history without a rank change still returns the link so Discord rank can be reported',async()=>{
 const statements=[];
 const db={execute:async(sql,args)=>{
  statements.push(sql);
  if(!sql.includes('guildsync_roster_events'))return [[{discord_user_id:'123'}]];
  if(sql.includes("event_type IN ('promoted', 'demoted')"))return [[]];
  return [[{rank_name:'',event_timestamp:'150',event_type:'joined'},{rank_name:'',event_timestamp:'90',event_type:'promoted'}]];
 }};
 const result=await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'@Alice',application_timestamp:'200'});
 assert.equal(result.rankName,'');
 assert.equal(result.rosterRank,'');
 assert.equal(result.rankTimestamp,150);
 assert.deepEqual(result.discordUserIds,['123']);
 assert.match(statements[1],/SELECT rank_name,event_timestamp,event_type/);
 assert.doesNotMatch(statements[1],/event_type (IN|=)/i);
});

test('the roster-side rank is reported when the event history has no rank',async()=>{
 const statements=[];
 const db={execute:async(sql,args)=>{
  statements.push([sql,args]);
  if(sql.includes('guildsync_roster_rank_history'))return [[{rank_name:'Associate'}]];
  if(!sql.includes('guildsync_roster_events'))return [[{discord_user_id:'123'}]];
  if(sql.includes("event_type IN ('promoted', 'demoted')"))return [[]];
  return [[{rank_name:'',event_timestamp:'150',event_type:'joined'},{rank_name:'',event_timestamp:'90',event_type:'demoted'}]];
 }};
 const result=await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'@Alice',application_timestamp:'200'});
 assert.equal(result.rankName,'');assert.equal(result.rosterRank,'Associate');
 assert.match(statements[2][0],/FROM guildsync_roster_rank_history/);
 assert.deepEqual(statements[2][1],['Alice']);
});

test('a blank or Unknown rank survives as no rank rather than an unusable label',async()=>{
 for (const stored of ['', 'Unknown', ' unknown ']) {
  const db={execute:async sql=>sql.includes('guildsync_roster_events')?[[{rank_name:stored,event_timestamp:'100'}]]:[[{discord_user_id:'123'}]]};
  const result=await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'Alice',application_timestamp:'200'});
  assert.equal(result.rankName,'',stored);
 }
});

test('a single first-ever join is a new member, not a returning one',async()=>{
 const statements=[];
 const db={execute:async(sql,args)=>{
  statements.push([sql,args]);
  if(!sql.includes('guildsync_roster_events'))throw Error('a new member must not trigger link or roster-rank lookups');
  return sql.includes("event_type IN ('promoted', 'demoted')")?[[]]
   :[[{rank_name:'',event_timestamp:'150',event_type:'joined'}]];
 }};
 const result=await getReturningMemberHistory(db,{application_action:'accepted',applicant_account:'@Adam79',application_timestamp:'200'});
 assert.equal(result,null);
 assert.equal(statements.length,2);
 assert.match(statements[1][0],/event_type/);assert.match(statements[1][0],/LIMIT 2/);
 assert.deepEqual(statements[1][1],['Adam79',200]);
});

test('an earlier event or a lone removal still proves a previous stint',async()=>{
 const build=(rows,links)=>async sql=>{
  if(sql.includes('guildsync_roster_rank_history'))return [[]];
  if(sql.includes("event_type IN ('promoted', 'demoted')"))return [[]];
  if(sql.includes('guildsync_roster_events'))return [rows];
  return [links];
 };
 const rejoined=await getReturningMemberHistory({execute:build([{rank_name:'',event_timestamp:'150',event_type:'joined'},
  {rank_name:'',event_timestamp:'100',event_type:'joined'}],[{discord_user_id:'123'}])},
  {application_action:'accepted',applicant_account:'Alice',application_timestamp:'200'});
 assert.equal(rejoined.rankName,'');assert.deepEqual(rejoined.discordUserIds,['123']);
 const removed=await getReturningMemberHistory({execute:build([{rank_name:'',event_timestamp:'150',event_type:'Removed (Not On Roster)'}],[])},
  {application_action:'accepted',applicant_account:'Alice',application_timestamp:'200'});
 assert.equal(removed.rankName,'');assert.deepEqual(removed.discordUserIds,[]);
 const left=await getReturningMemberHistory({execute:build([{rank_name:'Soldier',event_timestamp:'150',event_type:'left'}],[])},
  {application_action:'accepted',applicant_account:'Alice',application_timestamp:'200'});
 assert.equal(left.rankName,'Soldier');
});
