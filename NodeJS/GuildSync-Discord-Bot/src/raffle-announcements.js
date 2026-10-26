import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRaffleAnnouncer, requestActiveRaffles, formatRaffles, parseReminderHours } from './raffle.js';
import { PermissionFlagsBits } from 'discord.js';
import { fileLinkButtons, fileLinkContent } from './file-link-buttons.js';
import { cleanupPublicRaffleSummaries } from './public-raffle-cleanup.js';

export async function sendRaffleAnnouncement(client, channelId, guildId, snapshot, delivery, log = console.warn) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.guildId || !channel.isTextBased() || typeof channel.send !== 'function' ||
      (guildId && channel.guildId !== guildId)) {
    throw new Error('GUILDSYNC_RAFFLE_CHANNEL_ID must be a writable text channel in the configured server.');
  }
  if (!channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new Error('Raffle announcements require Read Message History to reconcile interrupted deliveries.');
  }
  const content = delivery.content ?? formatRaffles(snapshot, { showTicketReminder: true });
  const renderedContent = fileLinkContent(content);
  const buttons = fileLinkButtons(content);
  const expectedUrls = buttons.flatMap(row => row.toJSON().components.map(button => button.url));
  const sameLinks = message => {
    const urls = (message.components || []).flatMap(row => (row.components || []).map(button => button.url || button.data?.url)).filter(Boolean);
    return urls.length === expectedUrls.length && urls.every((url,index) => url === expectedUrls[index]);
  };
  if (delivery.reconcile) {
    // Discord does not retain nonce on fetched messages. Compare the original
    // persisted content and bot author, excluding slash-command responses.
    let before;
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const accepted = messages.find(message => message.author.id === client.user.id && !message.interactionMetadata &&
          (message.content === content || (message.content === renderedContent && sameLinks(message))) && message.createdTimestamp >= (delivery.createdAt - 60) * 1000);
      if (accepted) {
        await cleanupPublicRaffleSummaries(channel, accepted, client.user.id, log);
        return;
      }
      const oldest = messages.last();
      if (!oldest || messages.size < 100 || oldest.createdTimestamp < (delivery.createdAt - 60) * 1000) break;
      if (oldest.id === before) throw new Error('Could not finish raffle delivery reconciliation.');
      before = oldest.id;
    }
  }
  // Channel/history lookups can outlive the warning window.
  if (delivery.expiresAt !== undefined && Date.now() >= delivery.expiresAt * 1000) return;
  const published = await channel.send({ content:renderedContent, components:buttons, allowedMentions: { parse: [] }, nonce: delivery.id, enforceNonce: true });
  await cleanupPublicRaffleSummaries(channel, published, client.user.id, log);
}

export function startRaffleAnnouncements(client, socket, log, env = process.env) {
  const channelId = String(env.GUILDSYNC_RAFFLE_CHANNEL_ID || '').trim();
  if (!channelId || String(env.GUILDSYNC_RAFFLE_ANNOUNCEMENTS_ENABLED || 'true').toLowerCase()==='false') return; // Announcements are opt-in; /raffle remains available.
  const botRoot = fileURLToPath(new URL('../', import.meta.url));
  const statePath = path.resolve(botRoot, env.GUILDSYNC_RAFFLE_STATE_FILE || 'data/raffle-announcements.json');
  let announcer;
  try {
    announcer = createRaffleAnnouncer({
      channelId,
      intervalHours: Number(env.GUILDSYNC_RAFFLE_INTERVAL_HOURS || 48),
      bonusReminderHours: parseReminderHours(env.GUILDSYNC_RAFFLE_BONUS_REMINDER_HOURS, [1]),
      salesCloseReminderHours: parseReminderHours(env.GUILDSYNC_RAFFLE_SALES_CLOSE_REMINDER_HOURS, [2]),
      thresholds: {
        biweekly: Number(env.GUILDSYNC_RAFFLE_BIWEEKLY_THRESHOLD || 200000),
        monthly: Number(env.GUILDSYNC_RAFFLE_MONTHLY_THRESHOLD || 500000)
      },
      fetchRaffles: () => requestActiveRaffles(socket),
      async loadState() {
        try {
          const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
          if (!state || typeof state.channelId !== 'string' || !state.raffles || typeof state.raffles !== 'object' ||
              !Object.values(state.raffles).every(item => item && typeof item.id === 'string' &&
                Number.isFinite(item.lastPostedAt) && Number.isFinite(item.highWater))) {
            throw new Error('Invalid raffle announcement state; restore or remove the state file.');
          }
          if (state.pending && (typeof state.pending.id !== 'string' || !Number.isFinite(state.pending.createdAt) ||
              !Array.isArray(state.pending.snapshot?.raffles) || !state.pending.next?.raffles)) {
            throw new Error('Invalid pending raffle delivery; restore the state file.');
          }
          return state;
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      },
      async saveState(state) {
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        await fs.writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), 'utf8');
        await fs.rename(`${statePath}.tmp`, statePath);
      },
      send: (snapshot, delivery) => sendRaffleAnnouncement(client, delivery.channelId || channelId, env.DISCORD_GUILD_ID, snapshot, delivery, log)
    });
  } catch (error) {
    log(`Raffle announcements disabled: ${error.message}`);
    return;
  }
  let running=false,stopped=false;const drain=[];
  const tick = async () => {
    if (stopped || running || !client.isReady() || !socket.connected) return;
    running=true;
    try { await announcer.tick(); } catch (error) { log(`Raffle announcement failed: ${error.message}`); }finally{running=false;for(const resolve of drain.splice(0))resolve();}
  };
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  socket.on('connect', tick);
  void tick();
  return async () => { stopped=true;clearInterval(timer); socket.off('connect', tick);if(running)await new Promise(resolve=>drain.push(resolve)); };
}
