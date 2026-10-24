import { resultRequests, resultClearRequests, readResultFormulas } from './raffle-results.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetRequests, drawDateRequest } from './raffle-sheet-layout.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const backendRoot = path.dirname(fileURLToPath(import.meta.url));
export async function exportLog(message) {
  const line = `${new Date().toISOString()} [GUILDSYNC-GOOGLE-SHEETS] ${message}`;
  console.log(line);
  const filename = path.resolve(backendRoot, process.env.GUILDSYNC_GOOGLE_SHEETS_LOG_FILE || 'logs/google-sheets.log');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.appendFile(filename, line + '\n');
}
const sheetRange = (tab, cells) => `'${tab.replace(/'/g, "''")}'!${cells}`;

export function config() {
  return {
    enabled: /^true$/i.test(String(process.env.GUILDSYNC_GOOGLE_SHEETS_ENABLED || '')),
    spreadsheetId: String(process.env.GUILDSYNC_GOOGLE_SHEETS_SPREADSHEET_ID || '').trim(),
    serviceAccountFile: String(process.env.GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_FILE || '').trim(),
    serviceAccountJson: String(process.env.GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_JSON || '').trim(),
    biweeklyTab: process.env.GUILDSYNC_GOOGLE_SHEETS_BIWEEKLY_TAB || 'bi-weekly raffle',
    fiftyFiftyTab: process.env.GUILDSYNC_GOOGLE_SHEETS_5050_TAB || '50/50',
    biweeklyStartRow: 5,
    fiftyFiftyStartRow: 5
  };
}

async function credentials(settings) {
  const raw = settings.serviceAccountJson || (settings.serviceAccountFile ? await fs.readFile(settings.serviceAccountFile, 'utf8') : '');
  if (!raw) throw new Error('Google Sheets is enabled but no service-account JSON or file was configured.');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }

async function accessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({ iss: account.client_email, scope: SHEETS_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${signer.sign(account.private_key, 'base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Google token request failed (${response.status}).`);
  const token = (await response.json()).access_token;
  if (!token) throw new Error('Google returned no access token.');
  return token;
}

export async function sheetsRequest(token, url, init = {}, log = exportLog) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!response.ok) {
    let detail = 'Google returned no structured error details.';
    try {
      const body = await response.json();
      detail = `${body.error?.status || ''}: ${body.error?.message || detail}`;
    } catch { /* A proxy may return a non-JSON error. */ }
    const endpoint = decodeURIComponent(new URL(url).pathname);
    const message = `Google Sheets ${init.method || 'GET'} ${endpoint} failed (${response.status}): ${detail}`;
    try { await log(message); } catch (error) { console.error(`Could not save Sheets error log: ${error.message}`); }
    throw new Error(message);
  }
  return response.json();
}

export async function googleContext(targetId) {
  const settings = config();
  if (targetId !== undefined) {
    if (typeof targetId !== 'string' || !targetId.trim()) throw Error('Invalid target spreadsheet ID.');
    settings.spreadsheetId = targetId;
  }
  const account = await credentials(settings);
  const token = await accessToken(account);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(settings.spreadsheetId)}`;
  return { settings, token, url };
}

let coordinate = async operation => operation({});
export function configureSheetsCoordinator(run) { coordinate = run; }
export function coordinateSpreadsheetOperation(operation) { return coordinate(operation, { processRollover: false }); }

// Called only by rollover while it already holds the export lock; never re-enter the queue.
export async function replayBankingEntries(entries, state, log = exportLog) {
  if (!entries.length) return { synced: 0 };
  return writeEntries(entries, '', state, log);
}

function tabFor(type, settings) { return type === 'biweekly' ? settings.biweeklyTab : type === 'monthly' ? settings.fiftyFiftyTab : ''; }
function sheetGoldAmount(amount) {
  const value = Number(amount) || 0;
  const marker = Math.abs(Math.trunc(value)) % 10;
  return marker === 1 || marker === 3 ? (value > marker ? value - marker : value) : value;
}
function easternTimestamp() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.month}/${value.day}/${value.year} ${value.hour}:${value.minute}${value.dayPeriod.toLowerCase()} ET`;
}

