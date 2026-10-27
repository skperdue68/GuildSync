import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requestActiveRaffles, formatRaffles } from '../raffle.js';
import { Log } from '../helper.js';
import { cleanupPublicRaffleSummaries } from '../public-raffle-cleanup.js';

export const data = new SlashCommandBuilder()
  .setName('raffle')
  .setDescription('Show the active bi-weekly and 50/50 raffle prizes and draw times.')
  .addBooleanOption(option => option.setName('public').setDescription('Show the response publicly instead of privately.'))
  .addBooleanOption(option => option.setName('tickets').setDescription('Show your current raffle purchases and ticket counts.'))
  .addStringOption(option => option.setName('verify').setDescription('Verify current tickets for an ESO account (Consigliere only).'))
  .setDMPermission(false);

export async function execute(interaction, guildSyncSocket, log = Log, { includeTickets = false } = {}) {
  const isPublic = interaction.options?.getBoolean?.('public') === true;
  const showTickets = includeTickets || interaction.options?.getBoolean?.('tickets') === true;
  const verifyName = interaction.options?.getString?.('verify')?.trim() || '';
  const verify = Boolean(verifyName);
  const flags = (isPublic && !showTickets && !verify) ? undefined : MessageFlags.Ephemeral;
  if (!interaction.guildId || (process.env.DISCORD_GUILD_ID && interaction.guildId !== process.env.DISCORD_GUILD_ID)) {
    await interaction.reply({ content: 'Use this command in the configured GuildSync server.', ...(flags ? { flags } : {}) });
    return;
  }
  if (verify) {
    if (/[\s]*@|https?:\/\/|www\.|<@|\]\(/i.test(verifyName)) {
      await interaction.reply({ content: 'Enter the ESO account name only, without @ signs, Discord mentions, or links.', flags: MessageFlags.Ephemeral });
      return;
    }
    const hasRole = interaction.member?.roles?.cache?.some(role => role.name === 'Consigliere');
    if (!hasRole) {
      await interaction.reply({ content: 'Only users with the exact Consigliere role can verify another account.', flags: MessageFlags.Ephemeral });
      return;
    }
  }
  await interaction.deferReply(flags ? { flags } : {});
  try {
    const lookup = { discordUserId: interaction.user?.id, includeTickets: showTickets || verify, esoAccountName: verifyName };
    if (lookup.includeTickets) log('Raffle tickets lookup: ' + JSON.stringify({ ...lookup, mode: verify ? 'verify' : 'linked account' }));
    const snapshot = await requestActiveRaffles(guildSyncSocket, lookup);
    if (lookup.includeTickets) log('Raffle tickets response: ' + JSON.stringify({ asOf: snapshot.asOf, tickets: snapshot.tickets }));
    const published = await interaction.editReply({ content: formatRaffles(snapshot, { includeTickets: showTickets || verify, verifyName, showTicketReminder: !showTickets && !verify }), allowedMentions: { parse: [] } });
    if (isPublic && !showTickets && !verify) {
      await cleanupPublicRaffleSummaries(interaction.channel, published, interaction.client?.user?.id, log);
    }
  } catch (error) {
    if (showTickets || verify) log('Raffle tickets lookup failed: ' + JSON.stringify({ discordUserId: interaction.user?.id, esoAccountName: verifyName, error: error.message }));
    await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
  }
}
