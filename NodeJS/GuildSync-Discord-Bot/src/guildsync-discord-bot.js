import {recordDiscordInteraction} from './interaction-statistics.js';
import {createLiveConfiguration} from './live-configuration.js';
import {createOnboardingWorker} from './member-onboarding.js';
import {readOnboardingConfig} from './member-onboarding-config.js';
import {createVoiceMuteWorker,readVoiceMuteConfig} from './voice-mute.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';
import { Log } from './helper.js';
import {
  getDiscordHistoricalScanStatus,
  markDiscordHistoricalScanComplete,
  sendDiscordMemberDelete,
  sendDiscordMemberLastSeen,
  sendDiscordMemberUpsert,
  sendDiscordRoleDelete,
  sendDiscordRoleUpsert,
  syncDiscordRolesAndMembers
} from './discord-sync.js';

import {
  Client,
  Collection,
  Events,
  ChannelType,
  GatewayIntentBits,
  MessageFlags,
  Partials
} from 'discord.js';

import * as roles from './commands/roles.js';
import * as raffle from './commands/raffle.js';
import * as tickets from './commands/tickets.js';
import * as gsaRaffle from './commands/gsa-raffle.js';
import { startArchiveAnnouncements } from './archive-announcements.js';
import { startRaffleAnnouncements } from './raffle-announcements.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '../.env')
});

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  GUILDSYNC_SOCKET_URL,
  GUILDSYNC_BOT_KEY,
  GUILDSYNC_HISTORICAL_SCAN_ON_STARTUP,
  GUILDSYNC_HISTORICAL_SCAN_MESSAGE_LIMIT_PER_CHANNEL,
  ESO_GUILD_APPLICATIONS
} = process.env;

