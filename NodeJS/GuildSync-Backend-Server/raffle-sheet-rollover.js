import { randomUUID } from 'node:crypto';
const TYPES = ['biweekly', 'monthly'];

function validateWindows(windows, after = -Infinity) {
  if (!Array.isArray(windows) || windows.length !== TYPES.length ||
      TYPES.some((type) => windows.filter((window) => window.type === type).length !== 1) ||
      windows.some((window) => !Number.isSafeInteger(window.salesEnd) || window.salesEnd <= after ||
        !Number.isSafeInteger(window.drawTime))) {
    throw new Error('Invalid or nonadvancing raffle rollover schedule');
  }
  return windows.map(({ type, salesEnd, drawTime }) => ({ type, salesEnd, drawTime }));
}

function archiveName(drawTime) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(drawTime * 1000));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}${part('month')}${part('day')} raffle`;
}

/**
 * All timestamps are Unix seconds. The caller must hold its distributed lock
 * across tick(), archive(), and reset(). Archive reconciles copies by key;
 * reset atomically records that key with the source-sheet reset, making retries safe.
 * State is bound by the caller to the configured source spreadsheet.
 */
export function createRollover({ loadState, saveState, getWindows, archive, reset,
  delaySeconds = 0, getDelaySeconds = () => delaySeconds, now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0) throw new Error('Invalid rollover delay');
  return {
    async tick({ archiveNow = false, requestedBy } = {}) {
      const timestamp = Math.floor(now());
      if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid rollover time');
      let state = structuredClone(await loadState());
      if (state == null) {
        state = { version: 1, windows: validateWindows(getWindows(timestamp + 1), timestamp),
          lastClosedSalesEnd: {}, pending: null };
        await saveState(structuredClone(state));
        if (!archiveNow) return state;
      }
      if (state.version !== 1 || !state.lastClosedSalesEnd) throw new Error('Invalid rollover state');
      validateWindows(state.windows);
      // Limit work per tick after unusually long outages; remaining work stays durable.
      for (let count = 0; count < 100; count += 1) {
        if (!state.pending) {
          const cutoff = Math.min(...state.windows.map((window) => window.salesEnd));
          if (cutoff > timestamp && !archiveNow) return state;
          const manual = cutoff > timestamp;
          const raffles = state.windows.filter((window) => window.salesEnd === cutoff);
          const following = manual ? state.windows : validateWindows(getWindows(cutoff + 1), cutoff);
          const holdDelay = getDelaySeconds();
          if(!Number.isSafeInteger(holdDelay)||holdDelay<0)throw Error('Invalid rollover delay');
          state.pending = {
            key: manual ? `raffle-manual-${randomUUID()}` : `raffle-rollover-${cutoff}`, salesEnd: cutoff,
            requestedBy: archiveNow ? requestedBy : undefined, manual, readyAt: manual ? timestamp : cutoff + holdDelay,
            name: archiveName(Math.min(...raffles.map((window) => window.drawTime))),
            raffles, archiveId: null,
            nextWindows: state.windows.map((window) => !manual && window.salesEnd === cutoff
              ? following.find((next) => next.type === window.type) : window),
          };
          await saveState(structuredClone(state));
        }
        const job = state.pending;
        if (archiveNow && requestedBy && !job.requestedBy) {
          job.requestedBy = requestedBy;
          await saveState(structuredClone(state));
        }
        // Legacy pending jobs have already begun; do not delay their recovery.
        if (!archiveNow && job.readyAt != null && timestamp < job.readyAt) return state;
        archiveNow = false;
        if (!job.archiveId) {
          const archived = await archive({ key: job.key, name: job.name, raffles: structuredClone(job.raffles), windows: structuredClone(state.windows) });
          const archiveId = typeof archived === 'string' ? archived : archived?.archiveId;
          if (typeof archived === 'object' && archived.name) job.name = archived.name;
          if (typeof archived === 'object') job.replacedArchiveIds = archived.replacedArchiveIds || [];
          if (typeof archiveId !== 'string' || !archiveId.trim()) throw new Error('Archive did not return a verified copy ID');
          job.archiveId = archiveId;
          await saveState(structuredClone(state));
        }
        const resetResult = await reset({ key: job.key, archiveId: job.archiveId, raffles: structuredClone(job.nextWindows), nextWindows: structuredClone(job.nextWindows) });
        job.replacedArchiveIds = [...new Set([...(job.replacedArchiveIds || []), ...(resetResult?.replacedArchiveIds || [])])];
        if (!job.manual) for (const raffle of job.raffles) state.lastClosedSalesEnd[raffle.type] = raffle.salesEnd;
        state.replacedArchiveIdsPending = [...new Set([...(state.replacedArchiveIdsPending || []), ...(job.replacedArchiveIds || [])])];
        state.lastArchive = { archiveId: job.archiveId, name: job.name, requestedBy: job.requestedBy, replacedArchiveIds: job.replacedArchiveIds || [] };
        state.windows = job.nextWindows;
        state.pending = null;
        state.catchupRequired = true;
        await saveState(structuredClone(state));
        await log(`Raffle spreadsheet rollover completed: ${job.key} (${job.archiveId})`);
      }
      if (state.windows.some(window => window.salesEnd <= timestamp)) {
        throw new Error('Rollover catchup limit reached; exports paused until remaining cutoffs finish');
      }
      return state;
    },
  };
}
