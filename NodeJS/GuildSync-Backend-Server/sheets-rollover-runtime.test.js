import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
const testAccount = JSON.stringify({ client_email: 'test@example.invalid', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) });
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetRequests, startSheetsRollover, drawDateRequest } from './sheets-rollover-runtime.js';
import { configureSheetsCoordinator, syncBankingEntriesToGoogleSheets } from './google-sheets-banking-sync.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';

for (const [type, donationRows, donationColumns] of [['biweekly', [61, 70], [15, 18]], ['monthly', [35, 44], [13, 16]]]) {
  test(`${type} reset touches exact values/notes ranges, hides G and replaces only prior markers`, () => {
    const requests = resetRequests(7, type, 'next-key', [{ metadataId: 23 }]);
    const ranges = requests.filter(request => request.updateCells).map(request => request.updateCells.range);
    assert.ok(ranges.some(range => range.startRowIndex === 4 && range.endRowIndex === 254 && range.startColumnIndex === 3 && range.endColumnIndex === 6));
    assert.equal(ranges.some(range => range.startRowIndex === 4 && range.endRowIndex === 254 && range.startColumnIndex === 9 && range.endColumnIndex === 11), type === 'biweekly');
    const touches = column => ranges.some(range => range.startRowIndex < 254 && range.endRowIndex > 4 && range.startColumnIndex <= column && range.endColumnIndex > column);
    assert.equal(touches(6), false, 'preserve G values, formulas and notes');
    if (type === 'monthly') {
      assert.equal(touches(9), false, 'preserve 50/50 J');
      assert.equal(touches(10), false, 'preserve 50/50 K');
    }
    assert.ok(requests.some(({ updateCells: cell }) => cell?.range.startRowIndex === 4 && cell.range.endRowIndex === 254 && cell.range.startColumnIndex === 7 && cell.range.endColumnIndex === 8 && cell.fields === 'userEnteredValue,note'));
    assert.ok(ranges.some(range => range.startRowIndex === donationRows[0] && range.endRowIndex === donationRows[1] && range.startColumnIndex === donationColumns[0] && range.endColumnIndex === donationColumns[1]));
    if (type === 'biweekly') {
      assert.ok(ranges.some(range => range.startRowIndex === 2 && range.endRowIndex === 4 && range.startColumnIndex === 17 && range.endColumnIndex === 18));
      assert.ok(ranges.some(range => range.startRowIndex === 32 && range.endRowIndex === 52 && range.startColumnIndex === 16 && range.endColumnIndex === 17));
    } else {
      assert.ok(ranges.some(range => range.startRowIndex === 2 && range.endRowIndex === 4 && range.startColumnIndex === 15 && range.endColumnIndex === 16));
      assert.ok(ranges.some(range => range.startRowIndex === 24 && range.endRowIndex === 25 && range.startColumnIndex === 15 && range.endColumnIndex === 16));
      assert.ok(ranges.some(range => range.startRowIndex === 27 && range.endRowIndex === 28 && range.startColumnIndex === 12 && range.endColumnIndex === 13));
    }
    assert.ok(requests.some(request => request.deleteDeveloperMetadata));
    assert.ok(requests.some(request => request.createDeveloperMetadata));
    const formatClears = requests.filter(request => request.updateCells?.fields.includes('userEnteredFormat'));
    assert.equal(formatClears.length, type === 'biweekly' ? 1 : 0);
    if (type === 'biweekly') {
      assert.deepEqual(formatClears[0].updateCells.range, { sheetId: 7, startRowIndex: 4, endRowIndex: 254, startColumnIndex: 9, endColumnIndex: 11 });
      assert.ok(formatClears[0].updateCells.fields.includes('userEnteredFormat.backgroundColor'));
      assert.ok(!formatClears[0].updateCells.fields.split(',').some(field => field === 'userEnteredFormat' || field.includes('borders')));
      assert.equal(formatClears[0].updateCells.rows, undefined);
    }
  });
}