if (!DISCORD_TOKEN) {
  Log('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

if (!GUILDSYNC_SOCKET_URL) {
  Log('Missing GUILDSYNC_SOCKET_URL in .env');
  process.exit(1);
}

if (!GUILDSYNC_BOT_KEY) {
  Log('Missing GUILDSYNC_BOT_KEY in .env');
  process.exit(1);
}

const guildSyncSocket = io(GUILDSYNC_SOCKET_URL, {
  auth: {
    source: 'discord-bot',
    guildId: DISCORD_GUILD_ID,
    botKey: GUILDSYNC_BOT_KEY
  },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 10000
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ]
});

client.commands = new Collection();
const liveConfiguration=createLiveConfiguration({start:async env=>{
  const stops=[];
  const config=readOnboardingConfig(env);
  const worker=createOnboardingWorker({client,socket:guildSyncSocket,guildId:DISCORD_GUILD_ID,config,log:Log});
  stops.push(()=>worker.stop());
  const voiceWorker=createVoiceMuteWorker({client,socket:guildSyncSocket,guildId:DISCORD_GUILD_ID,config:readVoiceMuteConfig(env),log:Log});
  stops.push(()=>voiceWorker.stop());
  if(client.isReady()&&guildSyncSocket.connected)void worker.tick();
  if(client.isReady()){
    const raffleStop=startRaffleAnnouncements(client,guildSyncSocket,Log,env);
    const archiveStop=startArchiveAnnouncements(client,guildSyncSocket,Log,env);
    if(raffleStop)stops.push(raffleStop);if(archiveStop)stops.push(archiveStop);
  }
  Log('Operational configuration applied; member onboarding '+(config.enabled?'enabled':'disabled')+'.');
  return stops;
}});
async function refreshOperationalConfiguration(force=false){
  const connectionId=guildSyncSocket.id;
  try {
    const configuration=await new Promise((resolve,reject)=>guildSyncSocket.timeout(30000).emit('guildsync:request-bot-configuration',{},(error,response)=>error?reject(error):response?.ok?resolve(response.configuration):reject(Error(response?.message || 'Configuration request failed.'))));
    const reported=await new Promise((resolve,reject)=>guildSyncSocket.timeout(30000).emit('guildsync:register-configuration-defaults',{defaults:liveConfiguration.defaults(configuration.keys)},(error,response)=>error?reject(error):response?.ok?resolve(response.configuration):reject(Error(response?.message || 'Configuration defaults report failed.'))));
    if(!guildSyncSocket.connected || guildSyncSocket.id!==connectionId)return;
    await liveConfiguration.apply(reported,{force,resume:true});
  }catch(error){Log('Operational configuration refresh failed: '+error.message);}
}
guildSyncSocket.on('guildsync:configuration-updated',configuration=>void liveConfiguration.apply(configuration).catch(error=>Log('Operational configuration update failed: '+error.message)));
guildSyncSocket.on('connect',()=>void refreshOperationalConfiguration());
guildSyncSocket.on('disconnect',()=>void liveConfiguration.pause().catch(error=>Log('Configuration workers could not pause: '+error.message)));

let guildSyncApplicationDiscordPostingEnabled = true;

const gsaCommand = {
  data: gsaRaffle.createGsaCommandData(),
  async execute(interaction, guildSyncSocket) {
    if (interaction.options.getSubcommandGroup(false)) {
      return interaction.reply({ content: 'Raffle commands moved to /gsraffle. Use /gsraffle load, reset, or archive.', flags: MessageFlags.Ephemeral });
    }
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'stop') {
      guildSyncApplicationDiscordPostingEnabled = false;

      await interaction.reply({
        content: 'GuildSync application posting to Discord is now stopped.',
        flags: [MessageFlags.Ephemeral]
      });

      Log(`GuildSync application Discord posting stopped by ${interaction.user.tag}.`);
      return;
    }

    if (subcommand === 'start') {
      guildSyncApplicationDiscordPostingEnabled = true;

      await interaction.reply({
        content: 'GuildSync application posting to Discord is now started.',
        flags: [MessageFlags.Ephemeral]
      });

      Log(`GuildSync application Discord posting started by ${interaction.user.tag}.`);
      return;
    }

    const name = interaction.options.getString('name', true).trim();

    await interaction.deferReply({
      flags: [MessageFlags.Ephemeral]
    });

    try {
      const result = await emitGuildSyncWithAck(
        guildSyncSocket,
        'guildsync:gsa-post-application',
        {
          name,
          applicant_account: name,
          requested_by: interaction.user.id,
          requested_by_name: interaction.user.tag
        },
        45000
      );

      if (!result?.ok) {
        await interaction.editReply(result?.message || `No GuildSync application record was posted for ${name}.`);
        return;
      }

      await interaction.editReply(result.message || `Posted GuildSync application record(s) matching ${name}.`);
    } catch (error) {
      await interaction.editReply(error.message || 'Failed to post GuildSync application record.');
    }
  }
};

const commands = [
  roles,
  raffle,
  tickets,
  gsaRaffle.createGsrCommand(),
  gsaRaffle.createGsrAliasCommand(),
  gsaCommand
];

for (const command of commands) {
  client.commands.set(command.data.name, command);
}

let startupSyncDone = false;
let startupSyncRunning = false;
let requestedSyncRunning = false;
let historicalScanRunning = false;

guildSyncSocket.on('connect', async () => {
  Log(`Connected to GuildSync websocket as ${guildSyncSocket.id}`);

  guildSyncSocket.emit('discord-bot-online', {
    botName: 'GuildSync Discord Bot',
    connectedAt: new Date().toISOString()
  });

  await runStartupSyncIfReady('websocket connected');
});

guildSyncSocket.on('disconnect', reason => {
  Log(`Disconnected from GuildSync websocket: ${reason}`);
});

guildSyncSocket.on('connect_error', error => {
  Log(`GuildSync websocket connection error: ${error.message}`);
});

