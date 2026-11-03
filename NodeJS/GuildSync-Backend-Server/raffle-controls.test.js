import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_BONUS_TIERS, parseBonusTiers } from './raffle-bonus.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const { getRaffleBonusSettings, saveRaffleBonusSettings, getRaffleBonusVersions,
  getBankingDataJSON, getBankingHistoryForAccount, getRaffleBonusChoices, saveRaffleBonusOverride, getRaffleUserTickets } = await import('./guildsync-database-actions.js');

function database(initial) {
  let saved = initial;
  const versions = [];
  const entries = [];
  const db = {
    versions, entries,
    async getConnection() { return db; },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, args = []) {
      if (sql.includes('guildsync_settings')) {
        if (/INSERT/.test(sql)) { saved = JSON.parse(args[1]); return [{}]; }
        return [saved ? [{ value: JSON.stringify(saved) }] : []];
      }
      if (sql.includes('guildsync_raffle_bonus_versions')) {
        if (/INSERT/.test(sql)) {
          versions.push({ raffle_type: args[0], effective_from: args[1], enabled: args[2], tiers_json: args[3] });
          return [{}];
        }
        return [versions];
      }
      if (sql.includes('guildsync_raffle_bonus_overrides')) return [[]];
      if (sql.includes('JSON_ARRAYAGG')) return [[{ banking_json: entries }]];
      if (sql.includes('guildsync_banking_entries')) return [entries.map(e => ({
        transaction_type: e.type, event_timestamp: e.time, ticket_quantity: e.ticketAmount, data_source: e.dataSource
      }))];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return db;
}
const tiers = Object.fromEntries(Object.entries(DEFAULT_BONUS_TIERS).map(([type, value]) => [type, parseBonusTiers(value)]));

test('ticket lookup returns each purchase bonus percentage and enabled state to the bot', async () => {
  const db = database({ enabled: true, ...tiers });
  const time = Date.parse('2026-09-15T12:00:00Z') / 1000;
  for (const type of ['biweekly', 'monthly']) {
    db.versions.push({ raffle_type: type, effective_from: 1, enabled: 1, tiers_json: JSON.stringify(tiers[type]) });
    db.entries.push({ type, time, ticketAmount: 100, dataSource: 'GuildBank', displayName: '@Member' });
  }
  const result = await getRaffleUserTickets(db, '123', time + 1, 'Member');
  assert.equal(result.purchases.length, 2);
  for (const item of result.purchases) {
    assert.equal(item.bonusEnabled, true);
    assert.ok(item.bonusPercent > 0);
    assert.equal(item.bonusTickets, item.bonusPercent);
    assert.equal(item.totalTickets, 100 + item.bonusTickets);
  }
});

test('legacy saved enable switch initializes both raffle types', async () => {
  for (const enabled of [true, false]) {
    const result = await getRaffleBonusSettings(database({ enabled, ...tiers }));
    assert.deepEqual(result.enabledByType, { biweekly: enabled, monthly: enabled });
  }
});

test('Save broadcasts recalculated raffle policies and entries to all attached clients', async () => {
  const db = database({ enabled: false, ...tiers });
  const now = Math.floor(Date.now() / 1000);
  for (const type of ['biweekly', 'monthly']) {
    db.versions.push({ raffle_type: type, effective_from: 1, enabled: 0, tiers_json: JSON.stringify(tiers[type]) });
    db.entries.push({ type, time: now, ticketAmount: 100, dataSource: 'GuildBank' });
  }
  const source = fs.readFileSync(new URL('./guildsync-backend-server.js', import.meta.url), 'utf8');
  const start = source.indexOf("  socket.on('guildsync:save-raffle-bonus-settings'");
  const handler = source.slice(start, source.indexOf("  socket.on('guildsync:checkout-deposit-mail'", start));
  const broadcast = source.slice(source.indexOf('async function broadcastBankingDataUpdate()'), source.indexOf('\nfunction emitDiscordRefreshStatus('));
  const clients = [[], []];
  let save;
  const ctx = vm.createContext({
    releaseExpiredDepositMailCheckouts:async()=>0,
    applicationDB: db, loginDB: { async execute() { return [[{ role: 'admin' }]]; } },
    getRaffleBonusSettings, saveRaffleBonusSettings, getRaffleBonusVersions, getRaffleBonusChoices,
    saveRaffleBonusOverride, getBankingDataJSON, getBankingDataDate: async () => ({}),
    Log() {}, sendSocketResponse: (_socket, _event, callback, payload) => callback(payload),
    socket: { guildSyncAuthenticated: true, guildSyncUser: { discord_user_id: 'admin' }, on(_event, callback) { save = callback; } },
    io: { to(room) {
      assert.equal(room, 'GuildSyncClient');
      return { emit(event, payload) {
        assert.equal(event, 'guildsync:banking-data-updated');
        for (const client of clients) client.push(payload);
      } };
    } }
  });
  vm.runInContext(broadcast + '\n' + handler, ctx);
  for (const enabledByType of [{ biweekly: true, monthly: false }, { biweekly: false, monthly: true }]) {
    let result;
    await save({ enabledByType, ...tiers }, response => { result = response; });
    assert.equal(result.ok, true);
    for (const client of clients) {
      const snapshot = client.at(-1);
      assert.deepEqual(snapshot.bonusSettings.enabledByType, enabledByType);
      for (const entry of snapshot.entries) {
        assert.equal(entry.bonusEnabled, enabledByType[entry.type]);
        if (!entry.bonusEnabled) assert.equal(entry.bonusTickets, 0);
      }
      for (const raffle of snapshot.bonusRaffles) assert.equal(raffle.enabled, enabledByType[raffle.type]);
    }
  }
  assert.equal(clients[0].length, 2);
  assert.equal(clients[1].length, 2);
});

test('saving enables each raffle independently and is effective in the immediate snapshot', async () => {
  const db = database({ enabled: false, ...tiers });
  for (const type of ['biweekly', 'monthly']) {
    db.versions.push({ raffle_type: type, effective_from: 1, enabled: 0, tiers_json: JSON.stringify(tiers[type]) });
  }
  for (const enabledByType of [{ biweekly: true, monthly: false }, { biweekly: false, monthly: true }]) {
    const saved = await saveRaffleBonusSettings(db, { enabledByType, ...tiers });
    assert.deepEqual(saved.enabledByType, enabledByType);
    assert.deepEqual((await getRaffleBonusSettings(db)).enabledByType, enabledByType);
    const versions = await getRaffleBonusVersions(db);
    for (const type of ['biweekly', 'monthly']) {
      const latest = versions.filter(v => v.type === type).at(-1);
      assert.equal(latest.enabled, enabledByType[type]);
      assert.ok(latest.effectiveFrom <= Math.floor(Date.now() / 1000), 'saved policy must be effective before broadcasting');
    }
  }
});

test('rejects bonus periods longer than the raffle window before saving', async () => {
  const db = database({ enabled: false, ...tiers });
  const invalid = { ...tiers, biweekly: [{ hours: 337, percent: 20 }, { hours: 1, percent: 0 }] };
  await assert.rejects(saveRaffleBonusSettings(db, { enabledByType: { biweekly: true, monthly: true }, ...invalid }), /only 336 hours long/);
  assert.equal(db.versions.length, 0);
});

test('manual tickets retain their entered count and receive no bonus in banking or history', async () => {
  const db = database({ enabled: true, ...tiers });
  for (const type of ['biweekly', 'monthly']) {
    db.versions.push({ raffle_type: type, effective_from: 1, enabled: 1, tiers_json: JSON.stringify(tiers[type]) });
    for (const source of ['ManualBiweeklyTicket', 'ManualMonthlyTicket', 'ManualMovedMonthlyTicket', 'ManualMovedBiweeklyTicket', 'ManualBiweeklyTicket (evainefaye)', 'ManualMonthlyTicket (evainefaye)']) {
      db.entries.push({ type, time: 1780000000, ticketAmount: 100, dataSource: source });
    }
  }
  for (const rows of [await getBankingDataJSON(db), await getBankingHistoryForAccount(db, '@member')]) {
    for (const row of rows) {
      assert.equal(row.bonusEnabled, true);
      assert.equal(row.bonusPercent, 0);
      assert.equal(row.bonusTickets, 0);
      assert.equal(row.totalTickets, 100);
    }
  }
});

