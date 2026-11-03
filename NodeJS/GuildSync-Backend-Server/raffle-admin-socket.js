import {hasRaffleAdminRole} from './raffle-permissions.js';
import { loadArchiveCells } from './raffle-archive-cells.js';
import { formatArchiveMessage } from './raffle-archive-message.js';
import { loadRaffleResults, loadFormulaTemplates, saveFormulaTemplates } from './raffle-results.js';
import { refreshBankingEntriesToGoogleSheets, googleSheetsBankingConfig, exportLog, coordinateSpreadsheetOperation } from './google-sheets-banking-sync.js';

export async function isRaffleAdministrator(db, discordUserId, env = process.env) {
  if (typeof discordUserId !== 'string' || !discordUserId) return false;
  const [rows] = await db.execute(`SELECT r.role_id, r.role_name FROM discord_member_roles m
    JOIN discord_roles r ON r.role_id = m.role_id WHERE m.discord_id = ?`, [discordUserId]);
  return hasRaffleAdminRole(rows, env);
}

// Compatibility for existing integrations; the configured policy applies.
export const isConsigliere = isRaffleAdministrator;

export function entriesForRafflePeriods(entries, periods, asOf) {
  return entries.filter(entry => periods.some(period => entry.type === period.type &&
    Number(entry.time) >= period.start && Number(entry.time) < period.end && Number(entry.time) <= asOf))
    .sort((a, b) => Number(a.time) - Number(b.time) || String(a.eventId).localeCompare(String(b.eventId)));
}

export function registerRaffleRefreshSocket(socket, db, { getRaffleRefreshSelection, getBankingDataJSON,
  authorize = isRaffleAdministrator, refreshEntries = refreshBankingEntriesToGoogleSheets, log = exportLog, loadResults = loadArchiveCells, loadTemplates = loadFormulaTemplates, historical, coordinate = coordinateSpreadsheetOperation }) {
  let running = false;
  socket.on('guildsync:raffle-refresh', async (payload = {}, callback) => {
    if (typeof callback !== 'function') return;
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType !== 'discord-bot') {
      callback({ ok: false, message: 'Discord bot authentication is required.' }); return;
    }
    if (running) { callback({ ok: false, message: 'A raffle refresh is already running. Please wait for it to finish.' }); return; }
    running = true;
    try {
      if (!await authorize(db, payload.discordUserId)) throw new Error('An authorized raffle administrator role is required. Check role configuration and Discord synchronization.');
      if (!['plan', 'export', 'update', 'save'].includes(payload.action)) throw new Error('Unknown raffle refresh action.');
      if (['update','save'].includes(payload.action) && typeof payload.date !== 'string') throw Error('Update requires a raffle date in MMDDYY format.');
      let selection = getRaffleRefreshSelection(payload.date, undefined, payload.boundaryChoices);
      if (payload.action === 'plan') { callback({ ok: true, selection }); return; }
      if (selection.dateNormalization?.requiresConfirmation) throw Error('Confirm the interpreted date first, then submit its zero-padded MMDDYY value.');
      if (selection.dateNormalization) payload.date = selection.dateNormalization.value;
      if (selection.boundaryTypes?.some(type => !['starts','ends'].includes(payload.boundaryChoices?.[type]))) throw Error('Choose whether the boundary raffle starts or ends on this date before loading or updating.');
      const requestedBy = String(payload.requestedBy || '').trim().slice(0, 100);
      if (!requestedBy) throw new Error('The initiating Discord display name is required.');
      if (['update','save'].includes(payload.action)) {
        if (!historical) throw Error('Historical archive service is unavailable.');
        const result = await coordinate(async () => {
          selection = getRaffleRefreshSelection(payload.date, undefined, payload.boundaryChoices);
          await log('UPDATE requested by ' + JSON.stringify(requestedBy) + ': ' + JSON.stringify(selection));
          return historical.save(selection);
        });
        callback({ok:true,selection,saved:result.saved,sheetUrl:result.sheetUrl,historical:true,archiveLookup:result.archiveLookup});
        return;
      }
      let target;
      const result = await refreshEntries(async () => {
        selection = getRaffleRefreshSelection(payload.date, undefined, payload.boundaryChoices);
        await log('REFRESH requested by ' + JSON.stringify(requestedBy) + ': ' + JSON.stringify(selection));
        target = historical ? await historical.prepare(selection,payload.date) : {spreadsheetId:googleSheetsBankingConfig().spreadsheetId,historical:false};
        return { entries: entriesForRafflePeriods(await getBankingDataJSON(db), selection.raffles, selection.asOf), periods: selection.raffles, targetId:target.spreadsheetId,
          results: target.results ?? await loadResults(db, selection.raffles, googleSheetsBankingConfig().spreadsheetId), templates: await loadTemplates(db, googleSheetsBankingConfig().spreadsheetId) };
      }, { uploadedBy: requestedBy, processRollover:payload.date===undefined,
        saveTemplates: formulas => target?.historical ? Promise.resolve() : saveFormulaTemplates(db, formulas, googleSheetsBankingConfig().spreadsheetId),
        onComplete:()=>historical?.complete(selection,target) });
      callback({ ok: true, selection, synced: result.synced,
        historical:target?.historical || false, sheetUrl:target?.sheetUrl, archiveLookup:target?.archiveLookup,
        workingSheetUrl: target?.historical ? undefined : 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(googleSheetsBankingConfig().spreadsheetId) + '/edit' });
    } catch (error) {
      await log('REFRESH failed: ' + error.message).catch(console.error);
      callback({ ok: false, message: 'Raffle refresh failed: ' + error.message });
    } finally { running = false; }
  });
}

export function registerRaffleManagementSocket(socket, db, { sheets, authorize = isRaffleAdministrator, log = exportLog }) {
  let running = false;
  socket.on('guildsync:raffle-manage', async (payload = {}, callback) => {
    if (typeof callback !== 'function') return;
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType !== 'discord-bot') return callback({ ok: false, message: 'Discord bot authentication is required.' });
    if (running) return callback({ ok: false, message: 'A raffle operation is already running.' });
    running = true;
    try {
      if (!await authorize(db, payload.discordUserId)) throw new Error('An authorized raffle administrator role is required to manage raffle sheets.');
      if (!['clear', 'archive'].includes(payload.action)) throw new Error('Unknown raffle action.');
      if (!googleSheetsBankingConfig().enabled || !sheets) throw new Error('Enable Google Sheets on the backend first.');
      const requestedBy = String(payload.requestedBy || '').trim().slice(0, 100);
      if (!requestedBy) throw new Error('The initiating Discord display name is required.');
      await log(payload.action.toUpperCase() + ' requested by ' + JSON.stringify(requestedBy) + ' for both raffle sheets.');
      if (payload.action === 'clear') {
        await sheets.clear();
        callback({ ok: true, message: 'Cleared both raffle sheets, including Bi-Weekly R7 and 50/50 P7 draw dates. Database records are unchanged. Use /gsr load to reload them.' });
      } else {
        const result = await sheets.archive({ requestedBy });
        callback({ ok: true, message: result.message || formatArchiveMessage({ ...result, requestedBy, sourceId: googleSheetsBankingConfig().spreadsheetId }) });
      }
    } catch (error) {
      await log('Raffle operation failed: ' + error.message).catch(console.error);
      callback({ ok: false, message: error.message });
    } finally { running = false; }
  });
}
