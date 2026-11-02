'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../web/i18n.js');

test('every key used in the web app exists in English and Turkish', () => {
  const web = path.join(__dirname, '..', 'web');
  const used = new Set();
  for (const f of ['app.js', 'export.js', 'logic.js', 'gh-sync.js', 'index.html']) {
    const src = fs.readFileSync(path.join(web, f), 'utf8');
    for (const m of src.matchAll(/(?:\bT|\bt|say)\('([\w.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-html|-ph|-title|-aria)?="([\w.]+)"/g)) used.add(m[1]);
  }
  for (const lang of ['en', 'tr']) {
    L.use(lang);
    const missing = [...used].filter(k => !k.endsWith('.') && L.t(k) === k); // 'cat.' + id is built at run time
    assert.deepStrictEqual(missing, [], lang + ' is missing keys');
  }
  L.use('en');
});

test('plurals, placeholders and money format', () => {
  L.use('en');
  assert.strictEqual(L.t('n.expense', { n: 1 }), '1 expense');
  assert.strictEqual(L.t('n.expense', { n: 3 }), '3 expenses');
  assert.strictEqual(L.money('₺1,234.50'), '₺1,234.50');
  L.use('tr');
  assert.strictEqual(L.t('n.expense', { n: 3 }), '3 harcama');
  assert.strictEqual(L.money('₺1,234.50'), '₺1.234,50');
  assert.strictEqual(L.money('1.5 MB'), '1,5 MB');
  assert.strictEqual(L.cat('groceries'), 'Market');
  L.use('en');
});
