import {hasRaffleAdminRole} from '../raffle-permissions.js';
import { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { Log } from '../helper.js';
import { fileLinkButtons, fileLinkContent } from '../file-link-buttons.js';

export function createGsaCommandData(env = process.env) {
  return new SlashCommandBuilder().setName('gsa').setDescription('GuildSync administration').setDMPermission(false)
    .addSubcommand(sub => sub.setName('post').setDescription('Post saved GuildSync application record(s) to Discord')
      .addStringOption(option => option.setName('name').setDescription('Full or partial ESO account name from GuildSyncApplications').setRequired(true)))
    .addSubcommand(sub => sub.setName('stop').setDescription('Stop automatic GuildSync application posts to Discord'))
    .addSubcommand(sub => sub.setName('start').setDescription('Resume automatic GuildSync application posts to Discord'));
}

export function createGsrCommandData() {
  return new SlashCommandBuilder().setName('gsraffle').setDescription('GuildSync raffle administration').setDMPermission(false)
      .addSubcommand(sub => sub.setName('load').setDescription('Load current data to the working sheet or selected data to its archive.')
        .addStringOption(option => option.setName('date').setDescription('MMDDYY, MM/DD/YY or MM-DD-YY; omitted uses current. Unpadded dates ask for confirmation.')))
      .addSubcommand(sub => sub.setName('reset').setDescription('Clear both raffle sheets and draw dates; database records remain intact.'))
      .addSubcommand(sub => sub.setName('archive').setDescription('Archive now, reset both raffle sheets and reload current data.'))
      .addSubcommand(sub => sub.setName('update').setDescription('Update database winners and other result fields from the archived sheet.')
        .addStringOption(option => option.setName('date').setDescription('MMDDYY, MM/DD/YY or MM-DD-YY within the raffle. Unpadded dates ask for confirmation.').setRequired(true)));
}

export function createGsrAliasCommandData() { return createGsrCommandData().setName('gsr'); }
export function createGsrAliasCommand() { return { data: createGsrAliasCommandData(), execute }; }

export function createGsrCommand() { return { data: createGsrCommandData(), execute }; }

function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('GuildSync is temporarily unavailable.'));
    socket.timeout(180000).emit(event, payload, (error, response) => {
      if (error) return reject(new Error('The raffle operation timed out. Check the backend log before retrying; it may still finish.'));
      if (!response?.ok) return reject(new Error(response?.message || 'GuildSync could not complete the raffle operation.'));
      resolve(response);
    });
  });
}