export async function syncBankingEntriesToGoogleSheets(entries, { log = exportLog, uploadedBy = '', onCompleted = async () => {} } = {}) {
  const settings = config();
  entries = (entries || []).filter(entry => tabFor(entry.type, settings));
  if (!settings.enabled || !entries.length) return { enabled: settings.enabled, synced: 0 };
  return coordinate(async state => {
    if(!config().enabled)return {enabled:false,synced:0};
    try {
      return await writeEntries(entries, uploadedBy, state, log, {onCompleted});
    } catch (error) {
      await log('Export stopped: ' + error.message);
      throw error;
    }
  }, { ordinaryWrite:true });
}

export function entryLayout(entry) {
  const donation = entry.ticketAmount != null && Number(entry.ticketAmount) === 0;
  return donation
    ? entry.type === 'biweekly'
      ? { donation, first: 62, last: 70, id: 'P', name: 'Q', gold: 'R', index: 15 }
      : { donation, first: 36, last: 44, id: 'N', name: 'O', gold: 'P', index: 13 }
    : { donation, first: 5, last: 254, id: 'D', name: 'E', gold: 'F', index: 3 };
}

export async function refreshBankingEntriesToGoogleSheets(loadSnapshot, { uploadedBy = '', log = exportLog, saveTemplates = async () => {}, processRollover = true, onComplete = async () => {} } = {}) {
  if (!config().enabled) throw new Error('Enable Google Sheets on the backend first.');
  return coordinate(async state => {
    const snapshot = await loadSnapshot();
    const { entries, periods, results = {}, templates = {}, targetId } = snapshot;
    if (!Array.isArray(entries) || !Array.isArray(periods) || periods.length !== 2 ||
        ['biweekly', 'monthly'].some(type => periods.filter(period => period.type === type && Number.isSafeInteger(period.end)).length !== 1)) {
      throw new Error('Refresh requires both selected raffle periods and their draw dates.');
    }
    const result = await writeEntries(entries, uploadedBy, state, log, {replace:true,includeClosed:false,periods,results,templates,saveTemplates,targetId});
    await onComplete(snapshot);
    return result;
  }, { processRollover });
}

function attributionRequest(sheetId, type, uploadedBy) {
  const attribution = String(uploadedBy || '').trim();
  return { updateCells: {
    start: { sheetId, rowIndex: 2, columnIndex: type === 'biweekly' ? 17 : 15 },
    rows: [{ values: [{ userEnteredValue: { stringValue: attribution ? attribution + ' (GuildSync)' : 'GuildSync' } }] },
      { values: [{ userEnteredValue: { stringValue: easternTimestamp() } }] }],
    fields: 'userEnteredValue'
  } };
}