async function fixture(t, { appendFailure = false, copyFailure = false, uncertainClear = false, sourceAsCopy = false, replacedArchiveIds = [], cellSaveFailure = false, snapshotFailure = false, skipMonthly = false, loadCatchupEntries = async () => [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'guildsync-rollover-test-'));
  const env = {
    GUILDSYNC_GOOGLE_SHEETS_ENABLED: 'true', GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED: 'true',
    GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID: 'original-source', GUILDSYNC_GOOGLE_ARCHIVE_WEB_APP_URL: 'https://script.google.com/macros/s/test/exec',
    GUILDSYNC_GOOGLE_ARCHIVE_SECRET: 'fixture-secret', GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS: '0',
    GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_JSON: testAccount, GUILDSYNC_GOOGLE_SHEETS_LOG_FILE: path.join(dir, 'test.log'),
    GUILDSYNC_GOOGLE_SHEETS_BIWEEKLY_TAB: 'bi-weekly raffle', GUILDSYNC_GOOGLE_SHEETS_5050_TAB: '50/50'
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  const calls = [], mutations = [], markers = [], batches = [], completed = [];
  let state = { version: 1, windows: [{ type: 'biweekly', salesEnd: 1000, drawTime: 1000 }, { type: 'monthly', salesEnd: 3000, drawTime: 4000 }], lastClosedSalesEnd: {}, pending: null };
  let copy, released = 0, failClear = uncertainClear;
  const sheetRows = [];
  const connection = {
    beginTransaction: async()=>{},commit:async()=>{},rollback:async()=>{},
    async execute(sql, params) {
      if (sql.startsWith('UPDATE guildsync_sheets_export_queue')) { assert.equal(params[0],'original-source'); completed.push(params[1]); return [{}]; }
      if (sql.includes('guildsync_raffle_archive_cells')) { if (cellSaveFailure) throw Error('archive cell storage failed'); return [{}]; }
      if (sql.startsWith('UPDATE guildsync_settings')) return [{}];
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT value')) return [[{ value: JSON.stringify(state) }]];
      if (skipMonthly && sql.startsWith('INSERT INTO guildsync_raffle_results')) assert.notEqual(params[0], 'monthly');
      if (snapshotFailure && sql.includes('guildsync_raffle_result')) throw Error('snapshot storage failed');
      if (sql.includes('guildsync_raffle_result')) return [sql.startsWith('SELECT') ? [] : {}];
      if (sql.startsWith('INSERT')) { state = JSON.parse(params[1]); return [{}]; }
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() { released++; }
  };
  const db = { getConnection: async () => connection };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url); calls.push(url);
    let body;
    if (url.includes('oauth2.googleapis.com')) body = { access_token: 'test-token' };
    else if (url.includes('/values:batchGet')) body = {valueRanges:[]};
    else if (url.startsWith('https://script.google.com/')) {
      const payload = JSON.parse(init.body);
      assert.equal(payload.secret, 'fixture-secret');
      if (payload.action === 'archive') {
        mutations.push('archive');
        if (copyFailure) return { ok: false, status: 403 };
        copy = { ok: true, sourceId: payload.sourceId, key: payload.key, archiveId: sourceAsCopy ? payload.sourceId : 'archive-copy', name:'260926 Raffle', replacedArchiveIds, drawDates:{biweekly:'2026-09-26',monthly:'2026-10-24'}, diagnosticCells:[{tab:'bi-weekly raffle',cell:'Q33',value:'Alice'},{tab:'bi-weekly raffle',cell:'Q52',value:'0'}],
          results: {biweekly:{date:'2026-09-26',cells:[]},monthly:skipMonthly?{skipped:true,reason:'unreadable-date'}:{date:'2026-10-24',cells:[]}} };
      } else mutations.push('verify');
      body = copy;
      if(snapshotFailure) delete body.results;
    }
    else if (url.endsWith(':batchUpdate')) {
      assert.equal(url, 'https://sheets.googleapis.com/v4/spreadsheets/original-source:batchUpdate');
      const requests = JSON.parse(init.body).requests;
      const appends = requests.filter(request => request.updateCells?.start?.columnIndex === 3);
      if (appendFailure && appends.length) throw Error('Google append failed');
      mutations.push(appends.length ? 'append' : 'clear');
      for (const request of appends) sheetRows.push(request.updateCells.rows[0].values.map(cell => Object.values(cell.userEnteredValue)[0]));
      batches.push(requests);
      assert.ok(requests.every(request => [7,8].includes(request.updateCells?.range?.sheetId ?? request.updateCells?.start?.sheetId ?? request.updateDimensionProperties?.range.sheetId ?? request.createDeveloperMetadata?.developerMetadata.location.sheetId)));
      markers.push(...requests.filter(request => request.createDeveloperMetadata).map(request => request.createDeveloperMetadata.developerMetadata));
      if (failClear) { failClear = false; throw new Error('response lost after clear'); }
      body = {};
    } else if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/original-source?')) body = {
      sheets: [{ properties: { sheetId: 7, title: 'bi-weekly raffle', gridProperties: {rowCount:300,columnCount:20} }, developerMetadata: markers }, { properties: { sheetId: 8, title: '50/50', gridProperties: {rowCount:300,columnCount:20} }, developerMetadata: markers }]
    };
    else if (decodeURIComponent(url).includes('!R7') || decodeURIComponent(url).includes('!P7')) body = {values:[['09/26/26']]};
    else if (url.includes('/values/')) body = {values:sheetRows};
    else throw new Error('Unexpected URL: ' + url);
    return { ok: true, json: async () => structuredClone(body) };
  };
  const start = () => startSheetsRollover(db, () => [{ type: 'biweekly', salesEnd: 5000, drawTime: 6000 }, { type: 'monthly', salesEnd: 3000, drawTime: 4000 }], { now: () => 1000, schedule: false, loadCatchupEntries,
    selectPeriods: (date, at) => ({raffles:['biweekly','monthly'].map(type=>({type,start:0,end:date ? Date.parse(type==='biweekly'?'2026-09-26T23:00:00Z':'2026-10-24T23:00:00Z')/1000 : at+1}))})
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    configureSheetsCoordinator(async operation => operation({}));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  return { start, calls, mutations, batches, sheetRows, completed, state: () => state, released: () => released };
}

test('ordinary export during hold reaches period-filtered writer without advancing archive', async t => {
  const f = await fixture(t);
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS = '4';
  const runtime = f.start();
  let written = false;
  await runtime.run(() => { written = true; }, { ordinaryWrite: true });
  assert.equal(written, true);
  assert.equal(f.state().pending.archiveId, null);
  assert.deepEqual(f.mutations, []);
});

test('archive replays source windows before copy and stops on database failure', async t => {
  let replayWindows;
  const f = await fixture(t, { loadCatchupEntries: async (now, windows) => {
    replayWindows = windows;
    throw Error('source replay unavailable');
  } });
  await assert.rejects(f.start().archive(), /source replay unavailable/);
  assert.deepEqual(replayWindows, f.state().windows);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.state().pending.archiveId, null);
});

