import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const path of ['../../GO/GuildSync-Frontend-Client/frontend/src/main.js', './web/src/main.js']) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const names = ['normalizeBankingEntries', 'renderBankDepositRow', 'getBankingExportTsv', 'formatTsvCell', 'isBankingRaffleBonusEnabled', 'renderRaffleBonusSettings', 'wireReportsPanel', 'wireRaffleBonusSettings'];
  const functions = names.map(name => source.match(new RegExp(`function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0] || '').join('\n');
  function context() {
    return vm.createContext({
      escapeHtml: String, escapeAttribute: String, formatTicketAmount: String, formatGoldAmount: String,
      formatBankingTimestamp: String, getBankingTotalDepositAmount: e => e.amount,
      bankingExportSection: 'biweekly', bankingActiveSection: 'biweekly',
      bankingEntries: [], raffleBonusRaffles: [{ type: 'biweekly', salesEnd: 200, enabled: true }],
      getBankingRaffleWindow: () => ({ salesEnd: 200 }), selectedBonusRaffle: '',
      raffleBonusSettings: { enabledByType: { biweekly: true, monthly: false }, biweekly: [{ hours: 24, percent: 0 }], monthly: [{ hours: 24, percent: 0 }] },
      guildSyncSession: { user: { role: 'admin' } }, raffleBonusDraft: null,bonusResetToDefaults:false,
      canEditGuildSyncData:()=>true,
      reportsAccordion:{},wireReportAccordions(){},adminConfigurationPanel:{wire(){}},communityStatisticsPanel:{wire(){}},renderGuildSyncTabLayout(){}
    });
  }
  test(`${path}: percentage survives normalization and bonus columns follow raffle policy`, () => {
    const ctx = context();
    vm.runInContext(functions, ctx);
    vm.runInContext(`entry = normalizeBankingEntries([{ type: 'biweekly', ticketAmount: 100, bonusPercent: 20, bonusTickets: 20, totalTickets: 120, bonusEnabled: true }])[0]`, ctx);
    assert.equal(ctx.entry.bonusPercent, 20);
    assert.equal(vm.runInContext('isBankingRaffleBonusEnabled("biweekly")', ctx), true);
    assert.match(vm.runInContext('renderBankDepositRow(entry, true, true)', ctx), /20%/);
    assert.doesNotMatch(vm.runInContext('renderBankDepositRow(entry, true, false)', ctx), /20%/);
    assert.match(vm.runInContext('getBankingExportTsv([entry])', ctx), /Bonus %\tBonus Tickets/);
    ctx.raffleBonusRaffles[0].enabled = false;
    assert.equal(vm.runInContext('isBankingRaffleBonusEnabled("biweekly")', ctx), false);
    assert.doesNotMatch(vm.runInContext('getBankingExportTsv([entry])', ctx), /Bonus/);
  });
  test(`${path}: viewers can see bank entries and bonus values without Move controls`,()=>{
    const ctx=context();ctx.canEditGuildSyncData=()=>false;vm.runInContext(functions,ctx);
    const html=vm.runInContext('renderBankDepositRow({displayName:"Viewer test",amount:1000,purchasedTickets:10,bonusPercent:20,bonusTickets:2,totalTickets:12},true,true)',ctx);
    assert.match(html,/Viewer test|20%/);assert.doesNotMatch(html,/data-bank-entry-move/);
    ctx.guildSyncSession.user.role='viewer';assert.doesNotMatch(vm.runInContext('renderRaffleBonusSettings()',ctx),/Save Bonus Settings|id="resetBonusDefaults"/);
  });
  test(`${path}: settings render independent switches without applying edits`, () => {
    const ctx = context();
    vm.runInContext(functions, ctx);
    const html = vm.runInContext('renderRaffleBonusSettings()', ctx);
    assert.match(html, /name="biweekly-enabled"[^>]*checked/);
    assert.match(html, /name="monthly-enabled"/);
    assert.doesNotMatch(html, /name="monthly-enabled"[^>]*checked/);
    assert.match(html, /Save Bonus Settings/);
  });
  test(`${path}: users can inspect raffle bonus policies but cannot edit or save them`, () => {
    const ctx = context();ctx.guildSyncSession.user.role = 'user';vm.runInContext(functions, ctx);
    const html = vm.runInContext('renderRaffleBonusSettings()', ctx);
    assert.match(html, /<select id="bonusRafflePicker">/);assert.match(html, /<fieldset class="raffle-bonus-tiers" disabled>/);
    assert.match(html, /Admin access is required to change these settings/);assert.doesNotMatch(html, /id="resetBonusDefaults"|Save Bonus Settings/);
  });
  test(`${path}: dropdown marks enabled bonuses and removes the marker when disabled`, () => {
    const ctx = context();
    ctx.raffleBonusRaffles[0].label = 'Bi-Weekly | Raffle 09/26/26';
    ctx.raffleBonusRaffles[0].overridden = true;
    vm.runInContext(functions, ctx);
    assert.match(vm.runInContext('renderRaffleBonusSettings()', ctx), /Bi-Weekly \| Raffle 09\/26\/26 \(Bonuses\)/);
    ctx.raffleBonusRaffles[0].enabled = false;
    const html = vm.runInContext('renderRaffleBonusSettings()', ctx);
    assert.doesNotMatch(html, /\((?:custom|bonuses|completed)\)/i);
  });
  test(`${path}: unsaved switches and tier values survive a background rerender`, () => {
    const ctx = context();
    const listeners = {};
    Object.assign(ctx, {
      activeGuildSyncTab: 'settings', saveRaffleBonusSettings() {},
      FormData: class { constructor(form) { return form; } },
      document: { querySelector: selector => selector === '#raffleBonusSettingsForm'
        ? { addEventListener: (event, handler) => { listeners[event] = handler; } } : null }
    });
    vm.runInContext(functions, ctx);
    vm.runInContext('wireReportsPanel()', ctx);
    const form = new Map([['monthly-enabled', 'on'], ['biweekly-0-hours', '48'], ['biweekly-0-percent', '0'], ['monthly-0-hours', '24'], ['monthly-0-percent', '0']]);
    listeners.input?.({ currentTarget: form });
    const html = vm.runInContext('renderRaffleBonusSettings()', ctx);
    assert.doesNotMatch(html, /name="biweekly-enabled"[^>]*checked/);
    assert.match(html, /name="monthly-enabled"[^>]*checked/);
    assert.match(html, /name="biweekly-0-hours"[^>]*value="48"/);
    // Persisted settings remain untouched until Save.
    assert.equal(ctx.raffleBonusSettings.enabledByType.biweekly, true);
    assert.equal(ctx.raffleBonusSettings.enabledByType.monthly, false);
  });
  test(`${path}: only submitting Save sends switches and tiers; an override targets one raffle`, async () => {
    const ctx = context();
    const sent = [];
    Object.assign(ctx, {
      FormData: class { constructor(form) { return form; } },
      emitSocketWithAck: async (event, payload) => { sent.push({ event, payload }); return { ok: true, bonusSettings: ctx.raffleBonusSettings }; },
      refreshBankingDataFromBackend: async () => {}, addSystemMessage() {}, renderGuildSyncTabLayout() {},
      TRANSIENT_MESSAGE_TTL_MS: 100, formatError: String
    });
    vm.runInContext(functions + '\n' + source.match(/async function saveRaffleBonusSettings\([^]*?(?=\n(?:async )?function )/)[0], ctx);
    const form = new Map([['biweekly-enabled', 'on'], ['biweekly-0-hours', '24'], ['biweekly-0-percent', '0'], ['monthly-0-hours', '24'], ['monthly-0-percent', '0']]);
    assert.equal(sent.length, 0);
    ctx.event = { preventDefault() {}, currentTarget: form };
    await vm.runInContext('saveRaffleBonusSettings(event)', ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.enabledByType.biweekly, true);
    assert.equal(sent[0].payload.enabledByType.monthly, false);
    ctx.selectedBonusRaffle = 'biweekly:200';
    ctx.raffleBonusRaffles[0].tiers = [{ hours: 24, percent: 0 }];
    form.delete('biweekly-enabled');
    await vm.runInContext('saveRaffleBonusSettings(event)', ctx);
    assert.equal(sent[1].payload.raffleType, 'biweekly');
    assert.equal(sent[1].payload.salesEnd, 200);
    assert.equal(sent[1].payload.enabled, false);
    assert.equal(sent[1].payload.enabledByType, undefined);
  });
  test(`${path}: Return to defaults previews all bonus settings and Save resets the selected scope`,async()=>{
    const ctx=context(),sent=[],listeners={};
    ctx.raffleBonusSettings.envDefaults={enabledByType:{biweekly:false,monthly:true},biweekly:[{hours:120,percent:20},{hours:24,percent:0}],monthly:[{hours:168,percent:40},{hours:24,percent:0}]};
    Object.assign(ctx,{activeGuildSyncTab:'settings',document:{querySelector:selector=>selector==='#resetBonusDefaults'?{addEventListener:(_,fn)=>listeners.reset=fn}:null},FormData:class{constructor(form){return form}},emitSocketWithAck:async(event,payload)=>{sent.push(payload);return {ok:true,bonusSettings:ctx.raffleBonusSettings}},refreshBankingDataFromBackend:async()=>{},addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:100,formatError:String});
    vm.runInContext(functions+'\n'+source.match(/async function saveRaffleBonusSettings\([^]*?(?=\n(?:async )?function )/)[0],ctx);
    assert.match(vm.runInContext('renderRaffleBonusSettings()',ctx),/id="resetBonusDefaults">Return to defaults<\/button>/);
    vm.runInContext('wireReportsPanel()',ctx);listeners.reset();
    let html=vm.runInContext('renderRaffleBonusSettings()',ctx);
    assert.doesNotMatch(html,/name="biweekly-enabled"[^>]*checked/);assert.match(html,/name="monthly-enabled"[^>]*checked/);
    assert.match(html,/name="biweekly-0-hours"[^>]*value="120"/);assert.match(html,/name="biweekly-0-percent"[^>]*value="20"/);
    assert.equal(sent.length,0);assert.equal(ctx.raffleBonusSettings.biweekly[0].hours,24);
    ctx.event={preventDefault(){},currentTarget:new Map()};await vm.runInContext('saveRaffleBonusSettings(event)',ctx);assert.equal(sent[0].resetToDefaults,true);assert.equal(sent[0].raffleType,undefined);
    ctx.selectedBonusRaffle='biweekly:200';ctx.raffleBonusRaffles[0].tiers=[{hours:48,percent:0}];ctx.raffleBonusRaffles[0].inheritedSettings={enabled:false,tiers:[{hours:72,percent:10},{hours:24,percent:0}]};
    listeners.reset();html=vm.runInContext('renderRaffleBonusSettings()',ctx);assert.match(html,/name="biweekly-0-hours"[^>]*value="72"/);assert.match(html,/name="biweekly-0-percent"[^>]*value="10"/);assert.doesNotMatch(html,/name="biweekly-enabled"[^>]*checked/);
    await vm.runInContext('saveRaffleBonusSettings(event)',ctx);assert.equal(sent[1].resetToDefaults,true);assert.equal(sent[1].raffleType,'biweekly');assert.equal(sent[1].salesEnd,200);
  });

}
