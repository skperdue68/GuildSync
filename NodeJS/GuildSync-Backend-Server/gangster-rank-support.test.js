import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const paths=['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js'];
function extract(source,name){const start=source.indexOf(`function ${name}(`); assert.ok(start>=0);return source.slice(start,source.indexOf('\n}\n',start)+2);}
for(const path of paths){
 test(`${path}: Gangster rank and unassigned synced Gangsters role are available in filters`,()=>{
  const source=fs.readFileSync(new URL(path,import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const ctx=vm.createContext({rosterMembers:[],discordRoles:[{role_id:'1',role_name:'Gangsters',role_color:0xaabbcc}],discordMembers:[]});
  vm.runInContext(['getAllRosterRankNames','getAllDiscordRoleNames','getEsoRosterRankColor','findRoleByRosterRankName','getDiscordRoleNamesForRosterRank','findRoleByName','normalizeDiscordRoleName','discordRoleColorToHex'].map(n=>extract(source,n)).join('\n'),ctx);
  assert.ok(ctx.getAllRosterRankNames().includes('Gangster'));
  assert.ok(ctx.getAllDiscordRoleNames().includes('Gangsters'));
  assert.equal(ctx.getEsoRosterRankColor('Gangster'),'#aabbcc');
  ctx.discordRoles[0].role_color=0x123456;
  assert.equal(ctx.getEsoRosterRankColor('Gangster'),'#123456');
  ctx.discordMembers=[{roles:[{role_name:'Associates'},{role_name:'Gangsters'}]}];
  assert.deepEqual(Array.from(ctx.getAllDiscordRoleNames()),['Associates','Gangsters']);
 });
}
test('rank audit recognizes Gangster on both sides as rank 6 below Associate',async()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const ctx=vm.createContext({});vm.runInContext('async '+extract(source,'getDiscordRankAuditReport'),ctx);
 let query=''; await ctx.getDiscordRankAuditReport({execute:async sql=>{query=sql;return [[]];}});
 assert.match(query,/WHEN LOWER\(TRIM\(roles.role_name\)\) IN \('gangster', 'gangsters'\) THEN 6/);
 assert.equal((query.match(/WHEN LOWER\(TRIM\(roster.rank_name\)\) IN \('gangster', 'gangsters'\) THEN 6/g)||[]).length,2);
 assert.match(query,/'associates',\s*'gangster',\s*'gangsters'/);
});
