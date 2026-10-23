import test from 'node:test';
import assert from 'node:assert/strict';
import {esoGuildConfiguration, initializeEsoGuildIdentity, validateEsoGuildImport} from './eso-guild-origin.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const actions = await import('./guildsync-database-actions.js');
const env = {GUILDSYNC_ESO_GUILD_ID: '761817'};
test('ESO guild isolation is explicitly configured and rejects malformed/conflicting IDs', () => {
  assert.equal(esoGuildConfiguration({}).strict, false);
  for (const id of ['@761817', 'Alphabet Mafia', '0', '-1']) assert.throws(() => esoGuildConfiguration({GUILDSYNC_ESO_GUILD_ID: id}), /numeric ESO guild ID/);
  assert.throws(() => esoGuildConfiguration({...env, GUILDSYNC_APPLICATIONS_GUILD_ID: '123'}), /same ESO guild/);
});
test('all banking/application records are validated, including conflicting aliases and missing guild IDs', () => {
  for (const kind of ['banking', 'applications']) {
    const key = kind === 'banking' ? 'entries' : 'records';
    assert.doesNotThrow(() => validateEsoGuildImport(kind, {[key]: [{guildId: 761817}, {guild_id: '761817'}]}, env));
    for (const invalid of [{guildId: '123'}, {}, {guildId: '761817', guild_id: '123'}]) {
      assert.throws(() => validateEsoGuildImport(kind, {[key]: [{guildId: '761817'}, invalid]}, env));
    }
  }
});
test('roster snapshots and every event must match, including mixed payloads and embedded member metadata', () => {
  const snapshot = {guildId: '761817', guildListMembers: {Alice: {accountName: 'Alice'}}};
  assert.doesNotThrow(() => validateEsoGuildImport('roster', {data: {guildList: snapshot, rosterEvents: {one: {guildId: '761817'}}}}, env));
  for (const data of [
    {guildList: {...snapshot, guildId: '123'}}, {guildList: {guildListMembers: {}}},
    {guildList: snapshot, rosterEvents: {one: {guildId: '123'}}},
    {guildList: {...snapshot, guildListMembers: {Alice: {guildId: '123'}}}},
    {rosterEvents: {one: {guildId: '761817'}, two: {}}}
  ]) assert.throws(() => validateEsoGuildImport('roster', {data}, env));
  // Root metadata cannot be used to relabel old unidentified events.
  assert.throws(() => validateEsoGuildImport('roster', {guildId: '761817', rosterEvents: {old: {eventId: 1}}}, env));
});
test('legacy mode leaves existing untagged single-guild imports compatible', () => {
  assert.doesNotThrow(() => validateEsoGuildImport('banking', {entries: [{eventId: 1}]}, {}));
});

test('browser-upload Lua parsers preserve guild IDs on exports, snapshots and individual records', () => {
  const banking = actions.parseGuildSyncBankingSavedVarsLua(`GuildSyncBanking = { ["Default"] = { ["@Example"] = { ["$AccountWide"] = {
    ["guildId"] = "761817", ["guildName"] = "Example Guild",
    ["biweekly"] = { [1] = { ["guildId"] = "761817", ["guildName"] = "Example Guild", ["eventId"] = 1 } }, ["monthly"] = {}, ["other"] = {}
  } } } }`);
  assert.equal(banking.guildId, '761817');
  assert.equal(banking.entries[0].guildId, '761817');
  assert.doesNotThrow(() => validateEsoGuildImport('banking', banking, env));
  const roster = actions.parseGuildSyncRosterSavedVarsLua(`GuildSyncRoster = { ["Default"] = { ["@Example"] = { ["$AccountWide"] = {
    ["guildId"] = "761817", ["guildName"] = "Example Guild",
    ["guildList"] = { ["guildId"] = "761817", ["guildListMembers"] = {} },
    ["rosterEvents"] = { ["event_1"] = { ["guildId"] = "761817", ["eventId"] = 1 } }
  } } } }`);
  assert.equal(roster.guildId, '761817');
  assert.equal(roster.guildList.guildId, '761817');
  assert.equal(roster.rosterEvents.event_1.guildId, '761817');
  assert.doesNotThrow(() => validateEsoGuildImport('roster', roster, env));
});
test('database binding is created once and cannot be changed or disabled', async () => {
  let identity;
  const db = {async execute(sql, args) {
    if (sql.startsWith('SELECT')) return [identity ? [{value: identity}] : []];
    assert.equal(args[0], 'eso_guild_id'); identity ||= args[1]; return [{}];
  }};
  await initializeEsoGuildIdentity(db, env);
  await initializeEsoGuildIdentity(db, env);
  assert.equal(identity, '761817');
  await assert.rejects(initializeEsoGuildIdentity(db, {GUILDSYNC_ESO_GUILD_ID: '123'}), /Database belongs to ESO guild/);
  await assert.rejects(initializeEsoGuildIdentity(db, {}), /cannot be changed or disabled/);
});

test('database processing rejects a mixed guild batch before taking a connection or writing', async () => {
  const previous = process.env.GUILDSYNC_ESO_GUILD_ID;
  process.env.GUILDSYNC_ESO_GUILD_ID = env.GUILDSYNC_ESO_GUILD_ID;
  let touched = false;
  const db = {async getConnection() {touched = true; throw Error('DB must not be touched');}, async execute() {touched = true; throw Error('DB must not be touched');}};
  try {
    await assert.rejects(actions.insertBankingEntries(db, {entries: [{guildId: '761817'}, {guildId: '123'}]}), {code: 'ESO_GUILD_ORIGIN'});
    await assert.rejects(actions.processRosterData(db, {data: {guildList: {guildId: '123', guildListMembers: {}}}}), {code: 'ESO_GUILD_ORIGIN'});
    await assert.rejects(actions.recordGuildSyncApplications(db, [{guildId: '761817'}, {guildId: '123'}]), {code: 'ESO_GUILD_ORIGIN'});
    assert.equal(touched, false);
  } finally {
    if (previous === undefined) delete process.env.GUILDSYNC_ESO_GUILD_ID; else process.env.GUILDSYNC_ESO_GUILD_ID = previous;
  }
});
