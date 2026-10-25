import test from 'node:test';
import assert from 'node:assert/strict';

test('raffle and ticket messages distinguish current time from each raffle latest transaction and warn of lag', async () => {
  const {formatRaffles} = await import('./raffle.js');
  const snapshot = {asOf: 1781996401, raffles: [
    {type: 'biweekly', prizeGold: 200000, drawCount: 1, totalTickets: 4, latestTransactionAt: 1781996000},
    {type: 'monthly', prizeGold: 100000, totalTickets: 8, latestTransactionAt: 1781996100}
  ], tickets: {linked: true, esoAccountName: 'Example', purchases: [
    {raffleType: 'biweekly', raffleLabel: 'Bi-weekly', time: 1781995000, purchasedTickets: 4, totalTickets: 4}
  ]}};
  for (const options of [{}, {includeTickets: true}, {includeTickets: true, verifyName: 'Example'}]) {
    const content = formatRaffles(snapshot, options);
    assert.match(content, /As of <t:1781996401:f>/);
    assert.match(content, /Bi-Weekly:[^]*?Latest recorded transaction: <t:1781996000:f>/);
    assert.match(content, /50\/50:[^]*?Latest recorded transaction: <t:1781996100:f>/);
    assert.match(content, /GuildSync automation[^]*?may lag behind actual deposit data/);
  }
});

test('empty raffle periods and unavailable older backend timestamps are identified explicitly', async () => {
  const {formatRaffles} = await import('./raffle.js');
  for (const value of [undefined, NaN, 0, 'not-a-date']) {
    const content = formatRaffles({asOf: 100, raffles: [{type: 'biweekly', latestTransactionAt: value}]});
    assert.match(content, /Latest recorded transaction: unavailable/);
  }
  const empty = formatRaffles({asOf: 100, raffles: [{type: 'biweekly', latestTransactionAt: null}]});
  assert.match(empty, /No transactions recorded for this raffle period/);
  assert.doesNotMatch(empty, /<t:null:/);
});

test('raffle messages advertise prize gold and biweekly draw count, not deposits', async () => {
  const { formatRaffles } = await import('./raffle.js');
  const content = formatRaffles({ asOf: 1781996401, raffles: [
    { type: 'biweekly', label: 'Bi-Weekly', prizeGold: 600000, drawCount: 3, totalTickets: 100, salesOpen: false, salesEnd: 1781996400, drawTime: 1782000000, deposits: 1000000 },
    { type: 'monthly', label: '50/50', prizeGold: 500000, totalTickets: 200, salesOpen: true, salesEnd: 1781996400, drawTime: 1782000000 }
  ] });
  assert.match(content, /600,000 gold/);
  assert.match(content, /3 draws.*200,000 gold/);
  assert.match(content, /500,000 gold/);
  assert.doesNotMatch(content, /1,000,000/);
  assert.match(content, /Sales closed/);
});

test('announcements persist cadence and high-water milestones, coalescing crossings', async () => {
  const { createRaffleAnnouncer } = await import('./raffle.js');
  let now = 1000, state = null, sent = 0;
  const raffles = [{ id: 'b:1', type: 'biweekly', prizeGold: 200000 }, { id: 'm:1', type: 'monthly', prizeGold: 499999 }];
  const options = { channelId: 'channel', intervalHours: 48, thresholds: { biweekly: 200000, monthly: 500000 },
    now: () => now, loadState: async () => state, saveState: async value => { state = structuredClone(value); },
    fetchRaffles: async () => ({ raffles }), send: async () => { sent++; } };
  let announcer = createRaffleAnnouncer(options);
  await announcer.tick(); assert.equal(sent, 1);
  announcer = createRaffleAnnouncer(options); // Restart must not repost.
  await announcer.tick(); assert.equal(sent, 1);
  raffles[1].prizeGold = 500000;
  await announcer.tick(); assert.equal(sent, 2);
  raffles[1].prizeGold = 499999;
  await announcer.tick();
  raffles[1].prizeGold = 500000;
  await announcer.tick(); assert.equal(sent, 2);
  raffles[0].prizeGold = 800000; raffles[1].prizeGold = 2000000;
  await announcer.tick(); assert.equal(sent, 3); // One combined announcement, not each crossed threshold.
  now += 48 * 3600;
  await announcer.tick(); assert.equal(sent, 4);
  raffles[0].id = 'b:2'; raffles[0].prizeGold = 0;
  await announcer.tick(); assert.equal(sent, 5);
});