test('late upload during hold writes once, excludes postcutoff deposits, and survives recovery before archive', async t => {
  const deposit = {type:'biweekly',eventId:'late',time:Date.parse('2026-09-26T22:59:59Z')/1000,amount:100001,ticketAmount:10,displayName:'Late depositor'};
  const after = {...deposit,eventId:'next-period',time:Date.parse('2026-09-26T23:00:01Z')/1000};
  const f = await fixture(t, {loadCatchupEntries:async (now, windows) => windows ? [deposit,after] : []});
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS = '4';
  const runtime = f.start();
  const completed = [];
  await syncBankingEntriesToGoogleSheets([deposit,after], {log:async()=>{},onCompleted:async ids=>completed.push(...ids)});
  assert.deepEqual(completed,['late']);
  assert.deepEqual(f.sheetRows.map(row=>row[0]),['late']);
  await f.start().archive();
  assert.deepEqual(f.mutations,['append','archive','verify','clear']);
  assert.equal(f.sheetRows.length,1,'prearchive replay confirms the existing ID instead of duplicating it');
  runtime.stop();
});

test('prearchive replay recovers database-only uploads before creating the copy', async t => {
  const entry={type:'biweekly',eventId:'db-only',time:Date.parse('2026-09-15T16:00:00Z')/1000,amount:100001,ticketAmount:10,displayName:'Recovered'};
  const f = await fixture(t,{loadCatchupEntries:async(now,windows)=>windows?[entry]:[]});
  await f.start().archive();
  assert.deepEqual(f.mutations,['append','archive','verify','clear']);
  assert.equal(f.sheetRows[0][0],'db-only');
  assert.deepEqual(f.completed,['db-only'],'confirmed source writes complete the durable export queue before reset');
});

