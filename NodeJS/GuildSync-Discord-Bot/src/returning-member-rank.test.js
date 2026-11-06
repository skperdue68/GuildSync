import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {restoreReturningMemberRank,appendReturningMemberNotice} from './returning-member-rank.js';
const role=(id,name)=>({id,name});
function guild({existing=['1','2'],names=['Alice'],failAdd=false}={}) {
 const roles=new Map([role('1','Gangsters'),role('2','Associates'),role('3','Soldiers'),role('4','Capo'),role('5','Consigliere'),role('6','Kingpin'),role('7','Decorative')].map(r=>[r.id,r]));
 const calls=[];const members=new Map(names.map((name,index)=>{
  const member={id:String(100+index),user:{username:name},displayName:name,roles:{cache:new Map(existing.map(id=>[id,roles.get(id)])),
   add:async id=>{if(failAdd)throw Error('Missing Permissions');calls.push(['add',id]);member.roles.cache.set(id,roles.get(id));},
   remove:async ids=>{calls.push(['remove',ids]);for(const id of ids)member.roles.cache.delete(id);}}};return [member.id,member];
 }));
 members.set('999',{id:'999',user:{username:'Officer'},roles:{cache:new Map([['5',roles.get('5')]])}});
 return {roles:{fetch:async()=>roles},members:{fetch:async id=>id?members.get(typeof id==='object'?id.user:id):members},calls,member:members.get('100')};
}
test('restores singular historical rank, removes lower guild ranks, retains decorative roles and pings officers',async()=>{
 const g=guild({existing:['1','2','7']});
 const result=await restoreReturningMemberRank(g,{applicantAccount:'@Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:['100']}});
 assert.deepEqual(g.calls,[['add','3'],['remove',['1','2']]]);
 assert.match(result.notice,/returning member/i);assert.match(result.notice,/Soldiers/);assert.match(result.notice,/ESO/);
 assert.deepEqual(result.roleMentions,['5']);assert.ok(g.member.roles.cache.has('7'));
});
test('never downgrades a higher current rank and repeats are idempotent',async()=>{
 const g=guild({existing:['1','4']});const data={applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:['100']}};
 const first=await restoreReturningMemberRank(g,data);await restoreReturningMemberRank(g,data);
 assert.deepEqual(g.calls,[['remove',['1']]]);assert.match(first.notice,/Capo/);
 assert.match(first.notice,/verify which rank they should hold in ESO/);
 assert.doesNotMatch(first.notice,/must also promote/);
});
test('ambiguous exact-name matches never grant roles; permission failures do not claim restoration',async()=>{
 const g=guild({names:['Alice','Alice']});
 const result=await restoreReturningMemberRank(g,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:[]}});
 assert.equal(g.calls.length,0);assert.match(result.notice,/could not|unable|review/i);
 const fail=guild({failAdd:true});
 const failed=await restoreReturningMemberRank(fail,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:['100']}});
 assert.match(failed.notice,/could not|unable/i);assert.equal(fail.calls.length,0);
});
test('post footer remains outside truncated code blocks and within Discord limit',()=>{
 const text=appendReturningMemberNotice('Header\n```\n'+'a'.repeat(2100)+'\n```','Returning member. Promote in ESO. <@&5>');
 assert.ok(text.length<=2000);assert.equal((text.split('```').length-1)%2,0);
 assert.ok(text.endsWith('Returning member. Promote in ESO. <@&5>'));
});
test('application posting restores accepted returning members only and restricts officer mentions',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-discord-bot.js',import.meta.url),'utf8');
 const a=source.indexOf('async function sendEsoGuildApplicationMessage('),b=source.indexOf('async function getStartupGuild(',a);
 const posted=[];let restores=0;
 const ctx=vm.createContext({DISCORD_GUILD_ID:'guild',applicationRankEnvironment:{},Log(){},
   getEsoGuildApplicationsDestination:()=>({guildId:'guild',threadId:'thread'}),
   client:{guilds:{fetch:async()=>({channels:{fetch:async()=>({isThread:()=>true,send:async data=>posted.push(data)})}})}},
   restoreReturningMemberRank:async()=>{restores++;return {notice:'Returning. <@&5>',roleMentions:['5']};},appendReturningMemberNotice});
 vm.runInContext(source.slice(a,b),ctx);
 await ctx.sendEsoGuildApplicationMessage('Application',{action:'accepted',returningMember:{actorDiscordId:'999',rankName:'Soldier'}});
 assert.equal(restores,1);assert.match(posted[0].content,/Returning/);
 assert.equal(posted[0].allowedMentions.roles[0],'5');assert.equal(posted[0].allowedMentions.parse.length,0);
 await ctx.sendEsoGuildApplicationMessage('Declined',{action:'declined',returningMember:{actorDiscordId:'999',rankName:'Soldier'}});
 await ctx.sendEsoGuildApplicationMessage('New member',{action:'accepted'});
 ctx.applicationRankEnvironment.GUILDSYNC_APPLICATION_RESTORE_RANK_ENABLED='false';
 await ctx.sendEsoGuildApplicationMessage('Disabled',{action:'accepted',returningMember:{actorDiscordId:'999',rankName:'Soldier'}});
 assert.equal(restores,1);
 ctx.DISCORD_GUILD_ID='another';
 await assert.rejects(()=>ctx.sendEsoGuildApplicationMessage('Wrong guild',{}),/configured Discord guild/);
});
test('custom rank IDs and officer role IDs work without granting a lower rank to an existing higher member',async()=>{
 const g=guild({existing:['4','7']});
 const result=await restoreReturningMemberRank(g,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:['100']}},
   {rankRefs:'1,2,3,4,5,6',officerRef:'5'});
 assert.equal(g.calls.length,0);assert.deepEqual(result.roleMentions,['5']);assert.match(result.notice,/Capo/);
});
test('unverified and lower-ranked uploaders cannot cause a role grant from uploaded history',async()=>{
 const g=guild();
 const data={applicantAccount:'Alice',returningMember:{rankName:'Kingpin',discordUserIds:['100']}};
 const legacy=await restoreReturningMemberRank(g,data);
 assert.match(legacy.notice,/verified officer/);assert.equal(g.calls.length,0);
 const unprivileged=await restoreReturningMemberRank(g,{...data,returningMember:{...data.returningMember,actorDiscordId:'100'}});
 assert.match(unprivileged.notice,/does not currently have officer rank/);assert.equal(g.calls.length,0);
 const aboveOfficer=await restoreReturningMemberRank(g,{...data,returningMember:{...data.returningMember,actorDiscordId:'999'}});
 assert.match(aboveOfficer.notice,/above the uploader/);assert.equal(g.calls.length,0);
});

