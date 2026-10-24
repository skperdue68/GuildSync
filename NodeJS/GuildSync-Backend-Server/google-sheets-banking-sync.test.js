process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
const testAccount = JSON.stringify({ client_email: 'test@example.invalid', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) });
import assert from 'node:assert/strict';
import { syncBankingEntriesToGoogleSheets, sheetsRequest, configureSheetsCoordinator } from './google-sheets-banking-sync.js';
import * as sheets from './google-sheets-banking-sync.js';

function fixture(t, { rows = [], state = {}, formulaRanges = [], drawDates = ['09/26/26','09/26/26'] } = {}) {
  const env = { GUILDSYNC_GOOGLE_SHEETS_ENABLED: 'true', GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture',
    GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_JSON: testAccount, GUILDSYNC_GOOGLE_SHEETS_BIWEEKLY_TAB: 'bi-weekly raffle', GUILDSYNC_GOOGLE_SHEETS_5050_TAB: '50/50' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  const calls = [], writes = [], logs = [];
  configureSheetsCoordinator(async operation => operation(state));
  globalThis.fetch = async (url, init = {}) => {
    const decoded = decodeURIComponent(String(url)); calls.push(decoded);
    let body;
    if (decoded.includes('oauth2.googleapis.com')) body = { access_token: 'test-token' };
    else if (decoded.includes('!R7') || decoded.includes('!P7')) body = {values:[[decoded.includes('!R7') ? drawDates[0] : drawDates[1]]]};
    else if (decoded.includes('/values:batchGet')) body = {valueRanges:formulaRanges};
    else if (decoded.includes('?fields=sheets.properties')) body = { sheets: [
      { properties: { title: 'bi-weekly raffle', sheetId: 7, gridProperties: { rowCount: 300, columnCount: 20 } } },
      { properties: { title: '50/50', sheetId: 8, gridProperties: { rowCount: 300, columnCount: 20 } } }
    ] };
    else if (decoded.includes('/values/')) body = { values: typeof rows === 'function' ? rows(decoded) : rows };
    else if (decoded.endsWith(':batchUpdate')) {
      assert.equal(init.method, 'POST'); assert.match(logs.at(-1), /^Writing batch: entries=/);
      writes.push(JSON.parse(init.body).requests); body = {};
    } else throw new Error('Unexpected Google request: ' + decoded);
    return { ok: true, json: async () => structuredClone(body) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    configureSheetsCoordinator(async operation => operation({}));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { calls, writes, logs, run: (entries,options={}) => syncBankingEntriesToGoogleSheets(entries, { log: async value => logs.push(value), uploadedBy: 'EvaineFaye', ...options }) };
}
const ticket = (extra = {}) => ({ type: 'biweekly', eventId: '123', displayName: 'Player', amount: 200001, ticketAmount: 200,
  bonusEnabled: true, bonusTickets: 20, bonusPercent: 10, time: Date.parse('2026-09-15T16:00:00Z')/1000, ...extra });
const cellValues = request => request.updateCells.rows[0].values.map(cell => Object.values(cell.userEnteredValue)[0]);

test('rollover replay uses existing lock, skips archived/duplicate IDs and preserves bonus data', async t => {
  const f = fixture(t, { rows: [['existing', 'Already added', 100]] });
  configureSheetsCoordinator(() => assert.fail('replay must not reacquire its own lock'));
  const result = await sheets.replayBankingEntries([
    ticket({ eventId: 'closed', time: 1000 }), ticket({ eventId: 'existing' }), ticket({ eventId: 'new' })
  ], { lastClosedSalesEnd: { biweekly: 1000 } }, async value => f.logs.push(value));
  assert.equal(result.synced, 1);
  const requests = f.writes.flat();
  assert.ok(requests.some(request => request.updateCells?.start?.columnIndex === 3 && cellValues(request)[0] === 'new'));
  const bonus = requests.find(request => request.updateCells?.range?.startColumnIndex === 7);
  assert.equal(bonus.updateCells.rows[0].values[0].userEnteredValue.numberValue, 20);
  assert.match(bonus.updateCells.rows[0].values[0].note, /10%/);
});

for (const dataSource of ['GuildSyncBanking', 'GuildSyncTest']) {
  test(`${dataSource} biweekly donations begin at P62/Q62/R62 and skip occupied rows`, async t => {
    const f = fixture(t, { rows: [['existing', 'First', 50], ['', 'Reserved', 100], []] });
    await f.run([ticket({ ticketAmount: 0, dataSource, amount: 5000 })]);
    const write = f.writes.flat().find(request => request.updateCells?.start?.columnIndex === 15);
    assert.deepEqual(write.updateCells.start, { sheetId: 7, rowIndex: 63, columnIndex: 15 });
    assert.deepEqual(cellValues(write), ['123', 'Player', 5000]);
    assert.ok(f.calls.some(url => url.includes("'bi-weekly raffle'!P62:R70")));
  });
}

const refreshPeriods = [
  { type: 'biweekly', end: Date.parse('2026-09-26T23:00:00Z') / 1000 },
  { type: 'monthly', end: Date.parse('2026-10-24T23:00:00Z') / 1000 }
];
test('explicit archive refresh writes dates and entries only to that target under a no-rollover lock', async t => {
 const f=fixture(t);
 configureSheetsCoordinator(async (operation,options)=>{assert.equal(options.processRollover,false);return operation({});});
 await sheets.refreshBankingEntriesToGoogleSheets(async()=>({entries:[ticket()],periods:refreshPeriods,targetId:'archive-copy'}),
  {processRollover:false,log:async value=>f.logs.push(value)});
 assert.ok(f.calls.filter(url=>url.includes('sheets.googleapis.com')).every(url=>url.includes('/archive-copy')));
 assert.equal(sheets.config().spreadsheetId,'fixture');
 assert.equal(f.writes.length,1);
 assert.equal(f.writes[0].filter(r=>r.updateCells?.range?.startRowIndex===6 && r.updateCells.rows).length,2);
});
test('refresh clears both closure ranges then replaces entries and dates atomically on every run', async t => {
  const f = fixture(t, { rows: [['123', 'Old name', 100]] });
  const refresh = entries => sheets.refreshBankingEntriesToGoogleSheets(async () => ({ entries, periods: refreshPeriods }),
    { uploadedBy: 'Officer', log: async value => f.logs.push(value) });
  await refresh([ticket({ eventId: '124' }), ticket({ eventId: '124' })]);
  await refresh([ticket({ eventId: '124', displayName: 'Corrected' })]);
  assert.equal(f.writes.length, 2);
  for (const requests of f.writes) {
    const clears = requests.filter(r => r.updateCells?.range && !r.updateCells.rows);
    for (const id of [7, 8]) assert.ok(clears.some(r => r.updateCells.range.sheetId === id && r.updateCells.range.startColumnIndex === 3 && r.updateCells.range.endColumnIndex === 6));
    assert.ok(clears.every(r => !(r.updateCells.range.startColumnIndex <= 6 && r.updateCells.range.endColumnIndex > 6)));
    assert.ok(clears.every(r => !(r.updateCells.range.sheetId === 8 && r.updateCells.range.startColumnIndex === 9 && r.updateCells.range.endColumnIndex === 11)), 'preserve broad J:K range; J26 is now a result field');
    const dates = requests.filter(r => r.updateCells?.range?.startRowIndex === 6 && r.updateCells.rows);
    assert.equal(dates.length, 2);
    assert.deepEqual(dates.map(r => r.updateCells.range.startColumnIndex), [17, 15]);
    assert.deepEqual(dates.map(r => r.updateCells.rows[0].values[0].userEnteredValue.numberValue),
      [Date.UTC(2026, 8, 26), Date.UTC(2026, 9, 24)].map(date => date / 86400000 + 25569));
    const entries = requests.filter(r => r.updateCells?.start?.columnIndex === 3);
    assert.equal(entries.length, 1); assert.equal(entries[0].updateCells.start.rowIndex, 4);
  }
  assert.equal(f.calls.some(url => url.includes('/values/')), false);
});

test('empty refresh still clears both sheets and sets dates; missing periods never clears', async t => {
  const f = fixture(t);
  await sheets.refreshBankingEntriesToGoogleSheets(async () => ({ entries: [], periods: refreshPeriods }), { log: async value => f.logs.push(value) });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].filter(r => r.updateCells?.range?.startRowIndex === 6 && r.updateCells.rows).length, 2);
  await assert.rejects(sheets.refreshBankingEntriesToGoogleSheets(async () => ({ entries: [], periods: [] })), /period/i);
  assert.equal(f.writes.length, 1);
});

test('refresh preflights capacity for both raffles and performs no clears on overflow', async t => {
  const f = fixture(t);
  assert.equal(typeof sheets.refreshBankingEntriesToGoogleSheets, 'function');
  const entries = [ticket(), ...Array.from({ length: 10 }, (_, i) => ticket({ type: 'monthly', eventId: 'd' + i, ticketAmount: 0 }))];
  await assert.rejects(sheets.refreshBankingEntriesToGoogleSheets(async () => ({ entries, periods: refreshPeriods }), { log: async value => f.logs.push(value) }), /No empty row/);
  assert.deepEqual(f.writes, []);
});

test('failed Sheets requests report operation, range and Google detail without credentials', async t => {
  const originalFetch = globalThis.fetch, logs = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT', message: 'Range exceeds grid limits.' } }) });
  await assert.rejects(sheetsRequest('secret-token', 'https://sheets.googleapis.com/v4/spreadsheets/fixture/values/%2750%2F50%27!D5%3AF254', {}, value => logs.push(value)), /Range exceeds grid limits/);
  assert.match(logs[0], /GET.*D5:F254.*400.*INVALID_ARGUMENT/);
  assert.equal(logs[0].includes('secret-token'), false);
});

test('tickets write D/E/F in first fully empty row with G bonus note and correct atomic metadata', async t => {
  const f = fixture(t, { rows: [['old', 'First', 100], ['', 'Manual existing', 200], []] });
  assert.deepEqual(await f.run([ticket(), ticket({ type: 'monthly', eventId: '124', amount: 300003 })]), { enabled: true, synced: 2 });
  assert.ok(f.calls.some(url => url.includes("'bi-weekly raffle'!D5:F254")));
  assert.ok(f.calls.some(url => url.includes("'50/50'!D5:F254")));
  for (const [index, id, gold] of [[0, 7, 200000], [1, 8, 300000]]) {
    const requests = f.writes.flat().slice(index * 4, index * 4 + 4);
    assert.deepEqual(requests[0].updateCells.start, { sheetId: id, rowIndex: 6, columnIndex: 3 });
    assert.deepEqual(cellValues(requests[0]), [index ? '124' : '123', 'Player', gold]);
    assert.equal(requests[0].updateCells.fields, 'userEnteredValue');
    assert.deepEqual(requests[1].updateCells, {
      range: { sheetId: id, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 7, endColumnIndex: 8 },
      rows: [{ values: [{ userEnteredValue: { numberValue: 20 }, note: 'Bonus: 10%' }] }], fields: 'userEnteredValue,note'
    });
    assert.deepEqual(requests[2].updateDimensionProperties, { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 6, endIndex: 8 }, properties: { hiddenByUser: false }, fields: 'hiddenByUser' });
    const metadata = requests[3].updateCells;
    assert.deepEqual(metadata.start, { sheetId: id, rowIndex: 2, columnIndex: index ? 15 : 17 });
    assert.equal(metadata.rows[0].values[0].userEnteredValue.stringValue, 'EvaineFaye (GuildSync)');
    assert.match(metadata.rows[1].values[0].userEnteredValue.stringValue, /^\d+\/\d+\/\d{4} \d+:\d{2}(am|pm) ET$/);
    assert.equal(metadata.fields, 'userEnteredValue');
    assert.equal(requests.length, 4);
  }
});

