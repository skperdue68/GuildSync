import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMemberHistoryButton, createMemberHistoryActions} from './web/src/member-history-shortcuts.js';
test('history shortcut safely includes the exact member identity and accessible label', () => {
 const markup=renderMemberHistoryButton({kind:'discord',id:'123',name:'A"<B'});
 assert.match(markup,/data-member-history-id="123"/);
 assert.match(markup,/A&quot;&lt;B/);
});
test('initial and incremental wiring opens the exact member once', () => {
 const calls=[]; const button={dataset:{memberHistoryKind:'discord',memberHistoryId:'123',memberHistoryName:'Same Name'},addEventListener(type,fn){this.click=fn;}};
 const actions=createMemberHistoryActions({openDiscord:(...args)=>calls.push(args),openRoster:()=>assert.fail()});
 const root={querySelectorAll:()=>[button]}; actions.wire(root); const first=button.click; actions.wire(root); assert.equal(button.click,first);button.click();assert.deepEqual(calls,[['123','Same Name']]);
 const next={...button,dataset:{memberHistoryKind:'roster',memberHistoryId:'@ESO',memberHistoryName:'@ESO'}};
 const roster=[];createMemberHistoryActions({openRoster:id=>roster.push(id)}).wire({querySelectorAll:()=>[next]});next.click();assert.deepEqual(roster,['@ESO']);
});

import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const clients=['./web/src','../../GO/GuildSync-Frontend-Client/frontend/src'];
function sourceFunction(source,name) {
 const start=source.indexOf(`function ${name}(`);assert.notEqual(start,-1,name);
 const end=source.indexOf('\n}',start);return source.slice(start,end+2);
}
for(const client of clients) {
 const source=readFileSync(new URL(`${client}/main.js`,import.meta.url),'utf8').replaceAll('\r\n','\n');
 test(`${client}: row actions select exact identities and fill the existing history search`,()=>{
  const calls=[];const ctx=vm.createContext({clearTimeout:()=>{},rosterHistorySearchTimer:null,discordHistorySearchTimer:null,rosterHistorySearchGeneration:0,discordHistorySearchGeneration:0,rosterMembers:[{account_name:'@Alice',rank:'Soldier'}],discordMembers:[{discord_id:'123',username:'Same Name'},{discord_id:'456',username:'Same Name'}],loadRosterStreamHistory:id=>calls.push(['roster',id]),loadDiscordMemberHistory:(id,name)=>calls.push(['discord',id,name])});
  vm.runInContext(sourceFunction(source,'openRosterMemberHistory')+'\n'+sourceFunction(source,'openDiscordMemberHistory'),ctx);
  ctx.openRosterMemberHistory('@Alice');ctx.openDiscordMemberHistory('456','Same Name');
  assert.deepEqual(calls,[['roster','@Alice'],['discord','456','Same Name']]);assert.equal(ctx.rosterHistoryDialogOpen,true);assert.equal(ctx.discordHistoryDialogOpen,true);assert.equal(ctx.rosterHistoryMatches[0].account_name,'@Alice');assert.equal(ctx.discordHistoryMatches[0].discord_id,'456');assert.equal(ctx.discordHistoryActiveMatchIndex,0);
 });
 test(`${client}: both row renderers keep six columns with history before links`,()=>{
  const context=vm.createContext({renderMemberHistoryButton,escapeHtml:String,escapeAttribute:String,getEsoRosterRankColor:()=>'',rosterSearchActiveIndex:-1,renderEsoRosterRank:String,formatRosterJoinedDate:String,renderRosterNotesButton:()=> 'Notes',renderMemberLinkStatusButton:()=> 'Linked',getDiscordMemberAvatarURL:()=>'',getMemberSortName:()=> 'Alice',discordRoles:[],getDiscordMemberColor:()=> '#fff',getInitials:()=> 'A'});
  vm.runInContext(sourceFunction(source,'renderEsoRosterRow')+'\n'+sourceFunction(source,'renderDiscordMemberRow'),context);
  for(const html of [context.renderEsoRosterRow({account_name:'@Alice',rank:'Associate'}),context.renderDiscordMemberRow({discord_id:'123',username:'Alice'})]) {
   assert.equal((html.match(/<td[ >]/g)||[]).length,6);assert.ok(html.indexOf('member-history-cell')<html.indexOf('member-link-action-cell'));
  }
  assert.match(source,/function bindLiveDataActions\(root\) \{\s+memberHistoryActions.wire\(root\)/);
 });
 test(`${client}: shortcut moves focus into the modal and restores its focused control after loading`,async()=>{
  let finish;const focused=[];const document={activeElement:{id:''}};
  const ctx=vm.createContext({document,discordHistoryDialogOpen:true,discordHistoryMatches:[{discord_id:'123'}],discordHistoryLoadGeneration:0,renderGuildSyncTabLayout:()=>{},focusInputById:id=>{focused.push(id);document.activeElement={id};},emitSocketWithAck:()=>new Promise(resolve=>finish=resolve),normalizeDiscordHistoryEvents:items=>items,formatError:String});
  vm.runInContext('async '+sourceFunction(source,'loadDiscordMemberHistory'),ctx);
  const loading=ctx.loadDiscordMemberHistory('123','Alice',{focusHistory:true});
  assert.deepEqual(focused,['discordHistorySearchInput']);document.activeElement={id:'closeDiscordHistoryButton'};finish({ok:true,events:[]});await loading;
  assert.deepEqual(focused,['discordHistorySearchInput','closeDiscordHistoryButton']);
 });
 test(`${client}: delayed Discord history cannot replace the selected member`,async()=>{
  const pending=[];const ctx=vm.createContext({discordHistoryMatches:[{discord_id:'456'}],discordHistoryLoadGeneration:0,renderGuildSyncTabLayout:()=>{},emitSocketWithAck:()=>new Promise(resolve=>pending.push(resolve)),normalizeDiscordHistoryEvents:items=>items,formatError:String});
  vm.runInContext('async '+sourceFunction(source,'loadDiscordMemberHistory'),ctx);
  const old=ctx.loadDiscordMemberHistory('123','Old'),current=ctx.loadDiscordMemberHistory('456','Current');
  pending[1]({ok:true,events:['current']});await current;pending[0]({ok:true,events:['old']});await old;
  assert.equal(ctx.discordHistorySearchText,'Current');assert.equal(ctx.discordHistorySelectedID,'456');assert.deepEqual(ctx.discordHistoryEvents,['current']);assert.equal(ctx.discordHistoryLoading,false);assert.equal(ctx.discordHistoryMatches[0].event_count,1);
 });
}
test('desktop and web share accessible shortcut markup and compact styles',()=>{
 for(const file of ['member-history-shortcuts.js','member-history-shortcuts.css'])assert.equal(readFileSync(new URL(`${clients[0]}/${file}`,import.meta.url),'utf8'),readFileSync(new URL(`${clients[1]}/${file}`,import.meta.url),'utf8'));
});
