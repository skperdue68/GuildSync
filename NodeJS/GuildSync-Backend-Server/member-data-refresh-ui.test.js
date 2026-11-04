import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const path of ['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js']){
 const source=fs.readFileSync(new URL(path,import.meta.url),'utf8');
 const names=['handleRosterDataUpdated','refreshRosterDataFromBackend','refreshMemberLinks','handleMemberLinksUpdated','shouldRefreshMemberLinksView','updateMemberLinksReportButton','updateMemberLinksView'];
 const functions=names.map(name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0]||'').join('\n');
 const start=source.indexOf("  onCurrentSocket('guildsync:member-links-updated'");const wrapperStart=source.indexOf('  const connectedSocket=socket;');const wrapper=source.slice(wrapperStart,source.indexOf("  onCurrentSocket('connect'",wrapperStart));const registration=wrapper+source.slice(start,source.indexOf("  onCurrentSocket('guildsync:discord-refresh-status'",start));
 function context(tab='settings'){
  const callbacks={};const ctx={desktopSupport:{blocked:false},desktopVersionAccepted:true,activeGuildSyncTab:tab,rosterMembers:[],rosterLastRefreshValue:null,memberLinks:[],memberLinkDialogOpen:false,memberLinksReportDialogOpen:false,discordLastSeenReportDialogOpen:false,memberLinksLoading:false,rosterDataLoading:false,socket:{connected:true,on:(name,handler)=>callbacks[name]=handler},normalizeRosterMembers:members=>members||[],addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:100,formatError:String,refreshPendingTabData(){},document:{querySelector:()=>null},renders:0,rosterUpdates:0,updateDiscordDataView(){},updateRosterDataView(){ctx.rosterUpdates++;const text=ctx.document.querySelector('.eso-roster-panel .discord-last-refresh');if(text)text.textContent=`Last Refresh: ${ctx.rosterLastRefreshValue}`},renderGuildSyncTabLayout(){ctx.renders++},emitSocketWithAck:async event=>event.includes('member-links')?{ok:true,links:[{id:2}]}:{ok:true,members:[{account_name:'new'}],last_refresh:'new-date'}};
  vm.createContext(ctx);vm.runInContext(functions+registration,ctx);return {ctx,links:payload=>callbacks['guildsync:member-links-updated'](payload)};
 }
 test(`${path}: paired roster/link broadcasts cache data without redrawing Reports & Admin`,async()=>{
  const {ctx,links}=context();ctx.payload={members:[{account_name:'Evaine'}],last_refresh:'2026-10-05'};await vm.runInContext('handleRosterDataUpdated(payload)',ctx);links({links:[{id:1,account_name:'Evaine'}]});assert.equal(ctx.renders,0);assert.equal(ctx.rosterMembers[0].account_name,'Evaine');assert.equal(ctx.memberLinks[0].id,1);
 });
 test(`${path}: duplicate link broadcasts skip redraw while changed visible links refresh`,()=>{
  const {ctx,links}=context('eso-members');links({links:[{id:1}]});assert.equal(ctx.rosterUpdates,1);links({links:[{id:1}]});assert.equal(ctx.rosterUpdates,1);links({links:[{id:2}]});assert.equal(ctx.rosterUpdates,2);assert.equal(ctx.renders,0);
 });
 test(`${path}: an open member-link report still refreshes when its data changes`,()=>{
  const {ctx,links}=context();ctx.memberLinksReportDialogOpen=true;links({links:[{id:1}]});assert.equal(ctx.renders,1);
 });
 test(`${path}: silent member/roster fetches do not redraw unrelated settings`,async()=>{
  const {ctx}=context();await vm.runInContext('refreshMemberLinks({silent:true})',ctx);await vm.runInContext('refreshRosterDataFromBackend({silent:true})',ctx);assert.equal(ctx.renders,0);assert.equal(ctx.memberLinks[0].id,2);assert.equal(ctx.rosterMembers[0].account_name,'new');assert.equal(ctx.rosterDataLoading,false);assert.equal(ctx.memberLinksLoading,false);
 });
 test(`${path}: unchanged visible roster only updates the refresh timestamp`,async()=>{
  const {ctx}=context('eso-members');const refreshText={textContent:''};ctx.document.querySelector=()=>refreshText;ctx.formatRosterRefreshDate=String;ctx.payload={members:[{account_name:'Evaine'}],last_refresh:'first'};await vm.runInContext('handleRosterDataUpdated(payload)',ctx);assert.equal(ctx.renders,0);ctx.payload.last_refresh='second';await vm.runInContext('handleRosterDataUpdated(payload)',ctx);assert.equal(ctx.renders,0);assert.equal(ctx.rosterUpdates,2);assert.equal(ctx.rosterLastRefreshValue,'second');assert.equal(refreshText.textContent,'Last Refresh: second');
 });
 test(`${path}: a link response re-enables the report Run button after switching tabs`,async()=>{
  const {ctx}=context('eso-members');let resolve;ctx.emitSocketWithAck=()=>new Promise(r=>resolve=r);
  const pending=vm.runInContext('refreshMemberLinks({silent:true})',ctx);
  ctx.activeGuildSyncTab='settings';const button={disabled:true,textContent:'Loading...'};ctx.document.querySelector=selector=>selector==='#runMemberLinksReportButton'?button:null;
  resolve({ok:true,links:[{id:1}]});await pending;assert.equal(button.disabled,false);assert.equal(button.textContent,'Run');assert.equal(ctx.renders,0);
 });
 test(`${path}: the open Last Seen report refreshes its link indicators`,()=>{
  const {ctx,links}=context();ctx.discordLastSeenReportDialogOpen=true;links({links:[{id:1}]});assert.equal(ctx.renders,1);
 });

}