async function writeEntries(entries, uploadedBy, state, log, {replace = false, includeClosed = false, periods = [], results = {}, templates = {}, saveTemplates = async () => {}, targetId, onCompleted = async () => {}} = {}) {
  const { settings, token, url } = await googleContext(targetId);
  if (!settings.spreadsheetId) throw new Error('Google spreadsheet ID is missing.');
  await log('Starting spreadsheet update: entries=' + entries.length);
  const info = await sheetsRequest(token, url + '?fields=sheets.properties');
  let synced = 0;
  const sections = new Map();
  const sheetPeriods = new Map();
  let deferred = 0;
  let pending = [];
  let preparation = [];
  if (replace) {
    const formulas = await readResultFormulas(sheetsRequest, token, url, settings);
    await saveTemplates(formulas);
    for (const type of ['biweekly', 'monthly']) {
      const tab = tabFor(type, settings);
      const sheet = info.sheets?.find(item => item.properties.title === tab)?.properties;
      if (!sheet || sheet.gridProperties.rowCount < 254 || sheet.gridProperties.columnCount < (type === 'biweekly' ? 19 : 16)) {
        throw new Error('Missing worksheet or grid too small for refresh: ' + tab);
      }
      preparation.push(
        ...resetRequests(sheet.sheetId, type, '').filter(request => request.updateCells || request.updateDimensionProperties),
        ...resultClearRequests(sheet.sheetId, type),
        ...resultRequests(sheet.sheetId, type, templates[type] || [], true),
        ...resultRequests(sheet.sheetId, type, formulas[type], true),
        ...resultRequests(sheet.sheetId, type, results[type] || []),
        drawDateRequest(sheet.sheetId, type, periods.find(period => period.type === type).end),
        { updateDimensionProperties: { range: { sheetId: sheet.sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 8 },
          properties: { hiddenByUser: !entries.some(entry => entry.type === type && entry.bonusEnabled === true) }, fields: 'hiddenByUser' } },
        attributionRequest(sheet.sheetId, type, uploadedBy)
      );
      await log('Refreshing ' + JSON.stringify(tab) + ': clearing closure fields and replacing selected-period entries and draw date.');
    }
  }
  const flush = async () => {
    if (!pending.length && !preparation.length) return;
    await log('Writing batch: entries=' + pending.length);
    await sheetsRequest(token, url + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [...preparation, ...pending.flatMap(item => item.requests)] }) });
    preparation = [];
    await log('Spreadsheet update completed: entries=' + pending.length);
    synced += pending.length;
    await onCompleted(pending.map(item => String(item.eventId)));
    pending = [];
  };
  for (const entry of entries) {
    if (!entry.eventId) continue;
    const tab = tabFor(entry.type, settings);
    if (!replace && !includeClosed) {
      if (!sheetPeriods.has(entry.type)) {
        const address = entry.type === 'biweekly' ? 'R7' : 'P7';
        const data = await sheetsRequest(token, url + '/values/' + encodeURIComponent(sheetRange(tab, address)) + '?valueRenderOption=FORMATTED_VALUE');
        const display = String(data.values?.[0]?.[0] || '').trim();
        const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(display);
        let period = null;
        if (match) {
          const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
          const date = new Date(Date.UTC(year, Number(match[1])-1, Number(match[2])));
          if (date.getUTCFullYear() === year && date.getUTCMonth()+1 === Number(match[1]) && date.getUTCDate() === Number(match[2])) {
            period = date.toISOString().slice(0, 10);
          }
        }
        sheetPeriods.set(entry.type, period);
        if (!period) await log('No valid draw date for ' + JSON.stringify(tab) + '; entries retained in the database.');
      }
      const period = sheetPeriods.get(entry.type);
      const time = entry.time == null || entry.time === '' ? NaN : Number(entry.time);
      if (!period || !Number.isFinite(time) || time <= 0) { deferred++; continue; }
      // Share the sales boundaries used by database reports and archive catchup.
      const { getAssociateTicketReportRaffleWindow } = await import('./guildsync-database-actions.js');
      const assigned = getAssociateTicketReportRaffleWindow(entry);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(assigned.raffleTime * 1000));
      const value = key => parts.find(item => item.type === key).value;
      if (value('year') + '-' + value('month') + '-' + value('day') !== period) { deferred++; continue; }
    }
    const sheet = info.sheets?.find(item => item.properties.title === tab)?.properties;
    if (!sheet) throw new Error('Worksheet not found: ' + tab);
    const layout = entryLayout(entry);
    if (sheet.gridProperties.rowCount < layout.last || sheet.gridProperties.columnCount < layout.index + 3) {
      throw new Error('Worksheet grid is too small for ' + tab + ' ' + layout.id + layout.first + ':' + layout.gold + layout.last);
    }
    const range = sheetRange(tab, layout.id + layout.first + ':' + layout.gold + layout.last);
    if (!sections.has(range)) {
      const existing = replace ? {} : await sheetsRequest(token, url + '/values/' + encodeURIComponent(range) + '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE');
      sections.set(range, existing.values || []);
    }
    const rows = sections.get(range);
    if (rows.some(row => String(row[0] ?? '') === String(entry.eventId))) {
      await log('Duplicate skipped: ' + entry.eventId);
      // A duplicate reserved in this not-yet-written batch is not durable yet.
      if (!pending.some(item => String(item.eventId) === String(entry.eventId))) await onCompleted([String(entry.eventId)]);
      continue;
    }
    // A row is reusable only when both transaction ID and member name are blank.
    const offset = Array.from({ length: layout.last - layout.first + 1 }, (_, i) => i)
      .find(i => !String(rows[i]?.[0] ?? '').trim() && !String(rows[i]?.[1] ?? '').trim());
    if (offset === undefined) throw new Error('No empty row in ' + range + '; entry ' + entry.eventId + ' was not exported.');
    const row = layout.first + offset;
    let name = String(entry.displayName || '');
    if (/^manual/i.test(String(entry.dataSource || '')) && String(entry.note || '').trim()) name += ' (' + String(entry.note).trim() + ')';
    const manual = /^manual/i.test(String(entry.dataSource || ''));
    const bonusEnabled = entry.bonusEnabled === true;
    const bonusTickets = manual ? 0 : Math.max(0, Math.floor(Number(entry.bonusTickets) || 0));
    const bonusPercent = manual ? 0 : Number(entry.bonusPercent) || 0;
    const values = [
      { userEnteredValue: { stringValue: String(entry.eventId) } },
      { userEnteredValue: { stringValue: name } },
      { userEnteredValue: { numberValue: sheetGoldAmount(entry.amount) } }
    ];
    const requests = [{
      updateCells: { start: { sheetId: sheet.sheetId, rowIndex: row - 1, columnIndex: layout.index },
        rows: [{ values }], fields: 'userEnteredValue' }
    }];
    if (!layout.donation) {
      requests.push({ updateCells: {
        range: { sheetId: sheet.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 7, endColumnIndex: 8 },
        rows: [{ values: [bonusEnabled
          ? { userEnteredValue: { numberValue: bonusTickets }, note: 'Bonus: ' + bonusPercent + '%' }
          : {}] }], fields: 'userEnteredValue,note'
      } });
      if (!replace && bonusEnabled) requests.push({ updateDimensionProperties: {
        range: { sheetId: sheet.sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 8 },
        properties: { hiddenByUser: false }, fields: 'hiddenByUser'
      } });
      else if (!replace) {
        requests.push({ updateCells: {
          range: { sheetId: sheet.sheetId, startRowIndex: 4, endRowIndex: 254, startColumnIndex: 7, endColumnIndex: 8 },
          fields: 'userEnteredValue,note'
        } });
        requests.push({ updateDimensionProperties: {
          range: { sheetId: sheet.sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 8 },
          properties: { hiddenByUser: true }, fields: 'hiddenByUser'
        } });
      }
    }
    if (!replace) requests.push(attributionRequest(sheet.sheetId, entry.type, uploadedBy));
    // Reserve the row locally; bulk replay reads each section only once and
    // batches writes to stay below per-user Sheets API quotas.
    rows[offset] = [String(entry.eventId), name, sheetGoldAmount(entry.amount)];
    pending.push({ requests, eventId: entry.eventId, tab, row });
    // A replacement must clear and repopulate both tabs atomically, after all
    // capacity checks succeed. Live append exports keep their existing batching.
    if (!replace && pending.length >= 25) await flush();
  }
  await flush();
  if (deferred) await log('Entries retained in the database outside the displayed raffle period: entries=' + deferred);
  return { enabled: true, synced };
}

export function googleSheetsBankingConfig() { return config(); }

