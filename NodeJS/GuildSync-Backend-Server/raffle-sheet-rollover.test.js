import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollover } from './raffle-sheet-rollover.js';

function fixture(deadlines = [100, 100]) {
  let state = null;
  const io = { time: 50, copies: [], clears: [], saves: 0, failSave: 0, failArchive: false, failReset: false };
  io.getWindows = (time) => ['biweekly', 'monthly'].map((type, i) => {
    let cutoff = deadlines[i];
    while (cutoff < time) cutoff += 100;
    return { type, salesEnd: cutoff, drawTime: cutoff };
  });
  io.engine = () => createRollover({
    delaySeconds: io.delaySeconds || 0,
    now: () => io.time, getWindows: (time) => io.getWindows(time),
    log: () => io.log?.(),
    loadState: async () => structuredClone(state),
    saveState: async (next) => {
      if (++io.saves === io.failSave) throw new Error('save failed');
      state = structuredClone(next);
    },
    archive: async (job) => {
      if (io.failArchive) throw new Error('archive failed');
      let copy = io.copies.find((copy) => copy.key === job.key);
      if (!copy) { copy = { ...job, id: `copy-${io.copies.length}` }; io.copies.push(copy); }
      return copy.id;
    },
    reset: async (job) => {
      assert.equal(state.pending.archiveId, job.archiveId, 'archive ID must be durable before clearing');
      if (!io.clears.some((clear) => clear.key === job.key)) io.clears.push(job);
      if (io.failReset) throw new Error('reset response lost');
    },
  });
  io.state = () => structuredClone(state);
  return io;
}

test('first boot arms the next period without clearing historical or exact-cutoff entries', async () => {
  const io = fixture(); io.time = 100;
  await io.engine().tick();
  assert.equal(io.copies.length, 0);
  assert.equal(io.clears.length, 0);
  assert.deepEqual(io.state().windows.map((w) => w.salesEnd), [200, 200]);
});

test('holds until persisted deadline across restart then archives and marks catchup required', async () => {
  const io = fixture([100, 150]); io.delaySeconds = 40;
  await io.engine().tick(); io.time = 100;
  await io.engine().tick();
  assert.equal(io.state().pending.readyAt, 140);
  assert.equal(io.copies.length, 0);
  io.delaySeconds = 0; io.time = 139;
  await io.engine().tick(); assert.equal(io.copies.length, 0);
  io.time = 140; await io.engine().tick();
  assert.equal(io.copies.length, 1);
  assert.equal(io.state().catchupRequired, true);
  assert.deepEqual(io.clears[0].nextWindows.map(w => w.salesEnd), [200, 150]);
});

test('on-demand archive skips a real hold and resets both tabs', async () => {
  const io = fixture([100, 150]); io.delaySeconds = 40;
  await io.engine().tick(); io.time = 100; await io.engine().tick();
  await io.engine().tick({ archiveNow: true });
  assert.equal(io.copies.length, 1);
  assert.deepEqual(io.clears[0].raffles.map(r => r.type), ['biweekly', 'monthly']);
  assert.deepEqual(io.state().lastClosedSalesEnd, { biweekly: 100 });
  assert.equal(io.state().lastArchive.archiveId, 'copy-0');
});

test('on-demand archive outside hold preserves schedule and resumes same job after failure', async () => {
  const io = fixture([100, 150]); await io.engine().tick();
  const windows = io.state().windows; io.failReset = true;
  await assert.rejects(io.engine().tick({ archiveNow: true }), /reset response lost/);
  assert.equal(io.state().pending.manual, true);
  io.failReset = false; await io.engine().tick({ archiveNow: true });
  assert.equal(io.copies.length, 1); assert.equal(io.clears.length, 1);
  assert.deepEqual(io.state().windows, windows);
  assert.deepEqual(io.state().lastClosedSalesEnd, {});
});

test('same cutoff archives the whole spreadsheet once then resets both tabs', async () => {
  const io = fixture(); const engine = io.engine();
  await engine.tick(); io.time = 100; await engine.tick();
  assert.equal(io.copies.length, 1);
  assert.equal(io.copies[0].name, '691231 raffle');
  assert.deepEqual(io.clears[0].raffles.map((r) => r.type), ['biweekly', 'monthly']);
  assert.deepEqual(io.state().lastClosedSalesEnd, { biweekly: 100, monthly: 100 });
  await engine.tick(); assert.equal(io.copies.length, 1);
});

test('different cutoffs reset both tabs but only advance the closed raffle', async () => {
  const io = fixture([100, 150]); const engine = io.engine();
  await engine.tick(); io.time = 250; await engine.tick();
  assert.deepEqual(io.clears.map((job) => job.raffles.map((r) => r.type)), Array.from({ length: 4 }, () => ['biweekly', 'monthly']));
  assert.deepEqual(io.state().lastClosedSalesEnd, { biweekly: 200, monthly: 250 });
});

