import {createHash} from 'node:crypto';

// Count metadata only; do not read message bodies, attachments, or reaction values.
function send(socket, guildId, user, displayName, type, identity, {log = console.warn} = {}) {
  if (!socket?.connected || !guildId || !user?.id || user.bot) return;
  const eventKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  try {
    const payload = {
      guildId, eventKey, userId: user.id,
      displayName: displayName || user.globalName || user.username || user.id, type
    };
    const acknowledge = response => {
      if (response?.ok === false) log(`Discord community activity could not be recorded: ${response.message || 'Backend rejected activity.'}`);
    };
    if (typeof socket.timeout === 'function') {
      socket.timeout(10000).emit('guildsync:record-discord-activity', payload, (error, response) => {
        if (error) log(`Discord community activity could not be recorded: ${error.message}`);
        else acknowledge(response);
      });
    } else {
      socket.emit('guildsync:record-discord-activity', payload, acknowledge);
    }
  } catch (error) {
    log(`Discord community activity could not be recorded: ${error.message}`);
  }
}

export function recordDiscordPost(socket, message, guildId, options) {
  if (!message?.id || message.guildId !== guildId || message.system) return;
  send(socket, guildId, message.author, message.member?.displayName, 'post', ['post', message.id], options);
}

export function recordDiscordReaction(socket, reaction, user, guildId, options) {
  const message = reaction?.message;
  const emoji = reaction?.emoji?.id || reaction?.emoji?.name;
  if (!message?.id || message.guildId !== guildId || !emoji) return;
  // One reaction per actor/message/emoji, even if Discord delivers it twice or it is re-added.
  send(socket, guildId, user, null, 'reaction', ['reaction', message.id, user?.id, emoji], options);
}
