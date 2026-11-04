import { SlashCommandBuilder } from 'discord.js';
import { execute as executeRaffle } from './raffle.js';

export const data = new SlashCommandBuilder()
  .setName('tickets')
  .setDescription('Show your current raffle purchases and ticket counts.')
  .addStringOption(option => option.setName('verify').setDescription('Verify an ESO account name (raffle administrators only).'))
  .setDMPermission(false);

export async function execute(interaction, socket, log) {
  return executeRaffle(interaction, socket, log, { includeTickets: true });
}
