import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for(const path of ['./web/src/main.js','../../GO/GuildSync-Frontend-Client/frontend/src/main.js']){
 const source=fs.readFileSync(new URL(path,import.meta.url),'utf8');
 const names=['handleBankingDataUpdated','refreshBankingDataFromBackend','handleDiscordMemberDataUpdated','refreshDiscordData','applyBankingBonusData'];
 const functions=names.map(name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0]||'').join('\n');
 function context(tab='settings'){
  const ctx={activeGuildSyncTab:tab,socket:{connected:true},discordDataLoading:false,bankingDataLoading:false,discordMembers:[],discordRoles:[],discordLastRefreshValue:null,bankingEntries:[],raffleBonusSettings:{},raffleBonusRaffles:[],selectedBonusRaffle:'',bankingLastRefreshValue:null,normalizeDiscordMembers:x=>x||[],normalizeDiscordRoles:x=>x||[],normalizeBankingEntries:x=>x||[],markBankingLastRefreshNow(){ctx.bankingLastRefreshValue='now'},refreshDiscordLastRefreshDate:async()=>{},addSystemMessage(){},formatError:String,refreshPendingTabData(){},TRANSIENT_MESSAGE_TTL_MS:10,redraws:0,renderGuildSyncTabLayout(){ctx.redraws++},updateBankingDataView(){},updateDiscordDataView(){},rosterUpdates:0,updateRosterDataView(){ctx.rosterUpdates++},emitSocketWithAck:async event=>event.includes('date')?{ok:true,value:'new-date'}:{ok:true,entries:[{eventId:'1'}],members:[{discord_id:'2'}],roles:[{role_id:'3'}]}};
  vm.createContext(ctx);vm.runInContext(functions,ctx);return ctx;
 }
 test(`${path}: banking poll and Discord fetch update cache without full-layout redraw on any tab`,async()=>{
  for(const tab of ['settings','eso-members','discord-members','more']){
   const ctx=context(tab);await vm.runInContext('refreshBankingDataFromBackend({silent:true,background:true})',ctx);await vm.runInContext('refreshDiscordData({silent:true})',ctx);assert.equal(ctx.redraws,0,tab);assert.equal(ctx.bankingEntries[0].eventId,'1');assert.equal(ctx.discordMembers[0].discord_id,'2');assert.equal(ctx.discordDataLoading,false);
  }
 });
 test(`${path}: visible banking and Discord broadcasts use incremental updates`,async()=>{
  const ctx=context('more');ctx.payload={ok:true,entries:[{eventId:'new'}],members:[{discord_id:'new'}],roles:[],last_refresh:'date'};
  await vm.runInContext('handleBankingDataUpdated(payload)',ctx);ctx.activeGuildSyncTab='discord-members';await vm.runInContext('handleDiscordMemberDataUpdated(payload)',ctx);assert.equal(ctx.redraws,0);assert.equal(ctx.bankingEntries[0].eventId,'new');assert.equal(ctx.discordMembers[0].discord_id,'new');assert.equal(ctx.rosterUpdates,1,'role payload refreshes roster colors incrementally');
 });
 test(`${path}: failed background data requests restore loading flags without replacing an unrelated screen`,async()=>{
  const ctx=context();ctx.emitSocketWithAck=async()=>{throw Error('offline')};await vm.runInContext('refreshBankingDataFromBackend({silent:true})',ctx);await vm.runInContext('refreshDiscordData({silent:true})',ctx);assert.equal(ctx.redraws,0);assert.equal(ctx.bankingDataLoading,false);assert.equal(ctx.discordDataLoading,false);
 });
 test(`${path}: a selected raffle remains the bonus editing scope when its last purchase disappears`,async()=>{
  const ctx=context();ctx.selectedBonusRaffle='monthly:200';ctx.raffleBonusRaffles=[{type:'monthly',salesEnd:200,label:'Selected',enabled:true,tiers:[{hours:24,percent:0}]}];
  ctx.payload={ok:true,entries:[],bonusRaffles:[{type:'biweekly',salesEnd:100,label:'Other'}]};await vm.runInContext('handleBankingDataUpdated(payload)',ctx);
  assert.equal(ctx.raffleBonusRaffles.length,2);assert.equal(ctx.raffleBonusRaffles[1].salesEnd,200);assert.equal(ctx.selectedBonusRaffle,'monthly:200');
  ctx.selectedBonusRaffle='';await vm.runInContext('handleBankingDataUpdated(payload)',ctx);assert.equal(ctx.raffleBonusRaffles.length,1);
 });

}
