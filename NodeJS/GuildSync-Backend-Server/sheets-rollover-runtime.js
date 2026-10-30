import { saveArchiveCells } from './raffle-archive-cells.js';
import { formatArchiveMessage } from './raffle-archive-message.js';
import { saveFormulaTemplates, loadFormulaTemplates, readResultFormulas, resultClearRequests, resultRequests } from './raffle-results.js';
import { resetRequests, drawDateRequest } from './raffle-sheet-layout.js';
import { createHash } from 'node:crypto';
import { requestArchive } from './apps-script-archive.js';
import { createRollover } from './raffle-sheet-rollover.js';
import { normalizeScheduledSalesEnd } from './raffle-schedule.js';
import { createSheetsExportStore } from './sheets-export-queue.js';
import { config, googleContext, sheetsRequest, configureSheetsCoordinator, replayBankingEntries, exportLog } from './google-sheets-banking-sync.js';

const MARKER = 'guildsync_last_rollover';

export { resetRequests, drawDateRequest } from './raffle-sheet-layout.js';

export function startSheetsRollover(db, getWindows, { now, schedule = true, loadCatchupEntries, selectPeriods } = {}) {
  const settings = config();
  if (!settings.spreadsheetId) return;
  const rolloverEnabled = () => /^true$/i.test(process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED || 'false');
  const hours = Number(String(process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS ?? '').trim() || 4);
  if (!Number.isFinite(hours) || hours < 0 || !Number.isSafeInteger(hours * 3600)) throw new Error('Invalid rollover delay hours.');
  const hash = createHash('sha256').update(settings.spreadsheetId).digest('hex').slice(0, 32);
  const stateKey = 'sheets_rollover_' + hash;
  let connection;
  let context;
  const contextNow = async () => context ||= await googleContext();
  const tabFor = type => type === 'biweekly' ? settings.biweeklyTab : settings.fiftyFiftyTab;
  const io = {
    normalizeWindow: window => {
      const salesEnd = normalizeScheduledSalesEnd(window.salesEnd);
      return {...window, salesEnd, drawTime:window.drawTime + salesEnd - window.salesEnd};
    },
    now,
    delaySeconds: hours * 3600,
    getDelaySeconds: () => Number(process.env.GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS || 4) * 3600,
    getWindows,
    loadState: async () => {
      const [rows] = await connection.execute('SELECT value FROM guildsync_settings WHERE setting_key = ?', [stateKey]);
      const state = rows.length ? JSON.parse(rows[0].value) : null;
      if (state?.tabs && JSON.stringify(state.tabs) !== JSON.stringify([settings.biweeklyTab, settings.fiftyFiftyTab])) throw new Error('Rollover tab configuration changed; restore it before continuing.');
      return state;
    },
    saveState: async state => {
      state.tabs = [settings.biweeklyTab, settings.fiftyFiftyTab];
      await connection.execute('INSERT INTO guildsync_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [stateKey, JSON.stringify(state)]);
    },
    archive: async ({ key, name, windows }) => {
      // Recover deposits uploaded during the hold before freezing the source copy.
      // Use persisted source periods: wall-clock windows already advanced at cutoff.
      if (!loadCatchupEntries) throw new Error('Prearchive catchup loader is unavailable; archive remains paused.');
      const entries = await loadCatchupEntries(Math.floor(now ? now() : Date.now() / 1000), windows);
      await replayBankingEntries(entries, { windows }, exportLog, {
        onCompleted: ids => createSheetsExportStore(connection).completed(ids, settings.spreadsheetId)
      });
      const archive = await requestArchive('archive', { sourceId: settings.spreadsheetId, key: hash + ':' + key, name,
        biweeklyTab: settings.biweeklyTab, fiftyFiftyTab: settings.fiftyFiftyTab, details: true });
      await exportLog("Archiving as '" + archive.name + "'");
      return archive;
    },
    reset: async ({ key, archiveId, raffles, nextWindows }) => {
      const verified = await requestArchive('verify', { sourceId: settings.spreadsheetId, key: hash + ':' + key, archiveId,
        biweeklyTab: settings.biweeklyTab, fiftyFiftyTab: settings.fiftyFiftyTab, details: true });
      const savedCells = await saveArchiveCells(connection, verified, archiveId, settings.spreadsheetId, settings);
      await exportLog('Saved archive cells to guildsync_raffle_archive_cells: cells=' + savedCells);
      for (const item of verified.diagnosticCells || []) {
        if ((/^(?:Q(?:3[3-9]|4[0-9]|5[0-2])|[JK](?:[5-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])|O55)$/.test(item.cell) && (!item.tab || item.tab === settings.biweeklyTab) || /^(?:P25|M28)$/.test(item.cell) && item.tab === settings.fiftyFiftyTab) && item.value != null && String(item.value).length > 0) {
          await exportLog('Archive diagnostic ' + (item.tab ? JSON.stringify(item.tab) + ' ' : '') + item.cell + ': ' + JSON.stringify(item.value));
        }
      }
      const { token, url } = await contextNow();
      const book = await sheetsRequest(token, url + '?fields=sheets(properties,developerMetadata)');
      const requests = [];
      for (const raffle of raffles) {
        const tab = book.sheets?.find(item => item.properties.title === tabFor(raffle.type));
        if (!tab) throw new Error('Missing rollover tab: ' + tabFor(raffle.type));
        const sheet = tab.properties;
        const metadata = (tab.developerMetadata || []).filter(item => item.metadataKey === MARKER && item.location?.sheetId === sheet.sheetId);
        if (metadata.some(item => item.metadataValue === key)) continue;
        requests.push(...resetRequests(sheet.sheetId, raffle.type, key, metadata));
        const next = nextWindows?.find(item => item.type === raffle.type);
        if (next) requests.push(drawDateRequest(sheet.sheetId, raffle.type, next.drawTime));
      }
      if (requests.length) {
        await exportLog('Resetting both raffle tabs after archive ' + archiveId + ': ' + raffles.map(item => tabFor(item.type)).join(', '));
        // Clear and completion markers are atomic: an uncertain HTTP response cannot cause a second clear.
        await sheetsRequest(token, url + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
      }
      return { replacedArchiveIds: verified.replacedArchiveIds || [] };
    },
    log: exportLog
  };
  const coordinator = createRollover(io);

  // One local queue plus a MariaDB advisory lock coordinates all backend instances.
  let tail = Promise.resolve();
  const run = (operation, { processRollover = true, archiveNow = false, requestedBy, ordinaryWrite = false } = {}) => {
    const job = tail.then(async () => {
      if(ordinaryWrite && !config().enabled)return {enabled:false,synced:0};
      const conn = await db.getConnection();
      let locked = false;
      try {
        const [rows] = await conn.execute('SELECT GET_LOCK(?, 10) AS acquired', ['guildsync_sheet_' + hash]);
        if (Number(rows[0]?.acquired) !== 1) throw new Error('Could not acquire spreadsheet export lock.');
        locked = true; connection = conn; context = null;
        const savedState = await io.loadState();
        const enabled = rolloverEnabled();
        const advance = (enabled && processRollover) || archiveNow || (processRollover && savedState?.pending?.manual);
        const due = savedState?.pending || savedState?.windows?.some(window => window.salesEnd <= Math.floor(now ? now() : Date.now() / 1000));
        const state = advance ? await coordinator.tick({ requestedBy, archiveNow: archiveNow && (!savedState?.catchupRequired || !!due) }) : (savedState || {});
        const awaitingCopy = ordinaryWrite && state.pending && !state.pending.archiveId;
        if ((state.pending && !awaitingCopy) || (!processRollover && !archiveNow && state.catchupRequired) || (!processRollover && enabled && state.windows?.some(window => window.salesEnd <= Math.floor(now ? now() : Date.now() / 1000)))) {
          throw new Error('Spreadsheet writes are on hold until delayed archive/reset completes. Banking records remain in the database.');
        }
        if ((advance || processRollover) && state.catchupRequired) {
          if (!loadCatchupEntries) throw new Error('Rollover catchup loader is unavailable; writes remain paused.');
          const entries = await loadCatchupEntries(Math.floor(now ? now() : Date.now() / 1000));
          await replayBankingEntries(entries, state);
          state.catchupRequired = false;
          state.completedArchives ||= [];
          const replaced = state.replacedArchiveIdsPending || state.lastArchive?.replacedArchiveIds || [];
          state.completedArchives = state.completedArchives.filter(item => !replaced.includes(item.archiveId));
          state.replacedArchiveIdsPending = [];
          if (state.lastArchive && !state.completedArchives.some(item => item.archiveId === state.lastArchive.archiveId)) {
            state.completedArchives = state.completedArchives.filter(item => item.name !== state.lastArchive.name);
            state.lastArchive.sourceId = settings.spreadsheetId;
            state.lastArchive.message = formatArchiveMessage(state.lastArchive);
            state.completedArchives.push({ ...state.lastArchive, completedAt: Math.floor(now ? now() : Date.now() / 1000) });
          }
          await io.saveState(state);
          await exportLog('Rollover database catchup completed; spreadsheet writes resumed.');
        }
        return operation ? await operation(state) : state;
      } finally {
        try {
          if (locked) await conn.execute('SELECT RELEASE_LOCK(?)', ['guildsync_sheet_' + hash]);
        } finally {
          conn.release(); connection = null; context = null;
        }
      }
    });
    tail = job.catch(() => {});
    return job;
  };
  const applyConfiguration=fn=>{const job=tail.then(fn);tail=job.catch(()=>{});return job;};
  configureSheetsCoordinator(run);
  const archive = ({ requestedBy } = {}) => run(state => state.lastArchive, { archiveNow: true, requestedBy });
  const clear = () => run(async () => {
    const { token, url } = await googleContext();
    const book = await sheetsRequest(token, url + '?fields=sheets.properties');
    const requests = [];
    const templates = await loadFormulaTemplates(connection, settings.spreadsheetId);
    const formulas = await readResultFormulas(sheetsRequest, token, url, settings);
    await saveFormulaTemplates(connection, formulas, settings.spreadsheetId);
    for (const type of ['biweekly', 'monthly']) {
      const tab = book.sheets?.find(item => item.properties.title === tabFor(type));
      if (!tab) throw new Error('Missing raffle tab: ' + tabFor(type));
      requests.push(...resetRequests(tab.properties.sheetId, type, '').filter(request => request.updateCells || request.updateDimensionProperties));
      requests.push(...resultClearRequests(tab.properties.sheetId, type), ...resultRequests(tab.properties.sheetId, type, templates[type], true), ...resultRequests(tab.properties.sheetId, type, formulas[type], true));
      const column = type === 'biweekly' ? 17 : 15;
      requests.push({ updateCells: { range: { sheetId: tab.properties.sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: column, endColumnIndex: column + 1 }, fields: 'userEnteredValue' } });
    }
    await exportLog('CLEAR: clearing both raffle worksheets including R7/P7 draw dates; database records unchanged.');
    await sheetsRequest(token, url + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }, { processRollover: false });
  if (!schedule) return { run, archive, clear, applyConfiguration, stop: () => {} };
  const tick = () => {if(!config().enabled || !rolloverEnabled())return;return run().catch(error => exportLog('Rollover failed; export/reset paused: ' + error.message).catch(console.error));};
  const timer = setInterval(tick, 60000); timer.unref();
  tick();
  return { run, archive, clear, applyConfiguration, stop: () => clearInterval(timer) };
}
