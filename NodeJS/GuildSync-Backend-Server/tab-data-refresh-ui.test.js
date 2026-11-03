import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for (const path of ['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js']) {
 const source=fs.readFileSync(new URL(path,import.meta.url),'utf8');
 const names=['wireGuildSyncTabs','refreshActiveTabData','refreshPendingTabData','handleRosterDataUpdated','refreshRosterDataFromBackend','handleBankingDataUpdated','applyBankingBonusData'];
 const functions=names.map(name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0]||'').join('\n');
 function context(tab='settings') {
  const clicks={};const buttons=['discord-members','eso-members','more','settings'].map(id=>({dataset:{tabId:id},addEventListener:(_,fn)=>clicks[id]=fn}));
  const ctx={desktopSupport:{blocked:false},desktopVersionAccepted:true,pendingTabDataRefreshes:new Set(),activeGuildSyncTab:tab,socket:{connected:true},document:{querySelectorAll:()=>buttons,querySelector:()=>null},isBlockingModalOpen:()=>false,rosterMembers:[],rosterDataLoading:false,discordDataLoading:false,bankingDataLoading:false,rosterAutoRefreshAttempted:false,memberLinkDialogOpen:false,rosterLastRefreshValue:null,normalizeRosterMembers:x=>x||[],normalizeBankingEntries:x=>x||[],bankingEntries:[],raffleBonusSettings:{},raffleBonusRaffles:[],selectedBonusRaffle:'',addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:10,formatError:String,markBankingLastRefreshNow(){},calls:[],renders:0,rosterUpdates:0,bankingUpdates:0,renderGuildSyncTabLayout(){ctx.renders++},updateRosterDataView(){ctx.rosterUpdates++},updateBankingDataView(){ctx.bankingUpdates++},refreshDiscordData(){ctx.calls.push('discord-members')},refreshBankingDataFromBackend(){ctx.calls.push('more')},emitSocketWithAck:async()=>{ctx.calls.push('eso-members');return {ok:true,members:[{account_name:'Joined'}]}}};
  vm.createContext(ctx);vm.runInContext(functions,ctx);vm.runInContext('wireGuildSyncTabs()',ctx);return {ctx,clicks};
 }
 test(`${path}: every data-tab click fetches current data, including the selected tab`,async()=>{
  const {ctx,clicks}=context();for(const tab of ['discord-members','more','eso-members']) { clicks[tab]();await new Promise(r=>setImmediate(r));clicks[tab]();await new Promise(r=>setImmediate(r));assert.equal(ctx.calls.filter(x=>x===tab).length,2,tab); }
  assert.equal(ctx.renders,3);clicks.settings();assert.equal(ctx.calls.length,6);
 });
 test(`${path}: a click during a pending roster request queues a fresh follow-up`,async()=>{
  const {ctx,clicks}=context('eso-members');let release;let count=0;
  ctx.emitSocketWithAck=()=>{count++;return count===1?new Promise(resolve=>release=resolve):Promise.resolve({ok:true,members:[{account_name:'Latest'}]})};
  clicks['eso-members']();clicks['eso-members']();assert.equal(count,1);release({ok:true,members:[{account_name:'Old snapshot'}]});await new Promise(r=>setImmediate(r));assert.equal(count,2);assert.equal(ctx.rosterMembers[0].account_name,'Latest');
 });
 test(`${path}: the upload-owned roster fetch defers queued clicks until upload completion`,async()=>{
  const {ctx}=context('eso-members');ctx.pendingTabDataRefreshes.add('eso-members');let requests=0;
  ctx.emitSocketWithAck=async()=>{requests++;return {ok:true,members:[]}};
  await vm.runInContext('refreshRosterDataFromBackend({silent:true,deferPendingRefresh:true})',ctx);assert.equal(requests,1);assert.equal(ctx.rosterDataLoading,true);assert.equal(ctx.pendingTabDataRefreshes.has('eso-members'),true);
  ctx.rosterDataLoading=false;vm.runInContext("refreshPendingTabData('eso-members')",ctx);await new Promise(r=>setImmediate(r));assert.equal(requests,2);
 });
 test(`${path}: the upload-owned banking fetch retains loading until the upload can flush queued clicks`,async()=>{
  const {ctx}=context('more');ctx.pendingTabDataRefreshes.add('more');let requests=0;
  const fn=source.match(/async function refreshBankingDataFromBackend\([^]*?(?=\n(?:async )?function |$)/)[0];vm.runInContext(fn,ctx);
  ctx.emitSocketWithAck=async()=>{requests++;return {ok:true,entries:[]}};
  await vm.runInContext('refreshBankingDataFromBackend({silent:true,deferPendingRefresh:true})',ctx);assert.equal(requests,1);assert.equal(ctx.bankingDataLoading,true);
  ctx.bankingDataLoading=false;vm.runInContext("refreshPendingTabData('more')",ctx);await new Promise(r=>setImmediate(r));assert.equal(requests,2);
 });
 test(`${path}: roster join/leave broadcasts replace cached membership and update only the roster view`,async()=>{
  const {ctx}=context('eso-members');ctx.rosterMembers=[{account_name:'Left'}];ctx.payload={members:[{account_name:'Joined'}],last_refresh:'new'};await vm.runInContext('handleRosterDataUpdated(payload)',ctx);assert.equal(ctx.rosterMembers[0].account_name,'Joined');assert.equal(ctx.renders,0);assert.equal(ctx.rosterUpdates,1);
 });
 test(`${path}: bonus broadcasts refresh the bonus editor on Reports without a full redraw`,async()=>{
  const {ctx}=context();ctx.payload={ok:true,entries:[],bonusSettings:{enabled:true},bonusRaffles:[]};await vm.runInContext('handleBankingDataUpdated(payload)',ctx);assert.equal(ctx.bankingUpdates,1);assert.equal(ctx.renders,0);
 });
}