guildSyncSocket.on('guildsync:request-discord-sync', async (payload = {}, callback) => {
  const respond = typeof callback === 'function'
    ? callback
    : () => { };

  if (requestedSyncRunning || startupSyncRunning) {
    respond({
      ok: false,
      message: 'A Discord role/member sync is already running.'
    });
    return;
  }

  if (!client.isReady()) {
    respond({
      ok: false,
      message: 'Discord client is not ready yet.'
    });
    return;
  }

  if (!guildSyncSocket.connected) {
    respond({
      ok: false,
      message: 'GuildSync websocket is not connected.'
    });
    return;
  }

  requestedSyncRunning = true;

  try {
    Log(
      `Manual Discord sync requested by GuildSync backend. Requested by: ${payload.requested_by_name || payload.requested_by || 'unknown'}`
    );

    const guild = await getStartupGuild(client);
    const result = await syncDiscordRolesAndMembers(guild, guildSyncSocket);

    respond({
      ok: true,
      message: 'Discord role/member sync completed.',
      roles_processed: result.roles_processed,
      members_processed: result.members_processed,
      members_removed: result.members_removed
    });
  } catch (error) {
    Log(`Manual Discord sync failed: ${error.message}`);

    respond({
      ok: false,
      message: error.message || 'Discord role/member sync failed.'
    });
  } finally {
    requestedSyncRunning = false;
  }
});

guildSyncSocket.on('guildsync:eso-guild-application-message', async (payload = {}, callback) => {
  const respond = typeof callback === 'function' ? callback : () => { };

  try {
    if (!client.isReady()) {
      throw new Error('Discord client is not ready yet.');
    }

    const message = String(payload.message || '').trim();

    if (!message) {
      throw new Error('No message was provided.');
    }

    if (!guildSyncApplicationDiscordPostingEnabled) {
      Log('ESO guild application Discord post skipped because /gsa stop is active.');

      respond({
        ok: false,
        stopped: true,
        message: 'GuildSync application posting to Discord is currently stopped.'
      });
      return;
    }

    await sendEsoGuildApplicationMessage(message);

    respond({
      ok: true,
      message: 'ESO guild application message posted to Discord.'
    });
  } catch (error) {
    Log(`ESO guild application Discord post failed: ${error.message}`);

    respond({
      ok: false,
      message: error.message
    });
  }
});

client.once(Events.ClientReady, async readyClient => {
  Log(`GuildSync bot logged in as ${readyClient.user.tag}`);
  if(guildSyncSocket.connected)await refreshOperationalConfiguration(true);

  await runStartupSyncIfReady('Discord bot ready');
});

client.on(Events.InteractionCreate, async interaction => {
  recordDiscordInteraction(guildSyncSocket, interaction, DISCORD_GUILD_ID);
  if (!interaction.isChatInputCommand()) {
    return;
  }

  await recordGuildMemberActivity(interaction.member, `slash_command:${interaction.commandName}`);

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    await interaction.reply({
      content: 'Unknown command.',
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    await command.execute(interaction, guildSyncSocket);
  } catch (error) {
    Log(`Error running /${interaction.commandName}: ${error.message}`);

    const message = {
      content: 'There was an error running that command.',
      flags: [MessageFlags.Ephemeral]
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message);
    } else {
      await interaction.reply(message);
    }
  }
});


client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author?.bot) {
    return;
  }

  await recordGuildMemberActivity(message.member, 'message_create');
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user?.bot) {
    return;
  }

  try {
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }

    const guild = reaction.message?.guild;

    if (!guild) {
      return;
    }

    const member = await guild.members.fetch(user.id).catch(() => null);

    await recordGuildMemberActivity(member, 'reaction_add');
  } catch (error) {
    Log(`Discord reaction activity tracking failed: ${error.message}`);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;

  if (!member || member.user?.bot) {
    return;
  }

  let action = 'voice_state_update';

  if (!oldState.channelId && newState.channelId) {
    action = 'voice_join';
  } else if (oldState.channelId && !newState.channelId) {
    action = 'voice_leave';
  } else if (oldState.channelId !== newState.channelId) {
    action = 'voice_move';
  } else if (oldState.selfMute !== newState.selfMute || oldState.serverMute !== newState.serverMute) {
    action = 'voice_mute_change';
  } else if (oldState.selfDeaf !== newState.selfDeaf || oldState.serverDeaf !== newState.serverDeaf) {
    action = 'voice_deaf_change';
  }

  await recordGuildMemberActivity(member, action);
});


