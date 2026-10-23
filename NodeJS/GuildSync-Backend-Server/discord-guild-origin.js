const guildWrites = new Set([
  'guildsync:sending-discord-roles', 'guildsync:sending-discord-members',
  'guildsync:discord-role-upsert', 'guildsync:discord-role-delete',
  'guildsync:discord-member-upsert', 'guildsync:discord-member-delete',
  'guildsync:discord-member-last-seen', 'guildsync:discord-historical-scan-complete'
]);

export function registerDiscordGuildOrigin(socket, log = () => {}) {
  if (socket.guildSyncAuthType !== 'discord-bot') return;
  socket.use((packet, next) => {
    if (!guildWrites.has(packet[0])) return next();
    const expected = String(socket.guildSyncBot?.guild_id || '').trim();
    // Legacy auto-detection has no handshake guild; multi-guild deployments must set DISCORD_GUILD_ID.
    if (!expected) return next();
    const received = String(packet[1]?.guild_id || '').trim();
    if (received === expected) return next();
    const message = `Discord update belongs to guild ${received || '(missing)'}, but this bot connection is configured for ${expected}. Nothing was processed.`;
    log(message);
    const callback = packet.at(-1);
    if (typeof callback === 'function') callback({ok: false, message});
  });
}
