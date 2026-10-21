import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const browser = [process.env.GUILDSYNC_TEST_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].find(file => file && fs.existsSync(file));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

for (const [client, directory] of [['web', './web/src/'], ['desktop', '../../GO/GuildSync-Frontend-Client/frontend/src/']]) {
  test(`${client} banking history keeps ticket columns readable and notes aligned at wide and narrow widths`, {skip: !browser}, () => {
    const source = fs.readFileSync(new URL(directory + 'main.js', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL(directory + 'style.css', import.meta.url), 'utf8');
    const render = source.match(/function renderBankingHistoryRecords\([^]*?(?=\nfunction )/)[0];
    const cases = [];
    for (const width of [1680, 960, 560]) for (const bonus of [false, true]) {
      const context = vm.createContext({bankingHistorySelectedAccount: 'example', bankingHistoryLoading: false,
        bankingHistoryRecords: [{event_timestamp: 1780000000, transaction_type: 'monthly', deposit_amount: 1000003,
          purchased_tickets: 400, total_tickets: bonus ? 600 : 400, bonus_enabled: bonus, bonus_percent: 50,
          bonus_tickets: 200, note: 'Attendance confirmed; winnings sent.'}], escapeHtml: escape,
        formatBankingHistoryTimestamp: () => '05/23/2026 17:59:00', formatBankingHistoryType: () => '50/50',
        formatBankingHistoryAmount: () => '1,000,003', formatBankingHistoryTickets: String, formatTicketAmount: String});
      vm.runInContext(render, context);
      const table = vm.runInContext('renderBankingHistoryRecords()', context);
      const document = `<style>${css}</style><div style="width:100%;height:500px">${table}</div>`;
      cases.push(`<iframe data-width="${width}" data-bonus="${bonus}" style="width:${width}px;height:550px" srcdoc="${escape(document)}"></iframe>`);
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guildsync-history-layout-'));
    try {
      const file = path.join(temporary, 'history.html');
      fs.writeFileSync(file, `<html><body>${cases.join('')}<pre id="layout-results"></pre><script>
        const frames = [...document.querySelectorAll('iframe')];
        let remaining = frames.length;
        frames.forEach(frame => frame.addEventListener('load', () => {
          if (--remaining) return;
          const results = frames.map(frame => {
            const doc = frame.contentDocument, table = doc.querySelector('table');
            const headers = [...table.querySelectorAll('th')];
            const total = headers.find(header => header.textContent === 'Total Tickets');
            return {width: Number(frame.dataset.width), bonus: frame.dataset.bonus === 'true',
              headerHeight: table.tHead.getBoundingClientRect().height, totalWidth: total.getBoundingClientRect().width,
              totalScrollWidth: total.scrollWidth, totalClientWidth: total.clientWidth,
              tableLayout: getComputedStyle(table).tableLayout, minimum: getComputedStyle(total).minWidth,
              headerWidths: headers.map(header => header.getBoundingClientRect().width),
              visibleHeaders: headers.filter(header => getComputedStyle(header).display !== 'none').length,
              headDisplay: getComputedStyle(table.tHead).display,
              rowHeight: table.tBodies[0].rows[0].getBoundingClientRect().height,
              note: table.tBodies[0].rows[0].lastElementChild.textContent.trim(),
              ticketTotal: table.tBodies[0].rows[0].children[headers.length - 2].textContent.trim()};
          });
          document.querySelector('#layout-results').textContent = JSON.stringify(results);
        }));
      </script></body></html>`);
      const result = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(temporary, 'profile')}`, '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(file).href],
        {encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024});
      assert.equal(result.status, 0, result.stderr);
      const output = result.stdout.match(/<pre id="layout-results">([^]*?)<\/pre>/)?.[1];
      assert.ok(output, 'Browser did not report layout measurements');
      const layouts = JSON.parse(output);
      assert.equal(layouts.length, 6);
      for (const layout of layouts) {
        const label = `${layout.width}px, bonus=${layout.bonus}`;
        assert.ok(layout.totalWidth >= 90, `Total Tickets column collapsed: ${label}, ${layout.totalWidth}px`);
        assert.ok(layout.totalScrollWidth <= layout.totalClientWidth + 1, `Total Tickets heading overflows: ${JSON.stringify(layout)}`);
        assert.ok(layout.headerHeight < 90, `Header wraps vertically: ${label}`);
        assert.ok(layout.rowHeight < 90, `Ticket digits inflate the row: ${label}`);
        assert.equal(layout.visibleHeaders, layout.bonus ? 8 : 6, label);
        assert.notEqual(layout.headDisplay, 'none', label);
        assert.equal(layout.note, 'Attendance confirmed; winnings sent.', label);
        assert.equal(layout.ticketTotal, layout.bonus ? '600' : '400', label);
      }
    } finally {
      assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('guildsync-history-layout-'));
      fs.rmSync(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
  });
}
