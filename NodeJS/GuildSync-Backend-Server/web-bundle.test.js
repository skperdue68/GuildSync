import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the web bundle served by the backend includes raffle bonus configuration', () => {
  if (!fs.existsSync(new URL('./public/index.html', import.meta.url))) {
    throw new Error('Build the web client first: npm run build:web in NodeJS/GuildSync-Backend-Server. Compiled assets are intentionally untracked.');
  }
  const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const html = read('./public/index.html');
  assert.equal(html, read('./web/dist/index.html'));
  const scripts = [...html.matchAll(/src="(\/assets\/[^\"]+\.js)"/g)];
  assert.ok(scripts.length > 0);
  const script = scripts.map(([, path]) => {
    const contents = read(`./public${path}`);
    assert.equal(contents, read(`./web/dist${path}`));
    return contents;
  }).join('\n');
  for (const label of ['raffleBonusSettingsForm', 'biweekly-enabled', 'monthly-enabled', 'Save Bonus Settings', 'Bonus %']) {
    assert.ok(script.includes(label), `served web bundle is missing ${label}`);
  }
});