test('already-held Soldier rank is named and asks officers to verify ESO rather than assuming promotion',async()=>{
 const g=guild({existing:['3']});
 const result=await restoreReturningMemberRank(g,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:['100']}});
 assert.equal(g.calls.length,0);
 assert.match(result.notice,/currently holds Discord rank.*Soldiers/);
 assert.match(result.notice,/verify which rank they should hold in ESO/);
 assert.doesNotMatch(result.notice,/must also promote/);
 assert.deepEqual(result.roleMentions,['5']);
});

test('a failed Discord lookup still names the recorded rank and the ESO promotion',async()=>{
 const g=guild({names:['Alice','Alice']});
 const result=await restoreReturningMemberRank(g,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:[]}});
 assert.equal(g.calls.length,0);
 assert.match(result.notice,/held rank \*\*Soldier\*\* previously and needs to be promoted in ESO/);
 assert.match(result.notice,/no unique matching Discord member/);
});

test('missing rank roles and unlinked members keep the rank name in the notice',async()=>{
 const missing=guild();
 missing.roles.fetch=async()=>new Map();
 const noRole=await restoreReturningMemberRank(missing,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:['100']}});
 assert.match(noRole.notice,/held rank \*\*Soldier\*\* previously and needs to be promoted in ESO/);
 const linked=guild({names:['Bob']});
 const noMember=await restoreReturningMemberRank(linked,{applicantAccount:'Alice',returningMember:{actorDiscordId:'999',rankName:'Soldier',discordUserIds:[]}});
 assert.match(noMember.notice,/held rank \*\*Soldier\*\* previously and needs to be promoted in ESO/);
 assert.match(noMember.notice,/review the Discord link/);
});
