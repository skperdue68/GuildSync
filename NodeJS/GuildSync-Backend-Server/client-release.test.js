import {createDesktopVersionPolicy} from './desktop-version-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./guildsync-backend-server.js', import.meta.url), 'utf8');
function fixture(files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildsync-release-'));
  for (const file of files) fs.writeFileSync(path.join(dir, file), 'fixture');
  const context = vm.createContext({ fs, GUILDSYNC_DOWNLOADS_DIR: dir, CURRENT_GUILDSYNC_CLIENT_VERSION: '1.2.7', GUILDSYNC_WEB_PUBLIC_URL: 'https://example.test', Log() {} });
  vm.runInContext(source.slice(source.indexOf('function normalizeClientPlatform('), source.indexOf('function requiredEnv(')), context);
  return { dir, context, close: () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('guildsync-release-'));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}
test('downloads select the configured release, never older or newer installers', () => {
  const f = fixture(['GuildSync-Setup-1.2.0-Windows.zip', 'GuildSync-Setup-1.2.7-Windows.zip', 'GuildSync-Setup-1.3.0-Windows.zip']);
  try {
    const result = vm.runInContext("getGuildSyncClientDownload('windows')", f.context);
    assert.equal(result.file_name, 'GuildSync-Setup-1.2.7-Windows.zip');
    assert.equal(result.version, '1.2.7');
  } finally { f.close(); }
});
test('missing configured installer returns unavailable even when an older release exists', () => {
  const f = fixture(['GuildSync-Setup-1.2.0-Windows.zip']);
  try { assert.equal(vm.runInContext("getGuildSyncClientDownload('windows')", f.context), null); } finally { f.close(); }
});
test('version socket survives missing directory and does not offer an unavailable update', () => {
  const f = fixture();
  f.close();
  let result;
  f.context.desktopVersionPolicy=createDesktopVersionPolicy({latest:'1.2.7',download:platform=>f.context.getGuildSyncClientDownload(platform)});
  f.context.socket = { on(event, handler) { handler({ version: '1.2.0', platform: 'macos' }); }, emit(event, payload) { result = payload; } };
  const start = source.indexOf("  socket.on('guildsync:client-version'");
  vm.runInContext(source.slice(start, source.indexOf("  socket.on('guildsync:request-discord-data-refresh'", start)), f.context);
  assert.equal(result.update_required, false);
  assert.equal(result.download_available, false);
  assert.equal(result.latest_version, null);
  assert.equal(result.download_url, '');
});

test('HTTP lookup returns 404 for missing release and usable metadata for each installer platform', () => {
  const f = fixture(['GuildSync-Setup-1.2.7-Windows.zip', 'GuildSync-Setup-1.2.7-macOS.zip', 'GuildSync-Setup-1.2.7-Linux-x86_64.zip']);
  try {
    const start = source.indexOf("app.get('/api/client-download'");
    const route = source.slice(start, source.indexOf("app.get('/api/auth/session'", start));
    for (const platform of ['windows', 'macos', 'linux']) {
      let result;
      f.context.app = { get(name, handler) { handler({ query: { platform } }, { json(value) { result = value; } }); } };
      vm.runInContext(route, f.context);
      assert.equal(result.ok, true);
      assert.equal(result.download.version, '1.2.7');
      assert.match(result.download_url, /1\.2\.7/);
    }
    f.close();
    let status, result;
    f.context.app = { get(name, handler) { handler({ query: { platform: 'linux' } }, { status(value) { status = value; return this; }, json(value) { result = value; } }); } };
    vm.runInContext(route, f.context);
    assert.equal(status, 404);
    assert.equal(result.download_available, false);
    assert.equal(result.download_url, undefined);
  } finally { f.close(); }
});
