import test from 'node:test';
import assert from 'node:assert/strict';
import {renderUserSwitchControls,canUseUserSwitch} from './web/src/user-switch-controls.js';
test('only server actor metadata enables account switch, including return for Viewer',()=>{
 assert.equal(canUseUserSwitch({role:'admin'}),false);
 assert.equal(renderUserSwitchControls({role:'user'}),'');
 const actor={user_switch:{active:false,actor_id:'1'},role:'admin'};
 assert.match(renderUserSwitchControls(actor),/select/);
 const viewer={role:'viewer',user_switch:{active:true,actor_id:'1',target_name:'Viewer <name>'}};
 assert.match(renderUserSwitchControls(viewer),/Return to my account/);
 assert.match(renderUserSwitchControls(viewer),/Viewer &lt;name&gt;/);
 assert.doesNotMatch(renderUserSwitchControls(viewer),/select/);
});
import {readFileSync} from 'node:fs';
for (const client of ['web','../../GO/GuildSync-Frontend-Client/frontend']) {
 const source=readFileSync(new URL(`./${client}/src/main.js`,import.meta.url),'utf8').replace(/\r\n/g,'\n');
 test(`${client} switches identity, clears caches and reconnects the actual token`,()=>{
  const body=source.match(/function applyUserSwitchProfile\(user\) \{([\s\S]*?)\n\}\n\nasync function changeGuildSyncRoleView/)[1];
  const calls=[];
  const noop=()=>{};
  const target={discord_user_id:'target',role:'viewer',user_switch:{active:true,actor_id:'admin'}};
  const state={user:target,guildSyncSession:{token:'actual-token',user:{discord_user_id:'admin'}},sessionGeneration:4,window:{clearTimeout:noop},pendingTabDataRefreshes:new Set(['members']),userAdministrationPanel:{reset:()=>calls.push('reset')},adminConfigurationPanel:{clear:noop},voiceHotkey:{stop:noop},connectSocket:()=>calls.push('connect'),renderDiscordArea:noop,renderGuildSyncTabLayout:noop,syncGuildSyncFileWatcherWithAuthState:noop,StopGuildSyncFileWatcher:noop};
  const scope=new Proxy(state,{has:()=>true,get:(o,k)=>k===Symbol.unscopables?undefined:k in o?o[k]:globalThis[k]??noop,set:(o,k,v)=>(o[k]=v,true)});
  new Function('scope','user',`with(scope){(function(user){${body}})(user)}`)(scope,{discord_user_id:'target',role:'viewer',user_switch:{active:true,actor_id:'admin'}});
  assert.equal(state.guildSyncSession.token,'actual-token');
  assert.equal(state.guildSyncSession.user.role,'viewer');
  assert.equal(state.sessionGeneration,5);
  for(const key of ['discordMembers','rosterMembers','bankingEntries','memberLinks','associateTicketReportRows','rosterNotesDialogNotes'])assert.deepEqual(state[key],[],key);
  assert.equal(state.pendingTabDataRefreshes.size,0);
  assert.deepEqual(calls,['reset','connect']);
 });
 test(`${client} active menu hides preserved role preview`,()=>{
  const body=source.match(/function renderOpenProfileMenuContents\(\) \{([\s\S]*?)\nasync function loadUserSwitchOptions/)[1];
  assert.doesNotMatch(body,/\$\{renderRoleViewControls/);
  assert.match(body,/renderUserSwitchControls/);
 });
}

for(const client of ['web','../../GO/GuildSync-Frontend-Client/frontend']){
 const source=readFileSync(new URL(`./${client}/src/main.js`,import.meta.url),'utf8').replace(/\r\n/g,'\n');
 test(`${client} Viewer can return and old identity acknowledgements are rejected`,async()=>{
  const body=source.match(/function emitSocketWithAck\(eventName, payload = \{\}, timeoutMs = 30000\) \{([\s\S]*?)\n\}\n\nfunction normalizeDiscordMembers/)[1];
  let callback;
  const state={Promise,Error,canUseUserSwitch,canPerformGuildSyncEvent:()=>false,guildSyncSession:{user:{role:'viewer',user_switch:{active:true,actor_id:'admin'}}},sessionGeneration:1,socket:{connected:true,emit:(event,payload,ack)=>{callback=ack;}},window:{setTimeout,clearTimeout},desktopSupport:{blocked:false},desktopVersionAccepted:true};
  const scope=new Proxy(state,{has:()=>true,get:(o,k)=>k===Symbol.unscopables?undefined:o[k],set:(o,k,v)=>(o[k]=v,true)});
  const request=new Function('scope',`with(scope){return function(eventName,payload={},timeoutMs=30000){${body}}}`)(scope);
  const returning=request('guildsync:set-user-switch',{discord_user_id:null});
  assert.equal(typeof callback,'function');
  state.sessionGeneration++;
  callback({ok:true,user:{role:'admin'}});
  await assert.rejects(returning,/Account session changed/);
  await assert.rejects(request('guildsync:request-users'),/permission/);
 });
}
for(const kind of ['Roster','Banking','Applications']){
 test(`desktop ${kind} queued upload cannot commit ESO files after switching starts`,async()=>{
  const source=readFileSync(new URL('../../GO/GuildSync-Frontend-Client/frontend/src/main.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const name=`sendQueuedGuildSync${kind}Upload`;
  const body=source.split(`async function ${name}(`)[1].split(/\n(?:async )?function /)[0];
  let resolveAck,commits=0;
  const state={Promise,Error,sessionGeneration:1,userSwitchTransition:false,guildSyncSession:{user:{role:'admin'}},socket:{connected:true},emitSocketWithAck:()=>new Promise(resolve=>{resolveAck=resolve;}),[`CommitGuildSync${kind}Data`]:()=>{commits++;return {ok:true};},formatGuildSyncApplicationDiscordMessage:()=>'',addSystemMessage:()=>{},TRANSIENT_MESSAGE_TTL_MS:1};
  const scope=new Proxy(state,{has:()=>true,get:(o,k)=>k===Symbol.unscopables?undefined:k in o?o[k]:globalThis[k]});
  const send=new Function('scope',`with(scope){return async function(${body}}`)(scope);
  const pending=send({data:{records:[{id:'one'}]}});
  state.userSwitchTransition=true;
  if(resolveAck)resolveAck({ok:true});
  await assert.rejects(pending,/Account session changed/);
  assert.equal(commits,0);
 });
}



test('demoted actor loses switch controls while a selected Viewer retains return',()=>{
 assert.equal(renderUserSwitchControls({role:'user',user_switch:{active:false,can_switch:false,actor_id:'1',revision:2}}),'');
 assert.match(renderUserSwitchControls({role:'viewer',user_switch:{active:true,can_switch:true,actor_id:'1',target_name:'Viewer'}}),/Return to my account/);
});
for(const client of ['web','../../GO/GuildSync-Frontend-Client/frontend']){
 test(`${client} authoritative account profile removes omitted switch metadata`,()=>{
  const source=readFileSync(new URL(`./${client}/src/main.js`,import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const body=source.split('function handleCurrentAccountProfile(user) {')[1].split('\nfunction renderDiscordArea()')[0];
  const noop=()=>{};
  const state={Number,Boolean,guildSyncSession:{user:{discord_user_id:'actor',role:'user',user_switch:{active:false,can_switch:false,revision:8}}},userAdministrationPanel:{start:noop},renderDiscordArea:noop};
  const scope=new Proxy(state,{has:()=>true,get:(o,k)=>k===Symbol.unscopables?undefined:o[k]});
  const apply=new Function('scope',`with(scope){return function(user){${body}}`)(scope);
  apply({discord_user_id:'actor',role:'user'});
  assert.equal(state.guildSyncSession.user.user_switch,undefined);
 });
}
for(const client of ['web','../../GO/GuildSync-Frontend-Client/frontend']){
 test(`${client} backend restart can replace a higher old revision with the actor identity`,()=>{
  const source=readFileSync(new URL(`./${client}/src/main.js`,import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const body=source.match(/function applyUserSwitchProfile\(user\) \{([\s\S]*?)\n\}\n\nasync function changeGuildSyncRoleView/)[1];
  const noop=()=>{},calls=[];
  const state={user:{discord_user_id:'actor',role:'admin',user_switch:{active:false,actor_id:'actor',can_switch:true,revision:0,epoch:'new-server'}},guildSyncSession:{token:'actor-token',user:{discord_user_id:'target',role:'viewer',user_switch:{active:true,actor_id:'actor',revision:9,epoch:'old-server'}}},sessionGeneration:2,window:{clearTimeout:noop},pendingTabDataRefreshes:new Set(),userAdministrationPanel:{reset:noop},adminConfigurationPanel:{clear:noop},voiceHotkey:{stop:noop},connectSocket:()=>calls.push('connect'),renderDiscordArea:noop,renderGuildSyncTabLayout:noop,syncGuildSyncFileWatcherWithAuthState:noop,StopGuildSyncFileWatcher:noop};
  const scope=new Proxy(state,{has:()=>true,get:(o,k)=>k===Symbol.unscopables?undefined:k in o?o[k]:globalThis[k]??noop,set:(o,k,v)=>(o[k]=v,true)});
  new Function('scope','user',`with(scope){(function(user){${body}})(user)}`)(scope,{discord_user_id:'actor',role:'admin',user_switch:{active:false,actor_id:'actor',can_switch:true,revision:0,epoch:'new-server'}});
  assert.equal(state.guildSyncSession.user.discord_user_id,'actor');assert.equal(state.sessionGeneration,3);assert.deepEqual(calls,['connect']);
 });
}
