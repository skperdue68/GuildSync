// Guards the three .env.example templates against drifting from the code that
// reads them. Run from NodeJS/GuildSync-Backend-Server with `node --test`.
//
// Limitation: keys assembled at runtime (for example prefixed bot names) cannot
// be discovered statically. Those are covered through the Administrator
// Configuration catalog, and the returning-member application keys, which are
// read through a spread of process.env, are listed explicitly below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configurationCatalog} from './admin-configuration.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const components = {
 backend: {example: 'NodeJS/GuildSync-Backend-Server/.env.example', dir: 'NodeJS/GuildSync-Backend-Server'},
 bot: {example: 'NodeJS/GuildSync-Discord-Bot/.env.example', dir: 'NodeJS/GuildSync-Discord-Bot'},
 desktop: {example: 'GO/GuildSync-Frontend-Client/.env.example', dir: 'GO/GuildSync-Frontend-Client'}
};
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.go']);
const skippedDirectories = new Set(['node_modules', 'dist', 'release', '.git', 'public']);
const botIndirectKeys = ['GUILDSYNC_APPLICATION_RESTORE_RANK_ENABLED', 'GUILDSYNC_APPLICATION_OFFICER_ROLE'];
// Operating-system variables the desktop client inspects; they are not settings.
const systemVariables = new Set(['DISPLAY', 'SNAP', 'WAYLAND_DISPLAY', 'XDG_DATA_HOME', 'XDG_SESSION_TYPE', 'GUILDSYNC_TEST_X11']);

function readSources(directory) {
 const contents = [];
 const walk = relative => {
  for (const entry of fs.readdirSync(path.join(repo, relative), {withFileTypes: true})) {
   if (entry.isDirectory()) {
    if (!skippedDirectories.has(entry.name)) walk(path.join(relative, entry.name));
    continue;
   }
   if (!sourceExtensions.has(path.extname(entry.name))) continue;
   if (/\.test\.(?:js|mjs|cjs)$/.test(entry.name) || entry.name.endsWith('_test.go')) continue;
   contents.push(fs.readFileSync(path.join(repo, relative, entry.name), 'utf8'));
  }
 };
 walk(directory);
 return contents.join('\n');
}

function readExample(file) {
 const text = fs.readFileSync(path.join(repo, file), 'utf8');
 return {text, keys: [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1])};
}

function staticallyReadKeys(component, source) {
 const found = new Set();
 for (const pattern of [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g]) {
  for (const match of source.matchAll(pattern)) found.add(match[1]);
 }
 if (component === 'backend') {
  for (const pattern of [/requiredEnv\(\s*'([A-Z][A-Z0-9_]*)'\s*\)/g, /requiredDatabaseEnv\(\s*'([A-Z][A-Z0-9_]*)'\s*\)/g]) {
   for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
 }
 if (component === 'bot') {
  for (const match of source.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*process\.env;/g)) {
   for (const entry of match[1].split(',')) {
    const key = entry.trim().split(':')[0].trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) found.add(key);
   }
  }
 }
 if (component === 'desktop') {
  for (const match of source.matchAll(/os\.Getenv\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g)) found.add(match[1]);
 }
 for (const key of systemVariables) found.delete(key);
 return found;
}

test('every documented setting is still read by its own component', () => {
 for (const [name, {example, dir}] of Object.entries(components)) {
  const {keys} = readExample(example);
  assert.equal(new Set(keys).size, keys.length, `${example} repeats a key`);
  const source = readSources(dir);
  // Prefixed bot keys are assembled at runtime, so the catalog test below
  // covers those instead of a literal source search.
  const assembled = name === 'bot'
    ? new Set(configurationCatalog.filter(setting => setting.owner === 'bot').map(setting => setting.key))
    : new Set();
  for (const key of keys) {
   if (assembled.has(key)) continue;
   assert.ok(source.includes(key), `${example} documents ${key}, but no source reads it`);
  }
 }
});

test('every statically read setting is documented in that component example', () => {
 for (const [name, {example, dir}] of Object.entries(components)) {
  const documented = new Set(readExample(example).keys);
  for (const key of staticallyReadKeys(name, readSources(dir))) {
   assert.ok(documented.has(key), `${key} is read by ${name} source but missing from ${example}`);
  }
 }
});

test('every live-configurable setting exists in the example of its owning component', () => {
 const backend = new Set(readExample(components.backend.example).keys);
 const bot = new Set(readExample(components.bot.example).keys);
 for (const setting of configurationCatalog) {
  const documented = setting.owner === 'backend' ? backend : bot;
  assert.ok(documented.has(setting.key), `${setting.key} is configurable in GuildSync but missing from the ${setting.owner} example`);
 }
});

test('bot settings read through an environment spread are documented', () => {
 const {text} = readExample(components.bot.example);
 for (const key of botIndirectKeys) assert.match(text, new RegExp(`^${key}=`, 'm'), `${key} is read indirectly but missing from the bot example`);
});