test('failed prearchive Google replay neither completes queue entries nor copies or clears', async t => {
  const entry={type:'biweekly',eventId:'retry',time:Date.parse('2026-09-15T16:00:00Z')/1000,amount:100001,ticketAmount:10,displayName:'Retry'};
  const f = await fixture(t,{appendFailure:true,loadCatchupEntries:async()=>[entry,entry]});
  await assert.rejects(f.start().archive(),/Google append failed/);
  assert.deepEqual(f.completed,[]);
  assert.deepEqual(f.mutations,[]);
  assert.equal(f.state().pending.archiveId,null);
});

test('production clear empties both tabs and draw dates without archiving or changing database state', async t => {
  const f = await fixture(t);
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED = 'false';
  const before = structuredClone(f.state());
  await f.start().clear();
  assert.deepEqual(f.mutations, ['clear']); assert.deepEqual(f.state(), before);
  const dates = f.batches[0].filter(r => r.updateCells?.range.startRowIndex === 6);
  assert.deepEqual(dates.map(r => [r.updateCells.range.sheetId, r.updateCells.range.startColumnIndex]), [[7, 17], [8, 15]]);
  assert.ok(dates.every(r => r.updateCells.fields === 'userEnteredValue' && !r.updateCells.rows));
  assert.ok(f.batches[0].every(r => !r.createDeveloperMetadata && !r.deleteDeveloperMetadata));
});

test('hold blocks clear and exports but archive bypasses hold and rebuilds both tabs', async t => {
  const logs = [];
  const originalLog = console.log;
  console.log = line => logs.push(line);
  t.after(() => { console.log = originalLog; });
  const f = await fixture(t);
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS = '4';
  const runtime = f.start();
  await assert.rejects(runtime.run(() => assert.fail('must not export')), /hold/);
  assert.equal(f.state().pending.readyAt, 15400);
  await assert.rejects(runtime.clear(), /hold/);
  assert.deepEqual(f.calls, []);
  const result = await runtime.archive({ requestedBy: 'Officer' });
  assert.ok(logs.some(line => line.includes("Archiving as '260926 Raffle'")));
  assert.ok(logs.some(line => line.includes('Archive diagnostic \"bi-weekly raffle\" Q33: \"Alice\"')));
  assert.ok(logs.some(line => line.includes('Archive diagnostic \"bi-weekly raffle\" Q52: \"0\"')));
  assert.equal(result.requestedBy, 'Officer');
  assert.match(result.message, /archived by Officer/);
  assert.equal(result.archiveId, 'archive-copy');
  assert.equal(result.name, '260926 Raffle', 'use returned R7 name rather than runtime schedule');
  assert.equal(f.state().pending, null); assert.equal(f.state().catchupRequired, false);
  assert.ok(f.batches[0].some(r => r.updateCells?.range.sheetId === 7));
  assert.ok(f.batches[0].some(r => r.updateCells?.range.sheetId === 8));
});