client.on(Events.GuildMemberAdd, async member => {
  await handleDiscordLiveUpdate(
    `Discord member joined: ${member.user.tag} (${member.user.id})`,
    async () => await sendDiscordMemberUpsert(member, guildSyncSocket)
  );
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  await handleDiscordLiveUpdate(
    `Discord member updated: ${newMember.user.tag} (${newMember.user.id})`,
    async () => await sendDiscordMemberUpsert(newMember, guildSyncSocket)
  );
});

client.on(Events.GuildMemberRemove, async member => {
  await handleDiscordLiveUpdate(
    `Discord member left: ${member.user.tag} (${member.user.id})`,
    async () => await sendDiscordMemberDelete(member, guildSyncSocket)
  );
});


client.on(Events.UserUpdate, async (oldUser, newUser) => {
  await handleDiscordLiveUpdate(
    `Discord user updated: ${newUser.tag} (${newUser.id})`,
    async () => {
      const guild = await getStartupGuild(client);
      const member = await guild.members.fetch(newUser.id).catch(() => null);

      if (!member) {
        Log(`Discord user updated but is not in sync guild: ${newUser.tag} (${newUser.id})`);
        return null;
      }

      return await sendDiscordMemberUpsert(member, guildSyncSocket);
    }
  );
});

client.on(Events.GuildRoleCreate, async role => {
  await handleDiscordLiveUpdate(
    `Discord role created: ${role.name} (${role.id})`,
    async () => await sendDiscordRoleUpsert(role, guildSyncSocket)
  );
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  await handleDiscordLiveUpdate(
    `Discord role updated: ${newRole.name} (${newRole.id})`,
    async () => await sendDiscordRoleUpsert(newRole, guildSyncSocket)
  );
});

client.on(Events.GuildRoleDelete, async role => {
  await handleDiscordLiveUpdate(
    `Discord role deleted: ${role.name} (${role.id})`,
    async () => await sendDiscordRoleDelete(role, guildSyncSocket)
  );
});


async function handleDiscordLiveUpdate(description, action) {
  if (!client.isReady()) {
    Log(`${description} skipped: Discord client is not ready yet.`);
    return;
  }

  if (!guildSyncSocket.connected) {
    Log(`${description} skipped: GuildSync websocket is not connected.`);
    return;
  }

  try {
    Log(description);

    const result = await action();

    if (result?.ok === false) {
      throw new Error(result.message || 'GuildSync rejected Discord live update.');
    }

    Log(`${description} sent to GuildSync.`);
  } catch (error) {
    Log(`${description} failed: ${error.message}`);
  }
}