test('disabled bonus clears stale G value/note without hiding other rows; manual tickets have zero bonus', async t => {
  const f = fixture(t);
  await f.run([ticket({ bonusEnabled: false }), ticket({ eventId: 'manual', dataSource: 'ManualBiweeklyTicket', note: 'FFTG' })]);
  const requests = f.writes.flat();
  const disabled = requests.slice(0, 4);
  assert.deepEqual(disabled[1].updateCells.rows, [{ values: [{}] }]);
  assert.equal(disabled[1].updateCells.fields, 'userEnteredValue,note');
  assert.deepEqual(disabled[2].updateCells.range, { sheetId: 7, startRowIndex: 4, endRowIndex: 254, startColumnIndex: 7, endColumnIndex: 8 });
  assert.equal(disabled[2].updateCells.fields, 'userEnteredValue,note');
  assert.deepEqual(disabled[3].updateDimensionProperties.range, { sheetId: 7, dimension: 'COLUMNS', startIndex: 6, endIndex: 8 });
  assert.deepEqual(cellValues(requests[5]), ['manual', 'Player (FFTG)', 200000]);
  assert.equal(requests[5].updateCells.start.rowIndex, 5);
  assert.deepEqual(requests[6].updateCells.rows, [{ values: [{ userEnteredValue: { numberValue: 0 }, note: 'Bonus: 0%' }] }]);
});

