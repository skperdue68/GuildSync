// Best-effort usage telemetry: never await delivery in Discord's response path.
// Component custom IDs and values are intentionally excluded (they can contain private data).
export function recordDiscordInteraction(socket, interaction, guildId) {
  try {
    if (!socket?.connected || !guildId || interaction.guildId !== guildId || interaction.user?.bot) return;
    const type = interaction.isChatInputCommand?.() ? 'slash' : interaction.isButton?.() ? 'button' : interaction.isAnySelectMenu?.() ? 'select' : interaction.isModalSubmit?.() ? 'modal' : null;
    if (!type) return;
    socket.emit('guildsync:record-discord-interaction', {
      interactionId: interaction.id, guildId: interaction.guildId,
      userId: interaction.user.id,
      displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
      type, name: type === 'slash' ? interaction.commandName : type
    });
  } catch {
    // A disconnected socket or malformed interaction must not affect command execution.
  }
}
