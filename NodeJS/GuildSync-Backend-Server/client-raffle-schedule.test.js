import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clients = ['web/src/main.js', '../../GO/GuildSync-Frontend-Client/frontend/src/main.js'];
const seconds = (iso) => Date.parse(iso) / 1000;

async function loadClient(file, now, offsets = {}) {
  const url = new URL(file, import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  const imports = {};
  const scheduleImport = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/raffle-schedule\.js['"]/);
  if (scheduleImport) {
    const schedule = await import(new URL('./raffle-schedule.js', url));
    for (const binding of scheduleImport[1].split(',')) {
      const [name, alias = name] = binding.trim().split(/\s+as\s+/);
      imports[alias] = schedule[name];
    }
  }
  const constants = source.match(/^const BANKING_(?:BIWEEKLY_[A-Z_]+|RAFFLE_AFTER_SALES_SECONDS) = .+;$/gm).join('\n');
  const start = source.indexOf('function getBankingRafflePeriodOffset(');
  const end = source.indexOf('function getBankingRaffleTypeMarker(', start);
  const context = vm.createContext({ ...imports, Date: class extends Date { static now() { return now * 1000; } }, Intl, bankingRafflePeriodOffsets: offsets });
  vm.runInContext(`${constants}\n${source.slice(start, end)}`, context);
  return context;
}

for (const file of clients) {
  test(`${file}: biweekly current and previous windows retain 7 PM Eastern over fall DST`, async () => {
    const client = await loadClient(file, seconds('2026-11-01T12:00:00Z'), { biweekly: 0 });
    const current = client.getBankingRaffleWindow('biweekly');
    assert.equal(current.salesEnd, seconds('2026-11-08T00:00:00Z'));
    assert.equal(current.raffleTime, seconds('2026-11-08T01:00:00Z'));
    assert.equal(current.salesStart, seconds('2026-10-24T23:00:00Z') + 1);
    const previous = await loadClient(file, seconds('2026-11-01T12:00:00Z'), { biweekly: -1 });
    assert.equal(previous.getBankingRaffleWindow('biweekly').salesEnd, current.salesStart - 1);
  });
  test(`${file}: spring DST windows use the prior actual cutoff and monthly navigation`, async () => {
    const client = await loadClient(file, seconds('2027-03-20T12:00:00Z'), { biweekly: 0 });
    const window = client.getBankingRaffleWindow('biweekly');
    assert.equal(window.salesEnd, seconds('2027-03-27T23:00:00Z'));
    assert.equal(window.salesStart, seconds('2027-03-14T00:00:00Z') + 1);
    const monthly = client.getBankingMonthlySalesEndAtOrAfter(seconds('2026-11-01T12:00:00Z'));
    assert.equal(monthly, seconds('2026-11-22T00:00:00Z'));
    const previous = client.getBankingPreviousMonthlySalesEnd(monthly);
    assert.equal(previous, seconds('2026-10-24T23:00:00Z'));
    assert.equal(client.getBankingNextMonthlySalesEnd(previous), monthly);
    assert.equal(client.getBankingMonthlySalesEndForOffset(seconds('2026-11-01T12:00:00Z'), -1), previous);
    assert.equal(client.getBankingMonthlySalesEndForOffset(seconds('2026-10-01T12:00:00Z'), 1), monthly);
    assert.equal(client.getBankingBiweeklySalesEndAtOrAfter(window.salesEnd), window.salesEnd);
    assert.equal(client.getBankingBiweeklySalesEndAtOrAfter(window.salesEnd + 1), seconds('2027-04-10T23:00:00Z'));
    const monthlyClient = await loadClient(file, seconds('2026-11-01T12:00:00Z'), { monthly: 0 });
    const monthlyWindow = monthlyClient.getBankingRaffleWindow('monthly');
    assert.equal(monthlyWindow.salesStart, previous + 1);
    assert.equal(monthlyWindow.salesEnd, monthly);
    assert.equal(monthlyWindow.raffleTime, seconds('2026-11-22T01:00:00Z'));
  });
}