test('zero-ticket donations use bounded P/Q/R and N/O/P ranges without bonus cells or notes', async t => {
  const f = fixture(t, { rows: [['existing', 'Member', 50], []] });
  await f.run([ticket({ ticketAmount: 0, note: 'Guild donation', dataSource: 'ManualBiweeklyTicket' }), ticket({ type: 'monthly', eventId: 'monthly', ticketAmount: 0, amount: 500003 })]);
  assert.ok(f.calls.some(url => url.includes("'bi-weekly raffle'!P62:R70")));
  assert.ok(f.calls.some(url => url.includes("'50/50'!N36:P44")));
  const requests = f.writes.flat();
  assert.deepEqual(requests[0].updateCells.start, { sheetId: 7, rowIndex: 62, columnIndex: 15 });
  assert.deepEqual(requests[2].updateCells.start, { sheetId: 8, rowIndex: 36, columnIndex: 13 });
  assert.deepEqual(cellValues(requests[0]), ['123', 'Player (Guild donation)', 200000]);
  assert.deepEqual(cellValues(requests[2]), ['monthly', 'Player', 500000]);
  assert.equal(requests.length, 4);
  assert.ok(f.writes.flat().every(request => request.updateCells.fields === 'userEnteredValue'));
});

test('existing transaction IDs skip all writes including bonus and metadata', async t => {
  const f = fixture(t, { rows: [['123', 'Already present', 200000]] });
  assert.equal((await f.run([ticket()])).synced, 0);
  assert.equal(f.writes.length, 0);
  assert.ok(f.logs.some(line => line.includes('Duplicate skipped: 123')));
});

