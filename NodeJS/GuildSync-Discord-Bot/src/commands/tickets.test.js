import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { data, execute } from './tickets.js';
import { execute as raffle } from './raffle.js';

function fixture({ verify = '', role = 'Consigliere', legacy = false } = {}) {
 const replies = [], logs = [], requests = [];
 const interaction = {
  guildId: process.env.DISCORD_GUILD_ID || 'test', user: { id: '123' },
  member: { roles: { cache: [ { name: role } ] } },
  options: { getBoolean: name => legacy && name === 'tickets', getString: () => verify },
  async reply(value) { replies.push(value); }, async deferReply(value) { replies.push(value); }, async editReply(value) { replies.push(value); }
 };
 const socket = { connected: true, timeout() { return this; }, emit(event, payload, callback) {
  requests.push(payload);
  callback(null, { ok: true, asOf: 1000, raffles: [{ type: 'biweekly' }], tickets: { linked: true, esoAccountName: 'Alice', purchases: [
   { raffleType: 'biweekly', raffleLabel: 'Bi-Weekly', purchasedTickets: 100, bonusPercent: 20, bonusTickets: 20, totalTickets: 120, time: 1000 },
   { raffleType: 'monthly', raffleLabel: '50/50', purchasedTickets: 50, bonusPercent: 0, bonusTickets: 0, totalTickets: 50, time: 1000 }
  ] } });
 } };
 return { interaction, socket, replies, requests, logs, log: value => logs.push(value) };
}

test('/tickets requires no tickets boolean and matches the legacy ticket response', async () => {
 assert.equal(data.toJSON().name, 'tickets');
 assert.ok(!data.toJSON().options.some(option => option.name === 'tickets'));
 const f = fixture(), old = fixture({ legacy: true });
 await execute(f.interaction, f.socket, f.log);
 await raffle(old.interaction, old.socket, old.log);
 assert.equal(f.requests[0].includeTickets, true);
 assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
 assert.equal(f.replies.at(-1).content, old.replies.at(-1).content);
 assert.match(f.replies.at(-1).content, /20% bonus: 20 tickets/);
 assert.match(f.replies.at(-1).content, /<t:1000:f>\n\n50\/50:/);
});

test('verification displays requested tickets and logs the search and response', async () => {
 for (const command of [execute, raffle]) {
  const f = fixture({ verify: 'Alice' });
  await command(f.interaction, f.socket, f.log);
  assert.equal(f.requests[0].esoAccountName, 'Alice');
  assert.match(f.replies.at(-1).content, /120 tickets/);
  assert.ok(f.logs.some(line => line.includes('lookup') && line.includes('Alice') && line.includes('123')));
  assert.ok(f.logs.some(line => line.includes('response') && line.includes('Alice') && line.includes('purchases')));
 }
});

test('verification requires an authorized raffle administrator role and rejects account links', async () => {
 for (const role of ['Capo', 'Member', 'Caporegieme']) {
  const f = fixture({ verify: 'Alice', role });
  await execute(f.interaction, f.socket, f.log);
  assert.equal(f.requests.length, 0);
  assert.match(f.replies[0].content, /raffle administrator/);
 }
 const f = fixture({ verify: 'https://example.com' });
 await execute(f.interaction, f.socket, f.log);
 assert.equal(f.requests.length, 0);
});

test('ordinary members can use tickets and failures are logged privately', async () => {
 const f = fixture({ role: 'Member' });
 await execute(f.interaction, f.socket, f.log);
 assert.equal(f.requests.length, 1);
 f.socket.connected = false;
 await execute(f.interaction, f.socket, f.log);
 assert.match(f.replies.at(-1).content, /unavailable/);
 assert.ok(f.logs.some(line => line.includes('failed')));
});


test('General supports custom raffle administrators by role name or ID and explicit denial',async t=>{
 const before=process.env.GUILDSYNC_RAFFLE_ADMIN_ROLES;
 t.after(()=>before===undefined?delete process.env.GUILDSYNC_RAFFLE_ADMIN_ROLES:process.env.GUILDSYNC_RAFFLE_ADMIN_ROLES=before);
 process.env.GUILDSYNC_RAFFLE_ADMIN_ROLES='Officers,123456';
 let f=fixture({verify:'Alice',role:'officers'});await execute(f.interaction,f.socket);assert.ok(f.requests.length>0);
 f=fixture({verify:'Alice',role:'officers'});f.interaction.member.roles.cache=[{id:'123456',name:'Renamed'}];await execute(f.interaction,f.socket);assert.ok(f.requests.length>0);
 f=fixture({verify:'Alice',role:'officers'});f.interaction.member.roles.cache=[{name:'Consigliere'}];await execute(f.interaction,f.socket);assert.equal(f.requests.length,0);
 process.env.GUILDSYNC_RAFFLE_ADMIN_ROLES='';f=fixture({verify:'Alice',role:'officers'});await execute(f.interaction,f.socket);assert.equal(f.requests.length,0);
});
