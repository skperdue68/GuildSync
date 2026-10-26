import { randomBytes } from 'node:crypto';

export function requestActiveRaffles(socket, options = {}) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('GuildSync is temporarily unavailable. Please try again.'));
    socket.timeout(15000).emit('guildsync:request-active-raffles', {
      discordUserId: options.discordUserId || '',
      includeTickets: options.includeTickets === true,
      esoAccountName: options.esoAccountName || ''
    }, (error, response) => {
      if (error) return reject(new Error('GuildSync did not respond. Please try again.'));
      if (!response?.ok || !Array.isArray(response.raffles) || response.raffles.length === 0) {
        return reject(new Error(response?.message || 'Raffle information is unavailable.'));
      }
      resolve(response);
    });
  });
}
export function formatRaffles(snapshot, { includeTickets = false, verifyName = '', showTicketReminder = false } = {}) {
  const number = value => Number(value || 0).toLocaleString('en-US');
  const latestTransaction = raffle => raffle.latestTransactionAt === null
    ? 'No transactions recorded for this raffle period.'
    : Number.isSafeInteger(raffle.latestTransactionAt) && raffle.latestTransactionAt > 0
      ? `Latest recorded transaction: <t:${raffle.latestTransactionAt}:f>.`
      : 'Latest recorded transaction: unavailable.';
  const reminders = [...(snapshot.reminders || [])].sort((a, b) => a.at - b.at);
  const grouped = new Map();
  for (const reminder of reminders) {
    const key = `${reminder.kind}:${reminder.at}:${reminder.percent || 0}:${reminder.nextPercent || 0}`;
    const group = grouped.get(key) || { ...reminder, types: [] };
    group.types.push(reminder.type);
    grouped.set(key, group);
  }
  const reminderLines = [...grouped.values()].map(reminder => {
    const labels = [...new Set(reminder.types)].map(type => type === 'biweekly' ? 'Bi-Weekly' : '50/50');
    const label = labels.length > 1 ? labels.join(' and ') : labels[0];
    const event = reminder.kind === 'sales' ? 'Ticket sales close' : reminder.nextPercent > 0
      ? `${number(reminder.percent)}% ticket bonus changes to ${number(reminder.nextPercent)}%`
      : `${number(reminder.percent)}% ticket bonus expires`;
    return `**${label} reminder:** ${event} at <t:${reminder.at}:F> (<t:${reminder.at}:R>).`;
  });
  return [...reminderLines, `As of <t:${snapshot.asOf}:f>. Based on the latest banking data received by GuildSync. Transaction times identify the latest entries recorded by GuildSync automation and may lag behind actual deposit data.`, '**GuildSync active raffle prizes**', ...snapshot.raffles.map(raffle => [
    `**${raffle.type === 'biweekly' ? 'Bi-Weekly' : '50/50'}: ${number(raffle.prizeGold)} gold available for the draw**`,
    ...(raffle.type === 'biweekly' ? [`${number(raffle.drawCount)} draws × 200,000 gold each (rounded up).`] : []),
    `Tickets: ${number(raffle.totalTickets)}${raffle.bonusEnabled ? ` (includes ${number(raffle.bonusTickets || 0)} bonus; ${number(raffle.bonusPercent || 0)}% bonus expires <t:${raffle.bonusExpiresAt}:R>${raffle.nextBonusPercent ? `, then ${number(raffle.nextBonusPercent)}% until <t:${raffle.nextBonusExpiresAt}:R>` : ''})` : ''} · Draw: <t:${raffle.drawTime}:F>`,
    raffle.salesOpen ? `Ticket sales close <t:${raffle.salesEnd}:R>.` : 'Sales closed — awaiting the draw.',
    latestTransaction(raffle)
  ].join('\n')), ...(includeTickets ? [formatUserTickets(snapshot, verifyName)] : []), ...(showTicketReminder && !includeTickets ? ['Not sure whether you have bought tickets? Use /tickets to view your purchases for the current raffles.'] : [])].join('\n\n');
}

export function parseReminderHours(value, fallback) {
  const hours = value === undefined ? fallback : Array.isArray(value) ? value : String(value).split(',').map(Number);
  if (!hours.length || !hours.every(hour => Number.isFinite(hour) && hour > 0 && Number.isFinite(hour * 3600))) {
    throw new Error('Raffle reminder hours must be comma-separated positive finite numbers.');
  }
  return [...new Set(hours)].sort((a, b) => b - a);
}

function formatUserTickets(snapshot, verifyName = '') {
  if (snapshot.tickets?.linked === false) return verifyName ? `No linked ESO account was found for **${verifyName}**.` : 'I could not determine your ESO name. Link your ESO account, or make your Discord name match your ESO account name.';
  if (!snapshot.tickets?.purchases?.length) return `No raffle tickets are recorded for your linked ESO account${snapshot.tickets?.esoAccountName ? ` (${snapshot.tickets.esoAccountName})` : ''}.`;
  const groups = new Map();
  for (const item of snapshot.tickets.purchases) {
    const type = item.raffleType || item.raffleLabel;
    const lines = groups.get(type) || [];
    lines.push(`${item.raffleLabel}: ${item.totalTickets} tickets (${item.purchasedTickets} purchased${item.bonusEnabled || item.bonusPercent > 0 || item.bonusTickets ? ` + ${item.bonusPercent || 0}% bonus: ${item.bonusTickets || 0} tickets` : ''}) — <t:${item.time}:f>`);
    groups.set(type, lines);
  }
  return `**${verifyName ? 'Verified' : 'Your'} tickets (${snapshot.tickets.esoAccountName})**\n` + [...groups.values()].map(lines => lines.join('\n')).join('\n\n');
}