test('failed catchup remains durable and retries without clearing again', async t => {
  let failed = true, replays = 0;
  const f = await fixture(t, { loadCatchupEntries: async (now, windows) => { if (windows) return []; replays++; if (failed) throw new Error('database unavailable'); return []; } });
  await assert.rejects(f.start().run(() => assert.fail('no export')), /database unavailable/);
  assert.equal(f.state().catchupRequired, true);
  assert.equal(f.state().completedArchives?.length || 0, 0);
  failed = false;
  const recovered = await f.start().archive();
  assert.equal(recovered.archiveId, 'archive-copy');
  assert.equal(replays, 2);
  assert.equal(f.mutations.filter(item => item === 'clear').length, 1);
  assert.equal(f.mutations.filter(item => item === 'archive').length, 1);
  assert.equal(f.state().catchupRequired, false);
  assert.equal(f.state().completedArchives.length, 1);
  assert.equal(f.state().completedArchives[0].archiveId, 'archive-copy');
});

test('archive still forces a newly due cutoff when previous catchup is incomplete', async t => {
  const f = await fixture(t);
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS = '4';
  f.state().catchupRequired = true;
  const result = await f.start().archive();
  assert.equal(result.archiveId, 'archive-copy');
  assert.equal(result.name, '260926 Raffle', 'use returned R7 name rather than runtime schedule');
  assert.equal(f.state().pending, null);
  assert.equal(f.state().catchupRequired, false);
  assert.equal(f.state().completedArchives.length, 1);
  assert.equal(f.state().completedArchives[0].archiveId, 'archive-copy');
});

test('next draw dates use Eastern dates in R7/P7 with mm/dd/yy format', () => {
  for (const [type, column] of [['biweekly', 17], ['monthly', 15]]) {
    const cell = drawDateRequest(7, type, Date.parse('2026-10-01T02:00:00Z') / 1000).updateCells;
    assert.equal(cell.range.startRowIndex, 6); assert.equal(cell.range.startColumnIndex, column);
    assert.equal(cell.rows[0].values[0].userEnteredValue.numberValue, Date.UTC(2026, 8, 30) / 86400000 + 25569);
    assert.equal(cell.rows[0].values[0].userEnteredFormat.numberFormat.pattern, 'mm/dd/yy');
  }
});

test('production archive outside hold copies immediately without advancing schedule', async t => {
  let replays = 0;
  const f = await fixture(t, { loadCatchupEntries: async () => { replays++; return []; } });
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED = 'false';
  process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS = '4';
  f.state().windows[0].salesEnd = 5000;
  const before = structuredClone(f.state().windows);
  const result = await f.start().archive();
  assert.equal(result.archiveId, 'archive-copy');
  assert.equal(result.name, '260926 Raffle', 'use returned R7 name rather than runtime schedule');
  assert.deepEqual(f.mutations, ['archive', 'verify', 'clear']);
  assert.deepEqual(f.state().windows, before);
  assert.deepEqual(f.state().lastClosedSalesEnd, {});
  assert.equal(replays, 2);
});

test('runtime verifies archive before clearing both tabs in original spreadsheet, then exports', async t => {
  const f = await fixture(t);
  const runtime = f.start();
  await runtime.run(async state => { assert.equal(state.lastClosedSalesEnd.biweekly, 1000); f.mutations.push('export'); });
  assert.deepEqual(f.mutations, ['archive', 'verify', 'clear', 'export']);
  assert.equal(f.state().pending, null);
  assert.equal(f.released(), 1);
  assert.ok(f.calls.filter(url => url.includes('sheets.googleapis.com')).every(url => url.includes('/original-source')));
});

test('archive copy failure blocks both clear and queued export and releases database lock', async t => {
  const f = await fixture(t, { copyFailure: true });
  await assert.rejects(f.start().run(() => f.mutations.push('export')), /403/);
  assert.deepEqual(f.mutations, ['archive']);
  assert.equal(f.state().pending.archiveId, null);
  assert.equal(f.released(), 1);
});

test('source ID returned as archive is rejected before any clear or export', async t => {
  const f = await fixture(t, { sourceAsCopy: true });
  await assert.rejects(f.start().run(() => f.mutations.push('export')), /verify/);
  assert.deepEqual(f.mutations, ['archive']);
});

