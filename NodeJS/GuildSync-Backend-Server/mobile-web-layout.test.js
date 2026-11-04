import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css = readFileSync(new URL('./web/src/style.css', import.meta.url), 'utf8');
const shortcuts = readFileSync(new URL('./web/src/member-history-shortcuts.css', import.meta.url), 'utf8');
const mediaQueries = text => [...text.matchAll(/@media[^{]+\{/g)].map(match => match[0]);

function mediaBlock(text, query) {
  const start = text.indexOf(query);
  if (start === -1) return '';
  let depth = 0;
  for (let i = text.indexOf('{', start); i !== -1 && i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

test('touch devices get the scrollable mobile layout at any viewport width', () => {
  const coarse = mediaQueries(css).filter(query => query.includes('pointer: coarse'));
  assert.ok(coarse.length, 'style.css keeps a coarse-pointer mobile layout block');

  for (const query of coarse) {
    assert.doesNotMatch(query, /pointer:\s*coarse\)\s*and\s*\(max-width/,
      'a coarse pointer must not be capped by a max-width, or phones browsing in desktop mode fall back to the clipped desktop shell');
  }

  assert.ok(coarse.some(query => /max-width:\s*760px/.test(query)),
    'narrow viewports still resolve to the same mobile layout block');
});

test('the mobile layout lets the page scroll instead of clipping it to the viewport', () => {
  const block = mediaBlock(css, '@media (max-width: 760px), (pointer: coarse) {');
  assert.ok(block, 'the mobile layout block is present');

  assert.match(block, /html,\s*body,\s*#app \{[\s\S]*?height: auto;[\s\S]*?overflow-y: auto;/,
    'the mobile layout stops pinning html, body and #app to the viewport height');
  assert.match(block, /\.main-window \{[\s\S]*?height: auto;[\s\S]*?overflow: visible;/,
    'the mobile layout lets the main window grow with its content');
  assert.match(block, /\.guildsync-tab-content,[\s\S]*?position: static;[\s\S]*?overflow: visible;/,
    'the tab content leaves absolute positioning so it participates in normal scrolling');
  assert.match(block, /\.guildsync-tabs \{[\s\S]*?position: fixed;[\s\S]*?bottom: 0;/,
    'section tabs stay reachable as a fixed bottom bar');

  const shortcutsCoarse = mediaQueries(shortcuts).filter(query => query.includes('pointer:coarse'));
  assert.ok(shortcutsCoarse.length, 'member history labels follow the same coarse-pointer rule');
  for (const query of shortcutsCoarse) {
    assert.doesNotMatch(query, /and\s*\(max-width:\s*920px\)/,
      'member history cell labels must not disappear on wide touch viewports');
  }
});