function emitGuildSyncWithAck(socket, eventName, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('GuildSync websocket is not connected.'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error(`${eventName} did not respond within ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.emit(eventName, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function getUnixTimestampSeconds(dateValue = Date.now()) {
  return Math.floor(new Date(dateValue).getTime() / 1000).toString();
}

async function recordGuildMemberActivity(member, action) {
  if (!member || member.user?.bot) {
    return;
  }

  if (!guildSyncSocket.connected) {
    Log(`Discord activity skipped for ${member.user?.tag || member.user?.id || 'unknown'}: GuildSync websocket is not connected.`);
    return;
  }

  try {
    const result = await sendDiscordMemberLastSeen(guildSyncSocket, {
      guild_id: member.guild.id,
      discord_id: member.user.id,
      username: member.user.username,
      timestamp: getUnixTimestampSeconds(),
      action
    });

    if (result?.ok === false) {
      throw new Error(result.message || 'GuildSync rejected Discord last-seen activity.');
    }
  } catch (error) {
    Log(`Discord activity update failed for ${member.user?.tag || member.user?.id || 'unknown'}: ${error.message}`);
  }
}

async function runHistoricalScanOnceIfEnabled(guild) {
  const enabled = String(GUILDSYNC_HISTORICAL_SCAN_ON_STARTUP || '').toLowerCase() === 'true';

  if (!enabled || historicalScanRunning) {
    return;
  }

  historicalScanRunning = true;

  try {
    Log('Discord historical scan startup option is enabled. Checking backend completion status...');

    const status = await getDiscordHistoricalScanStatus(guildSyncSocket);

    Log(
      `Discord historical scan status received from backend: completed=${status?.completed ? 'yes' : 'no'}, completed_at=${status?.completed_at || 'not set'}.`
    );

    if (!status?.ok) {
      throw new Error(status?.message || 'GuildSync could not provide historical scan status.');
    }

    if (!status.should_run) {
      Log(`Discord historical scan skipped: last scan completed at ${status.completed_at || 'unknown time'}. Next allowed at ${status.next_allowed_at || 'unknown time'}.`);
      return;
    }

    Log(`Discord historical scan is starting for ${guild.name} (${guild.id}).`);

    const result = await scanHistoricalGuildMessages(guild);

    Log(
      `Discord historical scan finished locally. Telling backend to mark complete. Messages checked: ${result.message_count}. Members updated: ${result.member_count}.`
    );

    const completeResult = await markDiscordHistoricalScanComplete(guildSyncSocket, result);

    if (!completeResult?.ok) {
      throw new Error(completeResult?.message || 'GuildSync rejected historical scan completion.');
    }

    Log(
      `Discord historical scan completed. Messages checked: ${result.message_count}. Members updated: ${result.member_count}.`
    );
  } catch (error) {
    Log(`Discord historical scan failed: ${error.message}`);
  } finally {
    historicalScanRunning = false;
  }
}

async function scanHistoricalGuildMessages(guild) {
  const limitPerChannel = Math.max(
    1,
    Number(GUILDSYNC_HISTORICAL_SCAN_MESSAGE_LIMIT_PER_CHANNEL || 1000)
  );

  const channels = await guild.channels.fetch();
  const latestByUserID = new Map();
  let messageCount = 0;
  let scannedChannelCount = 0;
  let skippedChannelCount = 0;

  Log(
    `Historical scan found ${channels.size} channel(s). Message scan limit is ${limitPerChannel} message(s) per text/announcement channel.`
  );

  for (const channel of channels.values()) {
    if (!channel || !channel.isTextBased?.() || !channel.messages?.fetch) {
      skippedChannelCount += 1;
      continue;
    }

    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      skippedChannelCount += 1;
      continue;
    }

    scannedChannelCount += 1;
    Log(`Historical scan reading #${channel.name || channel.id} (${channel.id}).`);

    let before;
    let fetchedForChannel = 0;

    while (fetchedForChannel < limitPerChannel) {
      const limit = Math.min(100, limitPerChannel - fetchedForChannel);
      const messages = await channel.messages.fetch({
        limit,
        ...(before ? { before } : {})
      }).catch((error) => {
        Log(`Historical scan skipped #${channel.name || channel.id}: ${error.message}`);
        return null;
      });

      if (!messages || messages.size === 0) {
        Log(`Historical scan #${channel.name || channel.id}: no more messages returned.`);
        break;
      }

      Log(
        `Historical scan #${channel.name || channel.id}: fetched ${messages.size} message(s); channel total so far ${fetchedForChannel + messages.size}/${limitPerChannel}.`
      );

      for (const message of messages.values()) {
        if (!message.guild || message.author?.bot) {
          continue;
        }

        messageCount += 1;
        fetchedForChannel += 1;

        const current = latestByUserID.get(message.author.id);

        if (!current || message.createdTimestamp > current.createdTimestamp) {
          latestByUserID.set(message.author.id, {
            discord_id: message.author.id,
            username: message.author.username,
            timestamp: getUnixTimestampSeconds(message.createdTimestamp),
            action: 'historical_message_scan',
            source: 'historical_scan',
            createdTimestamp: message.createdTimestamp
          });
        }
      }

      before = messages.last()?.id;

      if (messages.size < limit) {
        break;
      }
    }

    Log(
      `Historical scan finished #${channel.name || channel.id}: checked ${fetchedForChannel} qualifying non-bot message(s).`
    );
  }

  Log(
    `Historical scan message collection complete. Scanned channels: ${scannedChannelCount}. Skipped channels: ${skippedChannelCount}. Qualifying messages: ${messageCount}. Unique active members found: ${latestByUserID.size}.`
  );

  let memberCount = 0;

  for (const activity of latestByUserID.values()) {
    Log(
      `Historical scan sending last-seen update for ${activity.username} (${activity.discord_id}) at ${activity.timestamp} from ${activity.action}.`
    );

    const result = await sendDiscordMemberLastSeen(guildSyncSocket, {...activity, guild_id: guild.id});

    if (result?.ok === false) {
      Log(`Historical scan could not update ${activity.username}: ${result.message || 'unknown error'}`);
      continue;
    }

    if ((result?.updated || 0) > 0) {
      memberCount += 1;
      Log(`Historical scan backend updated ${activity.username} (${activity.discord_id}).`);
    } else {
      Log(`Historical scan backend received ${activity.username} (${activity.discord_id}) but did not update a row.`);
    }
  }

  Log(`Historical scan update send complete. Backend updated ${memberCount}/${latestByUserID.size} member(s).`);

  return {
    guild_id: guild.id,
    message_count: messageCount,
    member_count: memberCount
  };
}


async function runStartupSyncIfReady(reason) {
  if (startupSyncDone) {
    return;
  }

  if (startupSyncRunning || requestedSyncRunning) {
    return;
  }

  if (!client.isReady()) {
    Log(`Startup sync waiting: Discord client is not ready yet. Trigger: ${reason}`);
    return;
  }

  if (!guildSyncSocket.connected) {
    Log(`Startup sync waiting: GuildSync websocket is not connected yet. Trigger: ${reason}`);
    return;
  }

  startupSyncRunning = true;

  try {
    Log(`Starting automatic Discord role/member sync. Trigger: ${reason}`);

    const guild = await getStartupGuild(client);

    const result = await syncDiscordRolesAndMembers(guild, guildSyncSocket);

    startupSyncDone = true;

    Log(
      `Automatic startup sync completed. Roles: ${result.roles_processed}, Members: ${result.members_processed}, Removed: ${result.members_removed}`
    );

    await runHistoricalScanOnceIfEnabled(guild);
  } catch (error) {
    Log(`Automatic startup sync failed: ${error.message}`);
  } finally {
    startupSyncRunning = false;
  }
}

function getEsoGuildApplicationsDestination() {
  const [guildId, threadId] = ESO_GUILD_APPLICATIONS
    .split(':')
    .map(value => value.trim());

  return { guildId, threadId };
}

async function sendEsoGuildApplicationMessage(message) {
  const { guildId, threadId } = getEsoGuildApplicationsDestination();

  const guild = await client.guilds.fetch(guildId);
  const thread = await guild.channels.fetch(threadId);

  if (!thread || !thread.isThread()) {
    throw new Error(`ESO_GUILD_APPLICATIONS target ${threadId} is not a thread.`);
  }

  return await thread.send(message);
}

async function getStartupGuild(discordClient) {
  if (DISCORD_GUILD_ID) {
    Log(`Using DISCORD_GUILD_ID from .env: ${DISCORD_GUILD_ID}`);

    return await discordClient.guilds.fetch(DISCORD_GUILD_ID);
  }

  Log('DISCORD_GUILD_ID not set. Trying to auto-detect Discord server...');

  const guilds = await discordClient.guilds.fetch();

  if (guilds.size === 0) {
    throw new Error('Discord bot is not in any servers.');
  }

  if (guilds.size > 1) {
    const guildList = [...guilds.values()]
      .map((guild) => `${guild.name} (${guild.id})`)
      .join(', ');

    throw new Error(
      `Discord bot is in ${guilds.size} servers. Set DISCORD_GUILD_ID in .env so I know which one to sync. Servers found: ${guildList}`
    );
  }

  const guildSummary = guilds.first();

  Log(`Auto-detected Discord server: ${guildSummary.name} (${guildSummary.id})`);

  return await discordClient.guilds.fetch(guildSummary.id);
}

try {
  Log('Starting Discord bot. GuildSync websocket will keep retrying if unavailable.');

  await client.login(DISCORD_TOKEN);
} catch (error) {
  Log(`Discord bot failed to start: ${error.message}`);
  process.exit(1);
}
