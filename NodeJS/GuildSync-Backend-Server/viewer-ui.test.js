import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {canEditGuildSyncRole,canIngestGuildSyncRole,canManageGuildSyncLinksRole,canPerformGuildSyncEvent} from './role-permissions.js';

for(const file of ['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js']) {
 const source=readFileSync(new URL(file,import.meta.url),'utf8');
 const functions=names=>names.map(name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0]||assert.fail('Missing '+name)).join('\n');
 const context=extra=>vm.createContext({desktopSupport:{blocked:false},desktopVersionAccepted:true,guildSyncSession:{logged_in:true,allowed:true,token:'token',user:{role:'viewer'}},socket:{connected:true},canEditGuildSyncRole,canIngestGuildSyncRole,canManageGuildSyncLinksRole,canPerformGuildSyncEvent,canManageGuildSyncLinks:()=>false,escapeHtml:String,escapeAttribute:String,...extra});
 test(`${file}: Viewer remains authenticated for reads but cannot edit`,()=>{
  const ctx=context();vm.runInContext(functions(['isAuthenticatedSession','canEditGuildSyncData','canIngestGuildSyncData']),ctx);
  assert.equal(vm.runInContext('isAuthenticatedSession()',ctx),true);assert.equal(vm.runInContext('canEditGuildSyncData()',ctx),false);
  assert.equal(vm.runInContext('canIngestGuildSyncData()',ctx),true);
  for(const role of ['user','admin']){ctx.guildSyncSession.user.role=role;assert.equal(vm.runInContext('canEditGuildSyncData()',ctx),true);}
 });
 test(`${file}: link reports retain rows and omit approve/unlink/unblock controls`,()=>{
  const ctx=context({canEditGuildSyncData:()=>false,memberLinksLoading:false,memberLinks:[{eso_account_name:'@Test',discord_user_id:'2',link_status:'candidate'},{link_status:'linked'},{link_status:'blocked',locked:1}],getSortedMemberLinksForReport:links=>links,getMemberLinkReportDiscordDisplay:()=> 'Discord member',getMemberLinksReportSearchText:()=> '@Test'});
  vm.runInContext(functions(['renderMemberLinksRows']),ctx);const html=vm.runInContext('renderMemberLinksRows()',ctx);
  assert.match(html,/@Test|Discord member/);assert.doesNotMatch(html,/data-accept-member-candidate|data-unlink-member-link|data-unblock-member-auto-link/);
  ctx.canManageGuildSyncLinks=()=>true;assert.match(vm.runInContext('renderMemberLinksRows()',ctx),/data-accept-member-candidate/);
 });
 test(`${file}: Viewer can read notes and linked identities without editing forms`,()=>{
  const ctx=context({canEditGuildSyncData:()=>false,rosterNotesDialogAccountName:'@Test',rosterNotesDialogError:'',renderRosterNotesRows:()=>'<tr><td>Existing note</td></tr>',renderRosterNotesForm:()=>'<textarea id="editNote"></textarea>',getMemberLinkMatchedField:()=>'',renderMemberLinkCurrentStatus:()=> 'Linked',formatMemberLinkMethodForDisplay:String});
  vm.runInContext(functions(['renderRosterNotesDialog','renderMemberLinkCurrentCard','renderMemberLinkDialogOptions']),ctx);
  const notes=vm.runInContext('renderRosterNotesDialog()',ctx);assert.match(notes,/Existing note/);assert.doesNotMatch(notes,/editNote/);
  const link=vm.runInContext('renderMemberLinkCurrentCard({eso_account_name:"@Test",discord_username:"Member",link_status:"linked"})',ctx);assert.match(link,/@Test|Member/);assert.doesNotMatch(link,/data-unlink-dialog/);assert.equal(vm.runInContext('renderMemberLinkDialogOptions()',ctx),'');
 });
 test(`${file}: Viewer can refresh Discord synchronization and automatic linking`,async()=>{
  let reads=0,event;const ctx=context({canIngestGuildSyncData:()=>true,refreshDiscordData:async()=>reads++,discordRefreshRequestRunning:false,updateDiscordDataView(){},addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:100,emitSocketWithAck:async name=>{event=name;return {ok:true}}});vm.runInContext(functions(['requestDiscordDataRefresh']),ctx);await vm.runInContext('requestDiscordDataRefresh()',ctx);assert.equal(reads,1);assert.equal(event,'guildsync:request-discord-data-refresh');
 });
 test(`${file}: Viewer receipt processing returns without side effects`,async()=>{
  const ctx=context({canEditGuildSyncData:()=>false,rosterUploadQueueProcessing:false,applicationsUploadQueueProcessing:false,bankingUploadQueueProcessing:false,depositMailPendingWriteAutoTimer:null,depositMailPendingWriteRunning:false});
  const names=['processPendingDepositMailBatches','flushPendingDepositMailAckCleanup'];vm.runInContext(functions(names),ctx);for(const name of names)await vm.runInContext(name+'()',ctx);
 });
 test(`${file}: Viewer upload workers inspect their pending queues`,async()=>{
  let reads=0;const ctx=context({canIngestGuildSyncData:()=>true,rosterUploadQueueProcessing:false,applicationsUploadQueueProcessing:false,bankingUploadQueueProcessing:false,loadPendingGuildSyncRosterUploads:()=>{reads++;return[]},loadPendingGuildSyncApplicationsUploads:()=>{reads++;return[]},loadPendingGuildSyncBankingUploads:()=>{reads++;return[]}});
  const names=['processPendingGuildSyncRosterUploads','processPendingGuildSyncApplicationsUploads','processPendingGuildSyncBankingUploads'];vm.runInContext(functions(names),ctx);for(const name of names)await vm.runInContext(name+'()',ctx);assert.equal(reads,3);
 });
 test(`${file}: Viewer has no pending-receipt highlight or counter`,()=>{
  const ctx=context({canEditGuildSyncData:()=>false});vm.runInContext(functions(['getBankingMailAttentionCount','shouldShowBankingMailTabAttention']),ctx);assert.equal(vm.runInContext('getBankingMailAttentionCount()',ctx),0);assert.equal(vm.runInContext('shouldShowBankingMailTabAttention("more",false)',ctx),false);
 });
 test(`${file}: Viewer client refuses direct write events before emitting packets`,async()=>{
  let emissions=0;const ctx=context({socket:{connected:true,emit(){emissions++;}}});vm.runInContext(functions(['emitSocketWithAck']),ctx);await assert.rejects(vm.runInContext('emitSocketWithAck("guildsync:manual-link-member")',ctx),/permission/);assert.equal(emissions,0);
 });
 test(`${file}: an older preview acknowledgement cannot overwrite a newer profile event`,async()=>{
  let applied=0;const ctx=context({guildSyncSession:{user:{role:'user',actual_role:'admin'}},document:{querySelectorAll:()=>[]},emitSocketWithAck:async()=>({ok:true,user:{role:'viewer',actual_role:'admin'}}),handleCurrentAccountProfile:()=>applied++,closeProfileMenu(){},addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:100});
  vm.runInContext(functions(['changeGuildSyncRoleView']),ctx);await vm.runInContext('changeGuildSyncRoleView("viewer")',ctx);assert.equal(applied,0);assert.equal(ctx.guildSyncSession.user.role,'user');
 });
}
test('backend and both clients use the same role/event policy',()=>{
 const policy=readFileSync(new URL('./role-permissions.js',import.meta.url),'utf8');
 for(const path of ['./web/src/role-permissions.js','../../GO/GuildSync-Frontend-Client/frontend/src/role-permissions.js'])assert.equal(readFileSync(new URL(path,import.meta.url),'utf8'),policy);
});