test('failed sends are retried, and overlapping ticks cannot duplicate posts', async () => {
  const { createRaffleAnnouncer } = await import('./raffle.js');
  let sent = 0, fail = true, saved = 0;
  const announcer = createRaffleAnnouncer({ channelId: 'c', intervalHours: 24, thresholds: { biweekly: 200000, monthly: 500000 },
    loadState: async () => null, saveState: async () => { saved++; }, now: () => 100,
    fetchRaffles: async () => ({ raffles: [{ type: 'biweekly', id: 'b:1', prizeGold: 200000 }] }),
    send: async () => { if (fail) throw new Error('Discord unavailable'); sent++; } });
  await assert.rejects(announcer.tick(), /unavailable/);
  assert.equal(saved, 1); // Delivery is persisted before attempting Discord.
  fail = false;
  await Promise.all([announcer.tick(), announcer.tick()]);
  assert.equal(sent, 1); assert.equal(saved, 2);
});

test('successful send with failed final save is reconciled after restart', async () => {
  const { createRaffleAnnouncer } = await import('./raffle.js');
  let disk = null, writes = 0, posts = 0;
  const delivered = new Set();
  const options = { channelId: 'c', intervalHours: 48, thresholds: { biweekly: 200000, monthly: 500000 },
    now: () => 100, fetchRaffles: async () => ({ raffles: [{ id: 'b:1', type: 'biweekly', prizeGold: 200000 }] }),
    loadState: async () => structuredClone(disk),
    saveState: async state => { if (++writes === 2) throw new Error('disk unavailable'); disk = structuredClone(state); },
    send: async (_snapshot, delivery) => { if (!delivered.has(delivery.id)) { posts++; delivered.add(delivery.id); } }
  };
  await assert.rejects(createRaffleAnnouncer(options).tick(), /disk unavailable/);
  await createRaffleAnnouncer(options).tick();
  assert.equal(posts, 1);
  assert.equal(disk.pending, undefined);
  assert.equal(disk.raffles.biweekly.id, 'b:1');
});

test('no announcement is sent when pending state cannot be persisted', async () => {
  const { createRaffleAnnouncer } = await import('./raffle.js');
  let sent = 0;
  const announcer = createRaffleAnnouncer({ channelId: 'c', intervalHours: 48, thresholds: { biweekly: 200000, monthly: 500000 },
    loadState: async () => null, saveState: async () => { throw new Error('read-only state'); },
    fetchRaffles: async () => ({ raffles: [{ id: 'b:1', type: 'biweekly', prizeGold: 0 }] }), send: async () => { sent++; } });
  await assert.rejects(announcer.tick(), /read-only state/);
  assert.equal(sent, 0);
});

function reminderFixture(extra = {}) {
  let time = 1000, disk = null;
  const sent = [];
  const raffle = { id: 'b:1', type: 'biweekly', prizeGold: 200000, salesOpen: true, salesEnd: 20000,
    bonusEnabled: true, bonusPercent: 25, bonusExpiresAt: 10000, nextBonusPercent: 10, nextBonusExpiresAt: 16000 };
  const options = { channelId: 'c', intervalHours: 48, thresholds: { biweekly: 200000, monthly: 500000 },
    now: () => time, loadState: async () => structuredClone(disk), saveState: async state => { disk = structuredClone(state); },
    fetchRaffles: async () => ({ asOf: time, raffles: [raffle] }), send: async value => { sent.push(structuredClone(value)); }, ...extra };
  return { options, raffle, sent, at: value => { time = value; }, disk: () => disk };
}