test('failed pending-state save prevents copying and clearing', async () => {
  const io = fixture(); await io.engine().tick(); io.time = 100; io.failSave = 2;
  await assert.rejects(io.engine().tick(), /save failed/);
  assert.equal(io.copies.length, 0); assert.equal(io.clears.length, 0);
});

test('archive failure keeps pending work durable without clearing', async () => {
  const io = fixture(); await io.engine().tick(); io.time = 100; io.failArchive = true;
  await assert.rejects(io.engine().tick(), /archive failed/);
  assert.equal(io.clears.length, 0); assert.ok(io.state().pending);
  io.failArchive = false; await io.engine().tick(); assert.equal(io.clears.length, 1);
});

test('restart after archive ID save failure reconciles the existing archive before clearing', async () => {
  const io = fixture(); await io.engine().tick(); io.time = 100; io.failSave = 3;
  await assert.rejects(io.engine().tick(), /save failed/);
  assert.equal(io.copies.length, 1); assert.equal(io.clears.length, 0);
  await io.engine().tick();
  assert.equal(io.copies.length, 1); assert.equal(io.clears.length, 1);
});

for (const failure of ['lost reset response', 'completion save failure']) {
  test(`restart handles ${failure} without a second destructive reset`, async () => {
    const io = fixture(); await io.engine().tick(); io.time = 100;
    if (failure === 'lost reset response') io.failReset = true; else io.failSave = 4;
    await assert.rejects(io.engine().tick());
    io.failReset = false; await io.engine().tick();
    assert.equal(io.copies.length, 1); assert.equal(io.clears.length, 1);
    assert.equal(io.state().pending, null);
  });
}

test('rejects a nonadvancing schedule before copying or clearing', async () => {
  const io = fixture(); await io.engine().tick(); io.time = 100;
  io.getWindows = () => [{ type: 'biweekly', salesEnd: 100, drawTime: 101 }, { type: 'monthly', salesEnd: 100, drawTime: 101 }];
  await assert.rejects(io.engine().tick(), /schedule/i);
  assert.equal(io.copies.length, 0); assert.equal(io.clears.length, 0);
});

test('overdue work at the catchup cap blocks exports until the next tick catches up', async () => {
  const io = fixture(); await io.engine().tick(); io.time = 10100;
  await assert.rejects(io.engine().tick(), /catchup/i);
  assert.equal(io.clears.length, 100);
  await io.engine().tick(); assert.equal(io.clears.length, 101);
});

test('tick waits for asynchronous completion logging', async () => {
  const io = fixture(); await io.engine().tick(); io.time = 100;
  let logged = false;
  io.log = async () => { await new Promise(resolve => setTimeout(resolve, 10)); logged = true; };
  await io.engine().tick(); assert.equal(logged, true);
});


test('automatic archive waits until draw plus delay while sales remain closed', async () => {
  const io = fixture([100, 150]); io.delaySeconds = 40;
  const windows = io.getWindows;
  io.getWindows = time => windows(time).map(w => ({ ...w, drawTime: w.salesEnd + 20 }));
  await io.engine().tick();
  io.time = 100; await io.engine().tick();
  assert.equal(io.state().pending.readyAt, 160);
  assert.equal(io.copies.length, 0);
  io.time = 140; await io.engine().tick(); assert.equal(io.copies.length, 0);
  io.delaySeconds = 0;
  io.time = 159; await io.engine().tick(); assert.equal(io.copies.length, 0);
  io.time = 160; await io.engine().tick();
  assert.equal(io.copies.length, 1);
  assert.equal(io.state().lastClosedSalesEnd.biweekly, 100);
  assert.equal(io.state().pending.salesEnd, 150);
});


test('archive name uses Eastern draw date', async () => {
  const io = fixture();
  const draw = Date.parse('2026-10-01T02:00:00Z') / 1000;
  io.getWindows = time => ['biweekly', 'monthly'].map(type => ({type, salesEnd: time + 100, drawTime: draw}));
  await io.engine().tick();
  await io.engine().tick({archiveNow: true});
  assert.equal(io.copies[0].name, '260930 raffle');
});


test('shared cutoff waits for the latest closing draw plus delay', async () => {
  const io = fixture(); io.delaySeconds = 10;
  const windows = io.getWindows;
  io.getWindows = time => windows(time).map((w, i) => ({...w, drawTime:w.salesEnd + 20 + i * 5}));
  await io.engine().tick(); io.time = 100; await io.engine().tick();
  assert.equal(io.state().pending.readyAt, 135);
  io.time = 134; await io.engine().tick(); assert.equal(io.copies.length, 0);
  io.time = 135; await io.engine().tick(); assert.equal(io.copies.length, 1);
});
