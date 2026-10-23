import test from 'node:test';
import assert from 'node:assert/strict';
import {registerDiscordGuildOrigin} from './discord-guild-origin.js';
test('live Discord role/member updates cannot cross the bot connection guild boundary', () => {
  let middleware;
  registerDiscordGuildOrigin({guildSyncAuthType: 'discord-bot', guildSyncBot: {guild_id: '100'}, use: fn => {middleware = fn;}});
  for (const event of ['guildsync:sending-discord-roles', 'guildsync:sending-discord-members', 'guildsync:discord-role-upsert', 'guildsync:discord-member-delete', 'guildsync:discord-member-last-seen']) {
    for (const guild of ['100', '200', undefined]) {
      let advanced = false, response;
      middleware([event, {guild_id: guild}, value => {response = value;}], () => {advanced = true;});
      assert.equal(advanced, guild === '100', event);
      if (guild !== '100') assert.equal(response.ok, false);
    }
  }
  let allowed = false;
  middleware(['guildsync:request-bot-configuration', {}], () => {allowed = true;});
  assert.equal(allowed, true);
});
test('desktop and legacy auto-detected bot connections retain their existing behavior', () => {
  registerDiscordGuildOrigin({guildSyncAuthType: 'GuildSync user', use() {throw Error('Must not restrict desktop uploads');}});
  let middleware;
  registerDiscordGuildOrigin({guildSyncAuthType: 'discord-bot', guildSyncBot: {}, use: fn => {middleware = fn;}});
  let allowed = false;
  middleware(['guildsync:sending-discord-roles', {guild_id: '100'}], () => {allowed = true;});
  assert.equal(allowed, true);
});
