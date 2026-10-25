import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommunityStatistics, registerCommunityStatisticsSocket, initializeCommunityStatisticsSchema} from './community-statistics.js';
test('history counts real joins only; tenure uses latest recorded join, not snapshot',()=>{
 const report=buildCommunityStatistics({now:200000,roster:[{account_name:'A',in_roster:1,joined_timestamp:'1'}],rosterEvents:[{account_name:'A',event_type:'joined',event_timestamp:'100000'},{account_name:'A',event_type:'joined',event_timestamp:'150000'}],discordHistory:[{discord_id:'1',username:'Snapshot',event_type:'joined_server',source:'bulk_sync'},{discord_id:'2',username:'Live',event_type:'joined_server',source:'live_event'}]});
 assert.equal(report.highlights.find(x=>x.id==='guild-joins').rows[0].value,2);
 assert.equal(report.highlights.find(x=>x.id==='longest-member').rows[0].value,0);
 assert.deepEqual(report.highlights.find(x=>x.id==='discord-joins').rows.map(x=>x.name),['Live']);
});
test('community activity groups posts and reactions by actor, excluding bot command telemetry',()=>{
 const report=buildCommunityStatistics({activity:[
  {discord_id:'1',username:'Alice',activity_type:'post',activity_count:3,activity_timestamp:Math.floor(Date.now()/1000)},
  {discord_id:'1',username:'Alice',activity_type:'reaction',activity_count:4,activity_timestamp:Math.floor(Date.now()/1000)},
  {discord_id:'2',username:'Bob',activity_type:'post',activity_count:5,activity_timestamp:Math.floor(Date.now()/1000)},
 ],interactions:[{discord_id:'3',username:'Commands',interaction_count:100}],commandUsage:[{interaction_name:'tickets',interaction_count:100}]});
 const rows=id=>report.highlights.find(h=>h.id===id).rows.map(r=>[r.name,r.value]);
 assert.deepEqual(rows('discord-busiest'),[['Alice',7],['Bob',5]]);
 assert.deepEqual(rows('discord-posts'),[['Bob',5],['Alice',3]]);
 assert.deepEqual(rows('discord-reactions'),[['Alice',4]]);
 assert.equal(report.overview.find(r=>r.label==='Discord activity (last 30 days)').value,12);
 assert.ok(!report.highlights.some(h=>['discord-commands','discord-interactions'].includes(h.id)));
});
test('membership coverage explains missing actual joins rather than treating import dates as membership',()=>{
 const report=buildCommunityStatistics({now:100000,roster:[{account_name:'Known',in_roster:1},{account_name:'Unknown',in_roster:1,joined_timestamp:'1'}],rosterEvents:[{account_name:'Known',event_type:'joined',event_timestamp:100}]});
 const longest=report.highlights.find(h=>h.id==='longest-member');
 assert.equal(longest.title,'Longest membership with a known join date');
 assert.match(longest.description,/1 of 2 current members/);
 assert.deepEqual(longest.rows.map(r=>r.name),['Known']);
});
test('activity writes require matching guild bot, deduplicate event keys, and omit extra payload',async()=>{
 const handlers={},calls=[];const socket={on:(e,h)=>handlers[e]=h,guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',guildSyncBot:{guild_id:'456'}};
 registerCommunityStatisticsSocket(socket,{db:{execute:async(...args)=>calls.push(args)}});
 const payload={guildId:'456',eventKey:'a'.repeat(64),userId:'789',displayName:'Actor',type:'post',content:'private'};
 let result;await handlers['guildsync:record-discord-activity'](payload,r=>result=r);
 assert.equal(result.ok,true);assert.match(calls[0][0],/INSERT IGNORE/);assert.ok(!JSON.stringify(calls).includes('private'));
 await handlers['guildsync:record-discord-activity']({...payload,guildId:'999'},r=>result=r);assert.equal(result.ok,false);
 socket.guildSyncAuthType='GuildSync user';await handlers['guildsync:record-discord-activity'](payload,r=>result=r);assert.equal(result.ok,false);
 socket.guildSyncAuthType='discord-bot';await handlers['guildsync:record-discord-activity']({...payload,type:'slash'},r=>result=r);assert.equal(result.ok,false);
 assert.equal(calls.length,1);
});
test('approved report auth and bot-only write reject unauthorized sockets before querying',async()=>{
 const handlers={};let queries=0;const socket={on:(e,h)=>handlers[e]=h,emit(){},guildSyncAuthenticated:false};
 registerCommunityStatisticsSocket(socket,{db:{execute:async()=>{queries++;return [[]];}},loadBanking:async()=>[]});
 let result;await handlers['guildsync:request-community-statistics']({},r=>result=r);assert.equal(result.ok,false);
 await handlers['guildsync:record-discord-interaction']({},r=>result=r);assert.equal(result.ok,false);assert.equal(queries,0);
});
test('schema persists tracking start independently of first interaction',async()=>{const sql=[];await initializeCommunityStatisticsSchema({query:async q=>sql.push(q)});assert.ok(sql.some(q=>q.includes('INSERT IGNORE')&&q.includes('tracking_since')));});
test('raffle totals normalize names, remove markers, exclude future entries and bonus tickets',()=>{
 const report=buildCommunityStatistics({now:100,windows:[{type:'biweekly',salesStart:50,salesEnd:110}],banking:[{displayName:'Alice',type:'biweekly',time:60,purchasedTickets:3,totalTickets:9,amount:3001},{displayName:'alice',type:'biweekly',time:70,purchasedTickets:2,amount:2003},{displayName:'Future',type:'biweekly',time:101,purchasedTickets:99,amount:99000},{displayName:'Old',type:'monthly',time:1,purchasedTickets:1,amount:1000}]});
 assert.deepEqual(report.highlights.find(x=>x.id==='tickets-biweekly').rows.map(r=>[r.name,r.value]),[['Alice',5]]);
 assert.equal(report.highlights.find(x=>x.id==='raffle-spending').rows[0].value,5000);
});
test('valid bot writes deduplicate interaction ID and discard private metadata',async()=>{
 const handlers={};const calls=[];const socket={on:(e,h)=>handlers[e]=h,guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',guildSyncBot:{guild_id:'456'}};
 registerCommunityStatisticsSocket(socket,{db:{execute:async(...args)=>calls.push(args)}});
 let result;await handlers['guildsync:record-discord-interaction']({guildId:'456',interactionId:'123',userId:'789',displayName:'Test',type:'button',name:'secret:token',arguments:'private'},r=>result=r);
 assert.equal(result.ok,true);assert.match(calls[0][0],/INSERT IGNORE/);assert.equal(calls[0][1].at(-1),'button');assert.ok(!JSON.stringify(calls).includes('private'));
 await handlers['guildsync:record-discord-interaction']({guildId:'999',interactionId:'123',userId:'789',type:'slash'},r=>result=r);assert.equal(result.ok,false);assert.equal(calls.length,1);
});
test('report envelope includes persisted coverage start for approved viewer even with no interactions',async()=>{
 const handlers={};const socket={on:(e,h)=>handlers[e]=h,guildSyncAuthenticated:true,guildSyncUser:{role:'viewer'}};
 registerCommunityStatisticsSocket(socket,{db:{execute:async sql=>[sql.includes('metadata_value')?[{metadata_value:'2026-10-24T00:00:00Z'}]:[]]},loadBanking:async()=>[],now:()=>100});
 let result;await handlers['guildsync:request-community-statistics']({},r=>result=r);assert.equal(result.ok,true);assert.equal(result.report.trackingSince,'2026-10-24T00:00:00Z');assert.ok(result.report.notes.length);
});
test('tenure does not claim uninterrupted membership when a later departure is recorded',()=>{
 const report=buildCommunityStatistics({now:1000,roster:[{account_name:'A',in_roster:1}],rosterEvents:[{account_name:'A',event_type:'joined',event_timestamp:100},{account_name:'A',event_type:'left',event_timestamp:200}]});
 assert.deepEqual(report.highlights.find(x=>x.id==='longest-member').rows,[]);
});
test('guild departures include actual left and kicked event types',()=>{
 const report=buildCommunityStatistics({rosterEvents:[{account_name:'A',event_type:'left'},{account_name:'A',event_type:'kicked'},{account_name:'A',event_type:'promoted'}]});
 assert.equal(report.highlights.find(x=>x.id==='guild-leaves').rows[0].value,2);
});
test('report selections only use columns from actual startup table definitions',async()=>{
 const {readFile}=await import('node:fs/promises');
 const schema=await readFile(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 const ownSchema=await readFile(new URL('./community-statistics.js',import.meta.url),'utf8');
 const tables=new Map();
 for(const name of ['guildsync_roster_members','guildsync_roster_events','discord_members','discord_member_history','guildsync_discord_interactions','guildsync_discord_activity','guildsync_community_statistics_metadata']){
  const start=(schema+'\n'+ownSchema).indexOf('CREATE TABLE IF NOT EXISTS '+name+' (');
  assert.ok(start>=0,'Missing CREATE '+name);
  const definition=(schema+'\n'+ownSchema).slice(start).match(/\(([\s\S]*?)\)\s*(?:CHARACTER|`)/)[1];
  const columns=new Set([...definition.matchAll(/(?:^|[\n,])\s*(\w+)\s+(?:VARCHAR|BIGINT|INT|TINYINT|TIMESTAMP|DATETIME|BOOLEAN|TEXT)/gi)].map(m=>m[1]));
  tables.set(name,columns);
 }
 const handlers={};const socket={on:(e,h)=>handlers[e]=h,guildSyncAuthenticated:true,guildSyncUser:{role:'viewer'}};
 registerCommunityStatisticsSocket(socket,{db:{execute:async sql=>{
  const match=sql.trim().match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)/i);assert.ok(match,sql);
  const columns=tables.get(match[2]);assert.ok(columns,'Unknown table '+match[2]);
  for(const expression of match[1].split(',')){
   const name=expression.trim().match(/^(?:(?:MAX|UNIX_TIMESTAMP)\()?([a-z_]+)/i)?.[1];if(name==='COUNT')continue;
   assert.ok(columns.has(name),match[2]+' missing '+name);
  }
  return [[]];
 }},loadBanking:async()=>[],now:()=>100});
 let result;await handlers['guildsync:request-community-statistics']({},r=>result=r);assert.equal(result.ok,true);
});
test('activity report groups action types, reads separate coverage start, and does not query commands',async()=>{
 const handlers={};const sqls=[];const socket={on:(e,h)=>handlers[e]=h,guildSyncAuthenticated:true,guildSyncUser:{role:'viewer'}};
 registerCommunityStatisticsSocket(socket,{db:{execute:async sql=>{sqls.push(sql);return [sql.includes('GROUP BY discord_id, activity_type')?[{discord_id:'123',username:'Actor',activity_type:'post',activity_count:4,activity_timestamp:Math.floor(Date.now()/1000)}]:[]];}},loadBanking:async()=>[]});
 let result;await handlers['guildsync:request-community-statistics']({},r=>result=r);
 assert.ok(sqls.some(sql=>sql.includes("metadata_key = 'discord_activity_since'")));
 assert.ok(!sqls.some(sql=>sql.includes('guildsync_discord_interactions')));
 assert.equal(result.report.highlights.find(h=>h.id==='discord-posts').rows[0].value,4);
});

test('revoked approved socket is refused by current-approval hook before report queries',async()=>{
 const handlers={};let response;
 const socket={guildSyncAuthenticated:true,guildSyncAuthType:'GuildSync user',guildSyncUser:{role:'viewer',discord_user_id:'123'},on:(name,handler)=>handlers[name]=handler};
 registerCommunityStatisticsSocket(socket,{db:{execute:()=>assert.fail('must not query report')},loadBanking:()=>[],authorizeViewer:async()=>false});
 await handlers['guildsync:request-community-statistics']({},value=>response=value);assert.equal(response.ok,false);
});

test('Discord activity uses inclusive rolling 30 days and expires without new activity',()=>{
 const now=4000000, cutoff=now-30*86400;
 const activity=[{discord_id:'1',username:'Boundary',activity_type:'post',activity_count:2,activity_timestamp:cutoff},{discord_id:'2',username:'Old',activity_type:'post',activity_count:20,activity_timestamp:cutoff-1},{discord_id:'3',username:'Future',activity_type:'reaction',activity_count:30,activity_timestamp:now+1},{discord_id:'1',username:'Boundary',activity_type:'reaction',activity_count:1,activity_timestamp:now}];
 const report=buildCommunityStatistics({now,activity});
 assert.deepEqual(report.highlights.find(h=>h.id==='discord-busiest').rows.map(r=>[r.name,r.value]),[['Boundary',3]]);
 assert.equal(report.overview.find(r=>r.label==='Discord activity (last 30 days)').value,3);
 assert.match(report.highlights.find(h=>h.id==='discord-posts').description,/30 days/);
 assert.equal(buildCommunityStatistics({now:now+30*86400+2,activity}).highlights.find(h=>h.id==='discord-busiest').rows.length,0);
});

test('activity SQL bounds original event timestamps without deleting history',async()=>{
 const handlers={},calls=[];const now=4000000;
 const socket={on:(e,h)=>handlers[e]=h,guildSyncAuthenticated:true,guildSyncUser:{role:'viewer'}};
 registerCommunityStatisticsSocket(socket,{db:{execute:async(...args)=>{calls.push(args);return [[]];}},loadBanking:async()=>[],now:()=>now});
 let result;await handlers['guildsync:request-community-statistics']({},r=>result=r);
 assert.equal(result.ok,true);const query=calls.find(([sql])=>sql.includes('FROM guildsync_discord_activity'));
 assert.match(query[0],/recorded_at >= FROM_UNIXTIME\(\?\)/);assert.match(query[0],/recorded_at <= FROM_UNIXTIME\(\?\)/);assert.deepEqual(query[1],[now-30*86400,now]);
 assert.ok(!calls.some(([sql])=>/DELETE|UPDATE/i.test(sql)));
});