test('reminders fire at lead boundaries, persist dedup and preserve regular cadence', async () => {
  const { createRaffleAnnouncer, formatRaffles } = await import('./raffle.js');
  const f = reminderFixture();
  let announcer = createRaffleAnnouncer(f.options);
  await announcer.tick();
  f.at(6399); await announcer.tick(); assert.equal(f.sent.length, 1);
  f.at(6400); await announcer.tick(); assert.equal(f.sent.length, 2);
  assert.match(formatRaffles(f.sent[1]), /25%.*10%.*<t:10000:F>/);
  assert.equal(f.disk().raffles.biweekly.lastPostedAt, 1000);
  announcer = createRaffleAnnouncer(f.options);
  await announcer.tick(); assert.equal(f.sent.length, 2);
  f.at(12800); await announcer.tick();
  assert.match(formatRaffles(f.sent.at(-1)), /sales close.*<t:20000:F>/i);
});

test('multiple leads and raffles have independent warning identities; expired events never warn', async () => {
  const { createRaffleAnnouncer } = await import('./raffle.js');
  const f = reminderFixture({ bonusReminderHours: [2, 1], salesCloseReminderHours: [2] });
  const announcer = createRaffleAnnouncer(f.options);
  await announcer.tick();
  f.at(2800); await announcer.tick(); assert.equal(f.sent.length, 2);
  f.at(6400); await announcer.tick(); assert.equal(f.sent.length, 3);
  f.raffle.bonusExpiresAt = 11000;
  await announcer.tick(); assert.equal(f.sent.length, 4);
  f.at(20000); await announcer.tick(); assert.equal(f.sent.length, 4);
});

test('pending warning retries expire at event time after restart', async () => {
  const { createRaffleAnnouncer } = await import('./raffle.js');
  const f = reminderFixture();
  await createRaffleAnnouncer(f.options).tick();
  f.at(6400);
  await assert.rejects(createRaffleAnnouncer({ ...f.options, send: async () => { throw new Error('offline'); } }).tick(), /offline/);
  f.at(20000);
  await createRaffleAnnouncer(f.options).tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.disk().pending, undefined);
});

test('reminder hours accept comma-separated positive finite values and reject malformed configuration', async () => {
  const { parseReminderHours } = await import('./raffle.js');
  assert.equal(typeof parseReminderHours, 'function');
  assert.deepEqual(parseReminderHours(undefined, [1]), [1]);
  assert.deepEqual(parseReminderHours('2, 1, 0.5, 2', [1]), [2, 1, 0.5]);
  for (const input of ['', '1,', '0', '-1', 'NaN', 'Infinity', 'hello']) assert.throws(() => parseReminderHours(input, [1]), /reminder/i);
});

test('raffle formatting starts with full freshness line and shows bonus expiration warnings', async () => {
  const { formatRaffles } = await import('./raffle.js');
  const content = formatRaffles({ asOf: 100, raffles: [], reminders: [{ type: 'monthly', kind: 'bonus', percent: 10, nextPercent: 0, at: 500 }] });
  assert.ok(content.startsWith('**50/50 reminder:**'));
  assert.match(content, /As of <t:100:f>\. Based on the latest banking data received by GuildSync\./);
  assert.match(content, /10%.*expires.*<t:500:F>/);
});

