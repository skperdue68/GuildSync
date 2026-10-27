import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRaffles, createRaffleAnnouncer } from './raffle.js';
import { execute } from './commands/raffle.js';

const reminder = 'Not sure whether you have bought tickets? Use /tickets to view your purchases for the current raffles.';
const snapshot = { ok: true, asOf: 1000, raffles: [{ id: 'b:1', type: 'biweekly', prizeGold: 200000 }] };

test('public formatter opts into the ticket reminder while private details stay clear', () => {
  assert.ok(formatRaffles(snapshot, { showTicketReminder: true }).endsWith(reminder));
  for (const options of [{}, { includeTickets: true, showTicketReminder: true }, { includeTickets: true, verifyName: 'Example', showTicketReminder: true }]) {
    assert.ok(!formatRaffles(snapshot, options).includes(reminder));
  }
});

test('scheduled raffle summaries persist the ticket reminder', async () => {
  let delivery;
  await createRaffleAnnouncer({ channelId: 'c', intervalHours: 48, thresholds: { biweekly: 200000, monthly: 500000 },
    now: () => 1000, loadState: async () => null, saveState: async () => {}, fetchRaffles: async () => snapshot,
    send: async (_snapshot, value) => { delivery = value; } }).tick();
  assert.ok(delivery.content.endsWith(reminder));
});

test('/raffle summaries include the reminder but ticket details and /tickets do not', async () => {
  for (const [isPublic, tickets, verify, includeTickets = false] of [[true, false, ''], [false, false, ''], [true, true, ''], [false, true, ''], [true, false, 'Example'], [false, false, 'Example'], [false, false, '', true]]) {
    let reply;
    const interaction = { guildId: process.env.DISCORD_GUILD_ID || 'guild', user: { id: 'user' },
      member: { roles: { cache: { some: fn => fn({ name: 'Consigliere' }) } } },
      options: { getBoolean: name => name === 'public' ? isPublic : tickets, getString: () => verify },
      deferReply: async () => {}, editReply: async value => { reply = value; } };
    const socket = { connected: true, timeout() { return this; }, emit(_event, _payload, callback) { callback(null, snapshot); } };
    await execute(interaction, socket, () => {}, { includeTickets });
    assert.equal(reply.content.includes(reminder), !tickets && !verify && !includeTickets);
  }
});