for (const [type, ticketAmount, count, range] of [['biweekly', 200, 250, 'D5:F254'], ['biweekly', 0, 9, 'P62:R70'], ['monthly', 0, 9, 'N36:P44']]) {
  test(`full ${type} ${range} refuses overflow without writes`, async t => {
    const f = fixture(t, { rows: Array.from({ length: count }, (_, index) => [String(index + 500), 'Occupied', 100]) });
    await assert.rejects(f.run([ticket({ type, ticketAmount })]), /No empty row/);
    assert.equal(f.writes.length, 0);
    assert.ok(f.calls.some(url => url.includes(range)));
  });
}

test('closed-period and missing-time entries never refill reset tabs; new entries still export', async t => {
  const f = fixture(t, { state: { lastClosedSalesEnd: { biweekly: 1000 } } });
  const result = await f.run([ticket({ eventId: 'past', time: 999 }), ticket({ eventId: 'boundary', time: 1000 }), ticket({ eventId: 'unknown', time: undefined }), ticket({ eventId: 'new', time: Date.parse('2026-09-15T16:00:00Z')/1000 })]);
  assert.equal(result.synced, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(cellValues(f.writes[0][0])[0], 'new');
  assert.ok(f.logs.some(line => line.includes('entries=3') && line.includes('retained')));
});

test('non-raffle entries and disabled exports make no Google calls', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.run([ticket({ type: 'other' })]), { enabled: true, synced: 0 });
  process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED = 'false';
  assert.deepEqual(await f.run([ticket()]), { enabled: false, synced: 0 });
  assert.deepEqual(f.calls, []);
});

