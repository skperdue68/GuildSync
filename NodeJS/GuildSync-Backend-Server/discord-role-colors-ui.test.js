import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const paths=['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js'];
function load(path, roles=[], members=[]) {
 const source=readFileSync(new URL(path,import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const names=['normalizeDiscordRole','normalizeDiscordRoleName','findRoleByName','getDiscordRoleNamesForRosterRank','findRoleByRosterRankName','discordRoleColorToHex','getDiscordMemberColor','getEsoRosterRankColor'];
 const functions=names.map(name=>{const start=source.indexOf(`function ${name}(`);assert.notEqual(start,-1,`missing ${name}`);const end=source.indexOf('\n}\n',start);return source.slice(start,end+2)}).join('\n');
 const context=vm.createContext({discordRoles:roles,discordMembers:members});vm.runInContext(functions,context);return context;
}
for (const path of paths) {
 test(`${path}: retains Discord hierarchy and selects highest colored role, independent of membership order`,()=>{
  const ctx=load(path);assert.equal(ctx.normalizeDiscordRole({id:'1',position:12}).role_position,12);
  const roles=[{role_id:'30',role_color:0xff0000,role_position:1},{role_id:'20',role_color:0x00ff00,role_position:8},{role_id:'10',role_color:0,role_position:10}];
  assert.equal(ctx.getDiscordMemberColor({roles}),'#00ff00');assert.equal(ctx.getDiscordMemberColor({roles:[...roles].reverse()}),'#00ff00');
  assert.equal(ctx.getDiscordMemberColor({roles:[{role_color:0,role_position:99}]}),'#64748b');
 });
 test(`${path}: live global colors and hierarchy override stale member snapshots; lower snowflake wins ties`,()=>{
  const global=[{role_id:'90071992547409932',role_color:0xff0000,role_position:3},{role_id:'90071992547409931',role_color:0x00ff00,role_position:3}];
  const ctx=load(path,global);const member={roles:global.map(r=>({...r,role_color:0x0000ff,role_position:1}))};
  assert.equal(ctx.getDiscordMemberColor(member),'#00ff00');global[0].role_position=4;assert.equal(ctx.getDiscordMemberColor(member),'#ff0000');global[0].role_color=0x123456;assert.equal(ctx.getDiscordMemberColor(member),'#123456');
 });
 test(`${path}: roster aliases prefer plural Discord guild roles over conflicting singular names`,()=>{
  const ctx=load(path,[{role_id:'1',role_name:'Associates',role_color:0x112233},{role_id:'2',role_name:'Soldiers',role_color:0x445566},{role_name:'Capos',role_color:0x998877},{role_name:'Gangsters',role_color:0x778899},{role_name:'Capo Regimes',role_color:0xaabbcc}]);
  for(const [rank,color] of [['Associate','#112233'],['Soldier','#445566'],['Capo','#998877'],['Gangster','#778899'],['Caporegime','#aabbcc'],['Caporegimes','#aabbcc']])assert.equal(ctx.getEsoRosterRankColor(rank),color);
  ctx.discordRoles.push({role_name:'Associate',role_color:0xabcdef});assert.equal(ctx.getEsoRosterRankColor('Associate'),'#112233');assert.equal(ctx.getEsoRosterRankColor('Unknown'),'#64748b');
 });
}

for (const path of paths) {
 test(`${path}: rank chips share alias color and Discord rows render live hierarchy colors`,()=>{
  const source=readFileSync(new URL(path,import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const roles=[{role_id:'1',role_name:'Associates',role_color:0xff9900,role_position:4},{role_id:'2',role_name:'Associate',role_color:0x00cc66},{role_id:'3',role_name:'Soldiers',role_color:0xffff00},{role_id:'4',role_name:'Soldier',role_color:0x3399cc}];
  const ctx=load(path,roles);
  Object.assign(ctx,{escapeHtml:String,escapeAttribute:String,getReadableTextColor:()=> 'white',buildFilledRoleStyle:color=>`color: ${color}`,getDiscordMemberAvatarURL:()=>'',getMemberSortName:()=> 'Name',getInitials:()=> 'N',renderDiscordRoleBadge:()=>'',renderMemberLinkStatusButton:()=>''});
  for(const name of ['renderRosterRankFilterChip','renderDiscordMemberRow']) {const start=source.indexOf(`function ${name}(`),end=source.indexOf('\n}\n',start);vm.runInContext(source.slice(start,end+2),ctx);}
  assert.match(ctx.renderRosterRankFilterChip('Associate'),/color: #ff9900/);
  assert.match(ctx.renderRosterRankFilterChip('Soldier'),/color: #ffff00/);
  assert.match(ctx.renderDiscordMemberRow({discord_id:'member',roles:[{role_id:'1',role_color:0xff0000}]}),/<tr style="color: #ff9900;"/);
  roles[0].role_color=0x654321;
  assert.match(ctx.renderRosterRankFilterChip('Associate'),/color: #654321/);
  assert.match(ctx.renderDiscordMemberRow({discord_id:'member',roles:[{role_id:'1',role_color:0xff0000}]}),/<tr style="color: #654321;"/);
 });
}

for (const path of paths) {
 test(`${path}: Discord and guild role selections both match any selected role`,()=>{
  const source=readFileSync(new URL(path,import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const members=[{username:'associate',roles:[{role_name:'Associates'}]},{username:'soldier',roles:[{role_name:'Soldiers'}]},{username:'capo',roles:[{role_name:'Capo'}]}];
  const ctx=vm.createContext({discordSearchText:'',discordSelectedRoleNames:new Set(['Associates','Soldiers']),discordMembers:members,discordSelectedLinkStatuses:new Set(),memberLinkFilterSetMatches:()=>true,getDiscordMemberLinkFilterStatus:()=>'',sortDiscordMembers:value=>value,rosterSearchText:'',rosterSelectedRankNames:new Set(['Associate','Soldier']),rosterSelectedLinkStatuses:new Set(),rosterMembers:[{rank:'Associate'},{rank:'Soldier'},{rank:'Capo'}],getRosterMemberLinkFilterStatus:()=>'',sortRosterMembers:value=>value});
  for(const name of ['getFilteredDiscordMembers','getFilteredRosterMembers']) {const start=source.indexOf(`function ${name}(`),end=source.indexOf('\n}\n',start);vm.runInContext(source.slice(start,end+2),ctx);}
  assert.deepEqual(Array.from(ctx.getFilteredDiscordMembers(),m=>m.username),['associate','soldier']);
  assert.deepEqual(Array.from(ctx.getFilteredRosterMembers(),m=>m.rank),['Associate','Soldier']);
  ctx.discordSelectedRoleNames.clear(); assert.equal(ctx.getFilteredDiscordMembers().length,3);
 });
}
