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
  normalizeWindow = window => window,
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
      // Keep recovery payloads immutable once copying may have begun. Normalization
      // is idempotent and only applies to armed windows or dated automatic holds.
      const normalized = windows => validateWindows(windows.map(window => normalizeWindow({ ...window })));
      const pending = state.pending;
      if (pending && !pending.manual && !pending.archiveId && Number.isFinite(pending.readyAt)) {
        const before = JSON.stringify(state);
        state.windows = normalized(state.windows);
        if (pending) {
          const previousBasis = pending.deadlineBasis === 'draw'
            ? Math.max(...pending.raffles.map(raffle => raffle.drawTime)) : pending.salesEnd;
          const savedDelay = pending.readyAt - previousBasis;
          const raffles = pending.raffles.map(window => normalizeWindow({ ...window }));
          if (!raffles.length || raffles.some(window => !Number.isSafeInteger(window.salesEnd) || !Number.isSafeInteger(window.drawTime))) {
            throw new Error('Invalid pending rollover schedule');
          }
          const changed = raffles.some((raffle, index) => raffle.salesEnd !== pending.raffles[index].salesEnd || raffle.drawTime !== pending.raffles[index].drawTime);
          pending.nextWindows = normalized(pending.nextWindows);
          if (changed) {
            if (!Number.isSafeInteger(savedDelay) || savedDelay < 0) throw new Error('Invalid pending rollover deadline');
            pending.raffles = raffles;
            pending.salesEnd = Math.min(...raffles.map(raffle => raffle.salesEnd));
            pending.readyAt = Math.max(...raffles.map(raffle => raffle.drawTime)) + savedDelay;
            pending.deadlineBasis = 'draw';
          }
        }
        if (JSON.stringify(state) !== before) await saveState(structuredClone(state));
      }
      // Limit work per tick after unusually long outages; remaining work stays durable.
      for (let count = 0; count < 100; count += 1) {
        if (!state.pending) {
          // Recovery may have just armed legacy nextWindows. Correct and persist
          // them before evaluating another cutoff in this same tick.
          const armed = normalized(state.windows);
          if (JSON.stringify(armed) !== JSON.stringify(state.windows)) {
            state.windows = armed;
            await saveState(structuredClone(state));
          }
          const cutoff = Math.min(...state.windows.map((window) => window.salesEnd));
          if (cutoff > timestamp && !archiveNow) return state;
          const manual = cutoff > timestamp;
          const raffles = state.windows.filter((window) => window.salesEnd === cutoff);
          const following = manual ? state.windows : validateWindows(getWindows(cutoff + 1), cutoff);
          const holdDelay = getDelaySeconds();
          if(!Number.isSafeInteger(holdDelay)||holdDelay<0)throw Error('Invalid rollover delay');
          state.pending = {
            key: manual ? `raffle-manual-${randomUUID()}` : `raffle-rollover-${cutoff}`, salesEnd: cutoff,
            requestedBy: archiveNow ? requestedBy : undefined, manual, readyAt: manual ? timestamp : Math.max(...raffles.map(window => window.drawTime)) + holdDelay,
            name: archiveName(Math.min(...raffles.map((window) => window.drawTime))),
            raffles, archiveId: null, ...(manual ? {} : { deadlineBasis: 'draw' }),
            nextWindows: state.windows.map((window) => !manual && window.salesEnd === cutoff
              ? following.find((next) => next.type === window.type) : window),
          };
          await saveState(structuredClone(state));
        }
        const job = state.pending;
        // Rebase only holds that have not copied yet, retaining their saved delay.
        // A durable basis marker prevents adding the draw offset on every restart.
        if (!job.deadlineBasis && !job.manual && !job.archiveId && Number.isFinite(job.readyAt)) {
          const savedDelay = job.readyAt - job.salesEnd;
          if (!Number.isSafeInteger(savedDelay) || savedDelay < 0 || !job.raffles?.length ||
              !job.raffles.every(raffle => Number.isSafeInteger(raffle.drawTime))) {
            throw new Error('Invalid pending rollover deadline');
          }
          job.readyAt = Math.max(...job.raffles.map(raffle => raffle.drawTime)) + savedDelay;
          job.deadlineBasis = 'draw';
          await saveState(structuredClone(state));
        }
        if (archiveNow && requestedBy && !job.requestedBy) {
          job.requestedBy = requestedBy;
          await saveState(structuredClone(state));
        }
        // Jobs without a deadline have already begun; do not delay their recovery.
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