function selectionMessage(selection) {
  const date = timestamp => new Intl.DateTimeFormat('en-US', { timeZone: selection.timeZone,
    month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(timestamp * 1000));
  return `Looking up raffle periods containing ${date(selection.lookupAt)}...\n\n` +
    selection.raffles.map(raffle => `**${raffle.label} raffle:**\n${date(raffle.start)} – ${date(raffle.end)}`).join('\n\n');
}

export async function execute(interaction, socket, log = Log) {
  const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!interaction.guildId || (process.env.DISCORD_GUILD_ID && interaction.guildId !== process.env.DISCORD_GUILD_ID)) return reply('Use this command in the configured GuildSync server.');
  if (!hasRaffleAdminRole(interaction.member?.roles?.cache)) return reply('An authorized raffle administrator role is required to use these raffle commands.');
  const action = interaction.options.getSubcommand();
  if (!['load', 'reset', 'archive', 'update'].includes(action)) return reply('That command has been retired. Use /gsraffle load, reset, archive, or update.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const requestedBy = String(interaction.member?.displayName || '').trim();
    if (!requestedBy) throw new Error('Discord display name is unavailable; operation was not started.');
    const payload = { discordUserId: interaction.user.id, requestedBy };
    let content;
    if (action === 'load' || action === 'update') {
      payload.date = interaction.options.getString('date') ?? undefined;
      if (action === 'update' && !payload.date) throw Error('Update requires a raffle date in MMDDYY format.');
      let plan = await request(socket, 'guildsync:raffle-refresh', { ...payload, action: 'plan' });
      const normalized = plan.selection.dateNormalization;
      if (normalized?.requiresConfirmation) {
        const dateLabel = new Intl.DateTimeFormat('en-US', {timeZone:plan.selection.timeZone,month:'long',day:'numeric',year:'numeric'}).format(new Date(plan.selection.lookupAt*1000));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('confirm-date').setLabel('Confirm date').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('cancel-date').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        const message = await interaction.editReply({content:`I interpreted your date as **${dateLabel} (${normalized.value}, MMDDYY)**. Confirm this date before I ${action} the raffle data.`,components:[row],allowedMentions:{parse:[]}});
        let answer;
        try { answer = await message.awaitMessageComponent({componentType:ComponentType.Button,time:60000,filter:choice=>choice.user.id===interaction.user.id}); }
        catch { await interaction.editReply({content:`${action === 'update' ? 'Update' : 'Load'} cancelled: the date was not confirmed. No raffle data was changed.`,components:[],allowedMentions:{parse:[]}}); return; }
        await answer.deferUpdate();
        if (answer.customId !== 'confirm-date') {
          await interaction.editReply({content:`${action === 'update' ? 'Update' : 'Load'} cancelled. No raffle data was changed.`,components:[],allowedMentions:{parse:[]}}); return;
        }
      }
      if (normalized) payload.date = normalized.value;
      if (plan.selection.boundaryTypes?.length) {
        payload.boundaryChoices = {};
        for (const type of plan.selection.boundaryTypes.filter(type => type === 'biweekly')) {
          const label = type === 'biweekly' ? 'Bi-Weekly' : '50/50';
          const dateLabel = new Intl.DateTimeFormat('en-US', {timeZone:plan.selection.timeZone,month:'long',day:'numeric',year:'numeric'}).format(new Date(plan.selection.lookupAt*1000));
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('starts').setLabel('Starts on this date').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ends').setLabel('Ends on this date').setStyle(ButtonStyle.Secondary));
          const message = await interaction.editReply({content:`For the ${label} raffle on ${dateLabel}, ${action} the raffle that starts or ends on this date?`,components:[row],allowedMentions:{parse:[]}});
          let answer;
          try { answer = await message.awaitMessageComponent({componentType:ComponentType.Button,time:60000,filter:choice=>choice.user.id===interaction.user.id}); }
          catch { await interaction.editReply({content:`${action === 'update' ? 'Update' : 'Load'} cancelled: no boundary selection was received. No raffle data was changed.`,components:[],allowedMentions:{parse:[]}}); return; }
          payload.boundaryChoices[type] = answer.customId;
          await answer.deferUpdate();
        }
        plan = await request(socket,'guildsync:raffle-refresh',{...payload,action:'plan'});
      }
      const biweekly = plan.selection.raffles.find(raffle => raffle.type === 'biweekly');
      const parts = biweekly && new Intl.DateTimeFormat('en-US', {timeZone:plan.selection.timeZone,year:'2-digit',month:'2-digit',day:'2-digit'}).formatToParts(new Date(biweekly.end * 1000));
      const datePart = type => parts?.find(part => part.type === type)?.value;
      const expectedName = parts ? datePart('year') + datePart('month') + datePart('day') + ' Raffle' : undefined;
      const lookupMessage = payload.date && expectedName ? "\n\nChecking for archive '" + expectedName + "' in the archive folder if this is a historical raffle..." : '';
      await interaction.editReply({ components: [], content: selectionMessage(plan.selection) + lookupMessage + (action === 'update' ? '\n\nUpdating the database with editable result fields from the selected archive...' : '\n\nExporting the selected raffle data to its matching spreadsheet...'), allowedMentions: { parse: [] } });
      log('Raffle file lookup request: ' + JSON.stringify({action,expectedName,date:payload.date || 'current',boundaryChoices:payload.boundaryChoices || {},discordUserId:payload.discordUserId}));
      const result = await request(socket, 'guildsync:raffle-refresh', { ...payload, action: action === 'update' ? 'update' : 'export' });
      log('Raffle file lookup result: ' + JSON.stringify({action,date:payload.date || 'current',historical:result.historical===true,
        archiveLookup:result.archiveLookup || null,sheetUrl:result.sheetUrl || result.workingSheetUrl}));
      const lookup = result.archiveLookup;
      if (lookup) log('Raffle archive search results: ' + JSON.stringify({expectedName:lookup.expectedName,archiveFolderId:lookup.archiveFolderId,matches:lookup.matches || [],created:lookup.created,selectedFileId:lookup.archiveId}));
      const selectedUrl = result.sheetUrl || result.workingSheetUrl;
      const selectedId = lookup?.archiveId || /\/spreadsheets\/d\/([^/]+)/.exec(selectedUrl || '')?.[1];
      log((action === 'update' ? 'Raffle database update completed from sheet: ' : 'Raffle data loaded to sheet: ') + JSON.stringify({fileName:lookup?.fileName || lookup?.expectedName || 'Working Raffle Sheet',fileId:selectedId,date:payload.date || 'current'}));
      if (action === 'update') {
        content = selectionMessage(result.selection) + '\n\nUpdated ' + result.saved + ' result fields in the database from the archived raffle sheet [HERE](' + result.sheetUrl + '). No spreadsheet data was cleared.';
      } else {
        content = selectionMessage(result.selection) + '\n\nLoad complete: ' + result.synced + ' entries written. Both worksheets were cleared and reloaded.';
        if (result.historical) content += '\n\nRaffle data has been loaded to the archived raffle sheet [HERE](' + result.sheetUrl + ').\nAfter updating winners, attendance, bonus tickets, or other result fields, use `/gsr update date:' + payload.date + '` to save those changes to the database.';
        else if (result.workingSheetUrl) content += '\n\nRaffle data has been loaded to the working sheet [HERE](' + result.workingSheetUrl + ').';
      }
      if(result.archiveLookup?.expectedName) content += '\n\n' + (result.archiveLookup.created ? 'Created' : 'Found') + " archive '" + result.archiveLookup.expectedName + "' in the archive folder.";
      if(result.historical) content += '\n\n50/50 results are shared with other Bi-Weekly archives for the same 50/50 raffle. This archive’s captured results are the latest saved snapshot.';
    } else {
      await interaction.editReply({ content: action === 'archive' ? 'Archiving Current Public Raffle Sheet' : 'Clearing both raffle sheets and draw dates...', allowedMentions: { parse: [] } });
      const result = await request(socket, 'guildsync:raffle-manage', { ...payload, action: action === 'reset' ? 'clear' : action });
      content = result.message;
    }
    await interaction.editReply({ content:fileLinkContent(content), components:fileLinkButtons(content), allowedMentions: { parse: [] } });
  } catch (error) { log('Raffle ' + action + ' failed: ' + error.message); await interaction.editReply({ content: error.message, components: [], allowedMentions: { parse: [] } }); }
}