test('each raffle warns independently and only the current bonus boundary is announced', async () => {
  const { createRaffleAnnouncer, formatRaffles } = await import('./raffle.js');
  const f = reminderFixture({ bonusReminderHours: [2] });
  const monthly = { ...f.raffle, id: 'm:1', type: 'monthly', bonusExpiresAt: 12000, nextBonusPercent: 0 };
  f.options.fetchRaffles = async () => ({ asOf: 1000, raffles: [f.raffle, monthly] });
  const announcer = createRaffleAnnouncer(f.options);
  await announcer.tick();
  f.at(2800); await announcer.tick();
  f.at(4800); await announcer.tick();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].reminders[0].type, 'monthly');
  f.at(8800); await announcer.tick();
  assert.equal(f.sent.length, 3); // The following tier may itself lead to another tier.
  f.raffle.bonusPercent = 10; f.raffle.bonusExpiresAt = 16000; f.raffle.nextBonusPercent = 5;
  f.raffle.nextBonusExpiresAt = 19000;
  f.at(10000); await createRaffleAnnouncer(f.options).tick();
  assert.equal(f.sent.length, 4);
  assert.match(formatRaffles(f.sent.at(-1)), /10% ticket bonus changes to 5% at <t:16000:F>/);
  assert.doesNotMatch(formatRaffles(f.sent.at(-1)), /10% ticket bonus expires/);
});

test('groups simultaneous reminders by purpose and puts them before freshness line', async () => {
  const { formatRaffles } = await import('./raffle.js');
  const content = formatRaffles({ asOf: 100, raffles: [], reminders: [
    { type: 'biweekly', kind: 'sales', at: 500 },
    { type: 'monthly', kind: 'sales', at: 500 },
    { type: 'biweekly', kind: 'bonus', percent: 20, nextPercent: 10, at: 700 },
    { type: 'monthly', kind: 'bonus', percent: 20, nextPercent: 10, at: 700 }
  ] });
  assert.equal((content.match(/Ticket sales close/g) || []).length, 1);
  assert.equal((content.match(/ticket bonus changes to/g) || []).length, 1);
  assert.ok(content.indexOf('Ticket sales close') < content.indexOf('As of'));
  assert.match(content, /Bi-Weekly and 50\/50 reminder/);
});

test('changing announcement channel reconciles pending delivery in original channel first',async()=>{const {createRaffleAnnouncer}=await import('./raffle.js');let state={channelId:'old',raffles:{},pending:{id:'job',createdAt:100,snapshot:{raffles:[]},next:{channelId:'old',raffles:{}}}};let destination;const a=createRaffleAnnouncer({channelId:'new',intervalHours:48,thresholds:{biweekly:1,monthly:1},loadState:async()=>state,saveState:async s=>state=s,fetchRaffles:async()=>{throw Error('must reconcile first');},send:async(s,d)=>destination=d.channelId});await a.tick();assert.equal(destination,'old');assert.equal(state.channelId,'old');});


test('two-hour sales warning uses sales cutoff when draw is one hour later', async () => {
  const {createRaffleAnnouncer, formatRaffles} = await import('./raffle.js');
  for (const type of ['biweekly', 'monthly']) {
    const f = reminderFixture({salesCloseReminderHours:[2]});
    Object.assign(f.raffle, {type, id:type+':1', bonusEnabled:false, drawTime:23600});
    const announcer = createRaffleAnnouncer(f.options);
    await announcer.tick();
    f.at(12799); await announcer.tick(); assert.equal(f.sent.length,1);
    f.at(12800); await announcer.tick(); assert.equal(f.sent.length,2);
    assert.ok(f.sent[1].reminders.every(r => r.at === 20000));
    assert.match(formatRaffles(f.sent[1]), /Ticket sales close at <t:20000:F>/);
    f.at(16400); await announcer.tick(); assert.equal(f.sent.length,2);
    await createRaffleAnnouncer(f.options).tick(); assert.equal(f.sent.length,2);
  }
});

test('startup one hour before cutoff catches up a two-hour sales warning', async () => {
  const {createRaffleAnnouncer} = await import('./raffle.js');
  const f = reminderFixture({salesCloseReminderHours:[2]});
  Object.assign(f.raffle,{bonusEnabled:false,drawTime:23600});
  f.at(16400); await createRaffleAnnouncer(f.options).tick();
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].reminders[0].at,20000);
});