test('75-entry export reads each section once, reserves unique rows and batches 25 entries while skipping input duplicates', async t => {
  const f = fixture(t);
  const entries = Array.from({ length: 75 }, (_, index) => ticket({ eventId: String(1000 + index), displayName: 'Player ' + index }));
  entries.splice(20, 0, { ...entries[0] });
  entries.push({ ...entries[0] });
  assert.deepEqual(await f.run(entries), { enabled: true, synced: 75 });
  assert.equal(f.calls.filter(url => url.includes('/values/')).length, 2);
  assert.equal(f.calls.filter(url => decodeURIComponent(url).includes('!R7')).length, 1);
  assert.equal(f.writes.length, 3);
  assert.ok(f.writes.every(requests => requests.length === 25 * 4));
  const ticketWrites = f.writes.flat().filter(request => request.updateCells?.start?.columnIndex === 3);
  assert.deepEqual(ticketWrites.map(request => request.updateCells.start.rowIndex), Array.from({ length: 75 }, (_, index) => index + 4));
  assert.deepEqual(ticketWrites.map(request => cellValues(request)[0]), Array.from({ length: 75 }, (_, index) => String(index + 1000)));
  assert.equal(f.logs.filter(line => line.includes('Duplicate skipped: 1000')).length, 2);
});


test('historical load restores saved winners and attendance to exact cells in the same batch', async t => {
  const f=fixture(t);
  await sheets.refreshBankingEntriesToGoogleSheets(async()=>({
    entries:[], periods:[{type:'biweekly',end:1790463600},{type:'monthly',end:1790463600}],
    results:{biweekly:[{address:'Q48',value:'Historical winner'},{address:'K200',value:0}],
      monthly:[{address:'L23',value:'Monthly winner'},{address:'J26',value:'Sender'}]}
  }),{log:async value=>f.logs.push(value)});
  assert.equal(f.writes.length,1);
  const cells=f.writes[0].filter(r=>r.updateCells?.start).map(r=>r.updateCells);
  assert.ok(cells.some(c=>c.start.sheetId===7 && c.start.rowIndex===47 && c.start.columnIndex===16 && c.rows[0].values[0].userEnteredValue.stringValue==='Historical winner'));
  assert.ok(cells.some(c=>c.start.sheetId===7 && c.start.rowIndex===199 && c.rows[0].values[0].userEnteredValue.numberValue===0));
  assert.ok(cells.some(c=>c.start.sheetId===8 && c.start.rowIndex===22 && c.start.columnIndex===11));
});

test('load persists changed live formulas before historical values replace them', async t=>{
 const f=fixture(t,{formulaRanges:[{}, {}, {values:[['=NEW_FORMULA()']]}, {},{},{}]});
 let saved;
 await sheets.refreshBankingEntriesToGoogleSheets(async()=>({
   entries:[],periods:[{type:'biweekly',end:1790463600},{type:'monthly',end:1790463600}],
   results:{biweekly:[{address:'S31',value:200000,formula:'=OLD_FORMULA()'}]}
 }),{log:async value=>f.logs.push(value),saveTemplates:async templates=>{
   assert.equal(f.writes.length,0); saved=templates;
 }});
 assert.equal(saved.biweekly[0].formula,'=NEW_FORMULA()');
 const restored=f.writes[0].filter(r=>r.updateCells?.start?.columnIndex===18).at(-1);
 assert.equal(restored.updateCells.rows[0].values[0].userEnteredValue.numberValue,200000);
});
test('template persistence failure prevents historical sheet replacement', async t=>{
 const f=fixture(t);
 await assert.rejects(sheets.refreshBankingEntriesToGoogleSheets(async()=>({
   entries:[],periods:[{type:'biweekly',end:1790463600},{type:'monthly',end:1790463600}]
 }),{log:async value=>f.logs.push(value),saveTemplates:async()=>{throw Error('template storage failed');}}),/template storage/);
 assert.equal(f.writes.length,0);
});


