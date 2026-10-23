import test from 'node:test';
import assert from 'node:assert/strict';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const actions = await import('./guildsync-database-actions.js');
test('full and incremental Discord role updates persist hierarchy positions', async () => {
  const writes = [];
  const connection = {async beginTransaction(){}, async commit(){}, release(){}, async execute(sql, args){writes.push({sql, args}); return [{affectedRows: 1}];}};
  const db = {async getConnection(){return connection;}, execute: connection.execute};
  await actions.upsertDiscordRoles(db, {roles: [{role_id: '101', role_name: 'Soldiers', role_color: 16776960, role_position: 5}]});
  await actions.upsertDiscordRole(db, {role_id: '101', role_name: 'Soldiers', role_color: 16776960, role_position: 8});
  const inserts = writes.filter(item => item.sql.includes('INSERT INTO discord_roles'));
  assert.equal(inserts.length, 2);
  for (let index = 0; index < inserts.length; index++) {
    assert.match(inserts[index].sql, /role_position/);
    assert.equal(inserts[index].args.at(-1), index === 0 ? 5 : 8);
  }
});
test('global and per-member role JSON includes Discord hierarchy position', async () => {
  const queries = [];
  const db = {async execute(sql) {queries.push(sql); return [[]];}};
  await actions.getDiscordRoleDataJSON(db);
  await actions.getDiscordMemberDataJSON(db);
  assert.ok(queries.every(sql => sql.includes('role_position')));
});
