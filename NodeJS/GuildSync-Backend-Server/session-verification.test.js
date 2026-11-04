import {createUserSwitches} from './user-switch.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import {createRoleViews,roleViewSessionKey} from './role-view.js';

test('persistent sessions use current approval and role, and disconnect when revoked', async () => {
  // Exercise the real verifier without starting the server or opening production databases.
  const source = readFileSync(new URL('./guildsync-backend-server.js', import.meta.url), 'utf8');
  const verifier = source.slice(source.indexOf('async function verifyGuildSyncSession('), source.indexOf('\nfunction getBearerToken('));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE guildsync_login_sessions (session_id TEXT, discord_user_id TEXT);
      CREATE TABLE guildsync_users (discord_user_id TEXT, allowed INTEGER, role TEXT, requested_at TEXT, username TEXT, global_name TEXT, guild_member_name TEXT, avatar TEXT, revoked_at TEXT);
      INSERT INTO guildsync_login_sessions VALUES ('session-1', 'user-1');
      INSERT INTO guildsync_users (discord_user_id,allowed,role,requested_at) VALUES ('user-1', 1, 'user', '2020-01-01T00:00:00.000Z');
    `);
    let disconnected = false;
    const socket = { guildSyncSessionId: 'session-1', disconnect() { disconnected = true; } };
    const secret = 'test-only-secret';
    const loginDB={ async execute(sql, params) { return [db.prepare(sql).all(...params)]; } },roleViews=createRoleViews(loginDB);
    const verify = vm.runInNewContext(`${verifier}\nverifyGuildSyncSession`, {
      jwt, GUILDSYNC_JWT_SECRET: secret,
      loginDB,roleViews,roleViewSessionKey,userSwitches:createUserSwitches(loginDB),
      io: { sockets: { sockets: new Map([['socket-1', socket]]) } }
    });
    const token = jwt.sign({ sub: 'user-1', jti: 'session-1', role: 'admin' }, secret,
      { issuer: 'guildsync-auth-server', audience: 'guildsync-desktop' });
    const legacyToken = jwt.sign({ sub: 'user-1', role: 'admin' }, secret, { issuer: 'guildsync-auth-server', audience: 'guildsync-desktop' });
    assert.equal((await verify(legacyToken)).role, 'user');
    assert.equal((await verify(token)).role, 'user');
    db.exec("UPDATE guildsync_users SET role = 'admin'");
    await roleViews.set('user-1','session-1','viewer');
    const preview=await verify(token);assert.equal(preview.actual_role,'admin');assert.equal(preview.role,'viewer');
    roleViews.clear('session-1');assert.equal((await verify(token)).role,'admin');
    db.exec("UPDATE guildsync_users SET role = 'user'");
    assert.equal(disconnected, false);
    db.exec('UPDATE guildsync_users SET allowed = 0');
    await assert.rejects(verify(token), /Session was logged out/);
    assert.equal(disconnected, true);
    db.exec('DELETE FROM guildsync_users');
    await assert.rejects(verify(legacyToken), /Session was logged out/);
    db.prepare('INSERT INTO guildsync_users (discord_user_id,allowed,role,requested_at) VALUES (?, 1, ?, ?)').run('user-1','user',new Date((jwt.decode(legacyToken).iat * 1000) + 1).toISOString());
    await assert.rejects(verify(legacyToken), /Session was logged out/);
  } finally {
    db.close();
  }
});