export function createRaffleAnnouncer({ channelId, intervalHours, thresholds, fetchRaffles, send, loadState, saveState,
  bonusReminderHours = [1], salesCloseReminderHours = [2], announceOnPurchase = false,
  now = () => Math.floor(Date.now() / 1000) }) {
  bonusReminderHours = parseReminderHours(bonusReminderHours, [1]);
  salesCloseReminderHours = parseReminderHours(salesCloseReminderHours, [2]);
  if (!Number.isFinite(intervalHours) || intervalHours <= 0 ||
      !['biweekly', 'monthly'].every(type => Number.isSafeInteger(thresholds[type]) && thresholds[type] > 0)) {
    throw new Error('Raffle announcement interval and gold thresholds must be positive numbers.');
  }
  let running = false, state;
  async function deliverPending(reconcile) {
    const pending = state.pending;
    await send(pending.snapshot, { id: pending.id, createdAt: pending.createdAt, expiresAt: pending.expiresAt, channelId: state.channelId, content:pending.content, reconcile });
    await saveState(pending.next);
    state = pending.next;
  }
  return {
    async tick() {
      if (!channelId || running) return;
      running = true;
      try {
        if (state === undefined) state = await loadState() || { channelId, raffles: {} };
        // A restart or uncertain Discord response resumes the same persisted delivery.
        if (state.pending) {
          if (state.pending.expiresAt !== undefined && now() >= state.pending.expiresAt) {
            const { pending, ...remaining } = state;
            await saveState(remaining);
            state = remaining;
          } else {
            await deliverPending(true);
            // A purchase wake may refer to data newer than the recovered delivery.
            if (!announceOnPurchase) return;
          }
        }
        if (state.channelId !== channelId) state = { channelId, raffles: {} };
        const snapshot = await fetchRaffles();
        const time = now();
        const due = snapshot.raffles.some(raffle => {
          const previous = state.raffles[raffle.type];
          const milestone = Math.floor(raffle.prizeGold / thresholds[raffle.type]);
          return !previous || previous.id !== raffle.id || (announceOnPurchase
            ? typeof raffle.purchaseRevision === 'string' && previous.purchaseRevision !== raffle.purchaseRevision
            : time - previous.lastPostedAt >= intervalHours * 3600 || milestone > previous.highWater);
        });
        const reminders = [];
        for (const raffle of snapshot.raffles) {
          if (!raffle.salesOpen) continue;
          const events = [{ kind: 'sales', at: raffle.salesEnd, leads: salesCloseReminderHours }];
          if (raffle.bonusEnabled) events.push({ kind: 'bonus', at: raffle.bonusExpiresAt,
            percent: raffle.bonusPercent, nextPercent: raffle.nextBonusPercent || 0, leads: bonusReminderHours });
          for (const event of events) {
            if (!Number.isFinite(event.at) || time >= event.at) continue;
            for (const lead of event.leads) {
              const key = JSON.stringify([raffle.type, raffle.id, event.kind, event.at, lead]);
              if (time >= event.at - lead * 3600 && !state.reminders?.[key]) {
                reminders.push({ key, type: raffle.type, kind: event.kind, at: event.at,
                  percent: event.percent, nextPercent: event.nextPercent });
              }
            }
          }
        }
        // The 50/50 and bi-weekly sales cutoff is shared. If the 50/50
        // warning becomes due first, include both raffle names in that post.
        const monthlySales = reminders.find(item => item.kind === 'sales' && item.type === 'monthly');
        if (monthlySales) {
          for (let index = reminders.length - 1; index >= 0; index -= 1) {
            if (reminders[index].kind === 'sales' && reminders[index].type === 'biweekly') reminders.splice(index, 1);
          }
          reminders.push({ key: JSON.stringify(['biweekly', snapshot.raffles.find(item => item.type === 'biweekly')?.id, 'sales-combined', monthlySales.at]),
            type: 'biweekly', kind: 'sales', at: monthlySales.at });
        }
        if (!due && !reminders.length) return;
        // One combined update even if both raffles cross several thresholds.
        const next = { channelId, raffles: { ...state.raffles }, reminders: { ...state.reminders } };
        for (const reminder of reminders) next.reminders[reminder.key] = reminder.at;
        for (const [key, at] of Object.entries(next.reminders)) if (at <= time) delete next.reminders[key];
        for (const raffle of due ? snapshot.raffles : []) {
          const previous = state.raffles[raffle.type];
          next.raffles[raffle.type] = {
            id: raffle.id, lastPostedAt: time,
            highWater: Math.max(previous?.id === raffle.id ? previous.highWater : 0,
              Math.floor(raffle.prizeGold / thresholds[raffle.type])),
            ...(typeof raffle.purchaseRevision === 'string' ? {purchaseRevision:raffle.purchaseRevision} : {})
          };
        }
        // A deadline-only reminder also displays the current purchase snapshot.
        for (const raffle of snapshot.raffles) {
          if (next.raffles[raffle.type] && typeof raffle.purchaseRevision === 'string') {
            next.raffles[raffle.type] = {...next.raffles[raffle.type], purchaseRevision:raffle.purchaseRevision};
          }
        }
        const prepared = { ...state, pending: { id: randomBytes(12).toString('hex'), createdAt: time,
          ...(reminders.length ? { expiresAt: Math.min(...reminders.map(item => item.at)) } : {}),
          content:formatRaffles({ ...snapshot, ...(reminders.length ? { reminders } : {}) }, { showTicketReminder: true }),
          snapshot: { ...snapshot, ...(reminders.length ? { reminders } : {}) }, next } };
        await saveState(prepared);
        state = prepared;
        await deliverPending(false);
      } finally {
        running = false;
      }
    }
  };
}
