import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const desktop = '../../GO/GuildSync-Frontend-Client/frontend/src/main.js';
const web = './web/src/main.js';
function context(path, running = false) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const names = ['getBankingMailAttentionCount', 'shouldShowBankingMailTabAttention', 'getUnsentDepositMailCount', 'updateBankingDataView', 'handleBankingDataUpdated', 'refreshESORunningStatus'];
  const functions = names.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0] || '').join('\n');
  const tab = {innerHTML: 'stale'};
  const ctx = {desktopSupport:{blocked:false},desktopVersionAccepted:true,
    bankingEntries: [{eventId:'1',type:'biweekly',mailStatus:'unsent'}],
    esoRunningStatus: {running},
    activeGuildSyncTab:'settings', canEditGuildSyncData:()=>true,
    getPendingDepositMailWriteCount:()=>3, getWrittenDepositMailWaitingCount:()=>2,
    normalizeBankingEntries:entries=>entries, applyBankingBonusData(){}, markBankingLastRefreshNow(){},
    updateBonusSettingsView(){}, updateLiveDataView(){}, renderBankDepositsPanel(){},
    document:{querySelector:selector=>selector==='.guildsync-tabs'?tab:null},
    wireGuildSyncTabs(){}, addSystemMessage(){}, TRANSIENT_MESSAGE_TTL_MS:100,
    GetESORunningStatus:async()=>({running:ctx.nextRunning}),
    flushPendingDepositMailAckCleanup:async()=>{}, processPendingDepositMailBatches:async()=>{},
    formatError:String
  };
  vm.createContext(ctx); vm.runInContext(functions,ctx);
  ctx.renderGuildSyncTabs=()=>ctx.shouldShowBankingMailTabAttention('more',false)?'blink':'quiet';
  return {ctx,tab};
}
test('unclaimed mail keeps blinking before and after ESO starts',()=>{
  const {ctx}=context(desktop);
  assert.equal(ctx.getBankingMailAttentionCount(),1);
  assert.equal(ctx.shouldShowBankingMailTabAttention('more',false),true);
  ctx.esoRunningStatus.running=true;
  assert.equal(ctx.shouldShowBankingMailTabAttention('more',false),true);
});
test('local pending writes and ready-to-send records do not blink after checkout',()=>{
  const {ctx}=context(desktop);ctx.bankingEntries[0].mailStatus='checked_out';
  assert.equal(ctx.getBankingMailAttentionCount(),0);
  ctx.bankingEntries[0].mailStatus='written_to_eso';
  assert.equal(ctx.shouldShowBankingMailTabAttention('more',false),false);
});
test('web attention shows only unclaimed mail',()=>{
  const {ctx}=context(web);assert.equal(ctx.shouldShowBankingMailTabAttention('more',false),true);
  ctx.bankingEntries[0].mailStatus='checked_out';
  assert.equal(ctx.shouldShowBankingMailTabAttention('more',false),false);
});
test('checkout broadcast clears tab attention for every connected desktop and web client on other tabs',async()=>{
  const clients=[context(desktop),context(desktop),context(web)];
  for(const {ctx,tab} of clients){ctx.updateBankingDataView();assert.equal(tab.innerHTML,'blink');}
  const payload={ok:true,entries:[{eventId:'1',type:'biweekly',mailStatus:'checked_out'}]};
  for(const {ctx,tab} of clients){await ctx.handleBankingDataUpdated(payload);assert.equal(tab.innerHTML,'quiet');}
});
test('remaining unsent records still notify after a partial checkout',async()=>{
  const {ctx,tab}=context(desktop);
  await ctx.handleBankingDataUpdated({ok:true,entries:[
    {eventId:'1',type:'biweekly',mailStatus:'checked_out'},
    {eventId:'2',type:'monthly',mailStatus:'unsent'},
    {eventId:'3',type:'other',mailStatus:'unsent'}
  ]});
  assert.equal(tab.innerHTML,'blink');assert.equal(ctx.getBankingMailAttentionCount(),1);
});
test('attention stays off for viewers, the active banking tab, and other tabs',()=>{
  const {ctx}=context(desktop);
  assert.equal(ctx.shouldShowBankingMailTabAttention('more',true),false);
  assert.equal(ctx.shouldShowBankingMailTabAttention('settings',false),false);
  ctx.canEditGuildSyncData=()=>false;
  assert.equal(ctx.shouldShowBankingMailTabAttention('more',false),false);
});