test('restart after uncertain reset uses atomic marker and never clears twice', async t => {
  const f = await fixture(t, { uncertainClear: true });
  await assert.rejects(f.start().run(() => f.mutations.push('export')), /response lost/);
  assert.equal(f.state().pending.archiveId, 'archive-copy');
  await f.start().run(() => f.mutations.push('export'));
  assert.equal(f.mutations.filter(item => item === 'archive').length, 1);
  assert.equal(f.mutations.filter(item => item === 'clear').length, 1);
  assert.equal(f.mutations.filter(item => item === 'export').length, 1);
  assert.equal(f.state().pending, null);
  assert.equal(f.released(), 2);
});


test('archive succeeds without result metadata or snapshot database access', async t => {
  const f=await fixture(t,{snapshotFailure:true});
  await f.start().archive();
  assert.ok(f.mutations.includes('clear'));
  assert.equal(f.state().pending,null);
});
test('ongoing monthly results are not cleared during a biweekly reset', async t => {
  const f=await fixture(t);
  await f.start().archive();
  const requests=f.batches.flat().filter(item=>item.updateCells?.range.sheetId===8);
  assert.ok(!requests.some(item=>item.updateCells.range.startRowIndex===22 && item.updateCells.range.startColumnIndex===11));
  assert.ok(!requests.some(item=>item.updateCells.range.startRowIndex===25 && item.updateCells.range.startColumnIndex===9));
});


test('skipped monthly results are not saved or cleared, including uncertain-reset retry', async t=>{
 const f=await fixture(t,{skipMonthly:true,uncertainClear:true});
 await assert.rejects(f.start().archive(),/response lost/);
 await f.start().run();
 const requests=f.batches.flat().filter(item=>item.updateCells?.range?.sheetId===8);
 assert.ok(!requests.some(item=>[22,25].includes(item.updateCells.range.startRowIndex)));
 assert.equal(f.mutations.filter(item=>item==='clear').length,1);
});


test('archive cell save failure prevents clearing either working tab', async t => {
 const f = await fixture(t, {cellSaveFailure:true});
 await assert.rejects(f.start().archive(), /archive cell storage failed/);
 assert.ok(!f.mutations.includes('clear'));
 assert.equal(f.batches.length,0);
});


test('completed history replaces trashed archive references with the new archive', async t => {
 const f = await fixture(t, {replacedArchiveIds:['old-copy']});
 f.state().completedArchives = [{archiveId:'old-copy',name:'legacy name'},{archiveId:'unrelated',name:'other raffle'}];
 await f.start().archive();
 assert.ok(!f.state().completedArchives.some(item=>item.archiveId==='old-copy'));
 assert.ok(f.state().completedArchives.some(item=>item.archiveId==='archive-copy'));
 assert.ok(f.state().completedArchives.some(item=>item.archiveId==='unrelated'));
});

test('live rollover delay applies to future holds without moving an existing deadline',async t=>{const f=await fixture(t);process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS='4';const runtime=f.start();await assert.rejects(runtime.run(()=>{}),/hold/);assert.equal(f.state().pending.readyAt,15400);process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS='8';await assert.rejects(runtime.run(()=>{}),/hold/);assert.equal(f.state().pending.readyAt,15400);runtime.stop();});

test('ordinary upload queued behind a configuration disable skips both rollover and writes',async t=>{const f=await fixture(t);process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED='false';const runtime=f.start();let entered,release;const started=new Promise(r=>entered=r);const active=runtime.run(async()=>{entered();await new Promise(r=>release=r);},{processRollover:false});await started;const applying=runtime.applyConfiguration(()=>{process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED='false';});const upload=syncBankingEntriesToGoogleSheets([{type:'biweekly',eventId:'queued',name:'Test',gold:500,ticketAmount:1}],{log:async()=>{}});release();await Promise.all([active,applying]);const result=await upload;assert.equal(result.synced,0);assert.equal(result.enabled,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);runtime.stop();});