test('live writes follow each displayed raffle date, leaving past/future entries in database',async t=>{
 const f=fixture(t,{drawDates:['09/26/26','10/24/26']});
 const result=await f.run([
  ticket({eventId:'past',time:Date.parse('2026-09-01T12:00:00Z')/1000}),
  ticket({eventId:'current'}),
  ticket({eventId:'future',time:Date.parse('2026-10-01T12:00:00Z')/1000}),
  ticket({eventId:'monthly-current',type:'monthly',time:Date.parse('2026-10-01T12:00:00Z')/1000})
 ]);
 assert.equal(result.synced,2);
 const text=JSON.stringify(f.writes);
 assert.ok(text.includes('current') && text.includes('monthly-current'));
 assert.ok(!text.includes('past') && !text.includes('future'));
});

test('blank working draw date prevents writing into that tab',async t=>{
 const f=fixture(t,{drawDates:['','09/26/26']});
 assert.equal((await f.run([ticket()])).synced,0);
 assert.equal(f.writes.length,0);
});

test('displayed raffle uses the same inclusive sales cutoff as archive catchup for both types', async t => {
 const f = fixture(t);
 for (const type of ['biweekly', 'monthly']) {
  const start = Date.parse(type === 'biweekly' ? '2026-09-12T23:00:01Z' : '2026-08-29T23:00:01Z') / 1000;
  const end = Date.parse('2026-09-26T23:00:00Z') / 1000;
  assert.equal((await f.run([
   ticket({ type, eventId: type + '-before', time: start - 1 }),
   ticket({ type, eventId: type + '-start', time: start }),
   ticket({ type, eventId: type + '-last', time: end }),
   ticket({ type, eventId: type + '-end', time: end + 1 })
  ])).synced, 2);
 }
 const written = JSON.stringify(f.writes);
 assert.ok(!written.includes('-before') && !written.includes('-end'));
});

test('durable export acknowledgement includes written and duplicate IDs but never deferred entries',async t=>{
 const f=fixture(t,{rows:[['existing','Already written',100]]});const completed=[];
 await f.run([ticket({eventId:'existing'}),ticket({eventId:'new'}),ticket({eventId:'old',time:1000})],{onCompleted:async ids=>completed.push(...ids)});
 assert.deepEqual(completed.sort(),['existing','new']);
});
test('failed Google batch never acknowledges the entries as exported',async t=>{
 const f=fixture(t);const fetch=globalThis.fetch;globalThis.fetch=async(url,init)=>String(url).endsWith(':batchUpdate')?{ok:false,status:503,json:async()=>({error:{message:'temporary outage'}})}:fetch(url,init);
 const completed=[];await assert.rejects(f.run([ticket()],{onCompleted:async ids=>completed.push(...ids)}),/503/);assert.deepEqual(completed,[]);
});

test('input duplicate is not acknowledged before the pending batch succeeds',async t=>{
 const f=fixture(t);const fetch=globalThis.fetch;globalThis.fetch=async(url,init)=>String(url).endsWith(':batchUpdate')?{ok:false,status:503,json:async()=>({error:{message:'outage'}})}:fetch(url,init);
 const completed=[];await assert.rejects(f.run([ticket(),ticket()],{onCompleted:async ids=>completed.push(...ids)}),/503/);assert.deepEqual(completed,[]);
});
