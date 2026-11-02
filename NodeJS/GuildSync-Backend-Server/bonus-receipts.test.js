import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBonusTiers } from './raffle-bonus.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const { checkoutDepositMail } = await import('./guildsync-database-actions.js');

async function receipt({ type = 'biweekly', enabled = true, time = '2026-09-14T12:00:00Z', source = 'GuildBank', override, template } = {}) {
 const oldTemplate = process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE;
 if (template) process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE = template;
 else delete process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE;
 const tiers = parseBonusTiers(type === 'biweekly' ? '120:20,120:10,72:5,24:0' : '168:40,168:20,168:10,144:5,24:0');
 const row = { event_id: '123', transaction_type: type, account_name: '@Member', event_timestamp: Date.parse(time)/1000, deposit_amount: 10001, ticket_quantity: 100, data_source: source };
 const db = {
  async getConnection() { return db; }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  async query(sql) {
   if (sql.includes('SELECT event_id')) return [[{ event_id: '123' }]];
   if (sql.includes('SELECT')) return [[row]];
   return [{ affectedRows: 1 }];
  },
  async execute(sql) {
   if (sql.includes("mail_handoff_version = 1")) return [{affectedRows:0}];
   if (sql.includes('guildsync_raffle_bonus_versions')) return [[{ raffle_type: type, effective_from: 1, enabled: enabled ? 1 : 0, tiers_json: JSON.stringify(tiers) }]];
   if (sql.includes('guildsync_raffle_bonus_overrides')) return [override ? [{ raffle_type: type, sales_end: Date.parse('2026-09-26T23:00:00Z')/1000, enabled: 1, tiers_json: JSON.stringify(parseBonusTiers(override)) }] : []];
   throw Error(sql);
  }
 };
 try { return (await checkoutDepositMail(db, { checked_out_by: 'Tester' })).records[0]; }
 finally { if (oldTemplate === undefined) delete process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE; else process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE = oldTemplate; }
}

test('receipt includes purchased count, bonus percentage and Eastern deadline, bonus count and total', async () => {
 const record = await receipt();
 assert.match(record.body, /Ticket Credit Earned: 100/);
 assert.match(record.body, /20%.*before.*September 17, 2026.*7:00.*PM.*ET/);
 assert.match(record.body, /Bonus Tickets: 20/);
 assert.match(record.body, /Total Tickets: 120/);
 assert.equal(record.bonusTickets, 20);
});

test('monthly receipt uses its own tiers and later purchases use the applicable lower rate', async () => {
 assert.match((await receipt({ type: 'monthly', time: '2026-08-31T12:00:00Z' })).body, /Bonus Tickets: 40/);
 assert.match((await receipt({ time: '2026-09-20T12:00:00Z' })).body, /10%.*before.*September 22, 2026/);
});

test('disabled, zero-percent and manual receipts omit the bonus block', async () => {
 for (const options of [{ enabled: false }, { time: '2026-09-26T12:00:00Z' }, { source: 'ManualBiweeklyTicket' }]) {
  assert.doesNotMatch((await receipt(options)).body, /Bonus|Total Tickets|buying before/i);
 }
});

test('raffle override is used and custom templates get one bonus block', async () => {
 const options = { override: '120:30,192:10,24:0' };
 const record = await receipt({ ...options, template: 'Purchased {tickets}.' });
 assert.match(record.body, /Bonus Tickets: 30/);
 assert.match(record.body, /Total Tickets: 130/);
 const placed = await receipt({ ...options, template: 'Purchased {tickets}.\n{bonus_block}' });
 assert.equal(placed.body.match(/Bonus Tickets:/g).length, 1);
 assert.doesNotMatch(placed.body, /\{bonus_block\}/);
});
