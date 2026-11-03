// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../web/house-key.js');
const G = require('../web/gh-sync.js');

test('house key opens with the right password only', async () => {
  const sealed = await K.seal({ repo: 'me/house-data', token: 'github_pat_test' }, 'buca');
  assert.equal(sealed.iter, K.ITERATIONS);
  assert.ok(!JSON.stringify(sealed).includes('github_pat_test'));
  assert.deepEqual(await K.open(sealed, 'buca'), { repo: 'me/house-data', token: 'github_pat_test' });
  assert.equal(await K.open(sealed, 'Buca'), null);
  assert.equal(await K.open(sealed, ''), null);
});

test('house key rejects a tampered file', async () => {
  const sealed = await K.seal({ repo: 'me/house-data', token: 't' }, 'pw');
  const data = Buffer.from(sealed.data, 'base64');
  data[0] ^= 1;
  assert.equal(await K.open({ ...sealed, data: data.toString('base64') }, 'pw'), null);
  await assert.rejects(K.open({ ...sealed, v: 2 }, 'pw'));
});

test('isPrivate reads the repo visibility', async () => {
  const fake = visibility => async () => ({ ok: true, status: 200, json: async () => ({ private: visibility }) });
  const cfg = { owner: 'me', repo: 'r', path: 'house-cost.json', token: 't' };
  assert.equal(await G.client(cfg, fake(true)).isPrivate(), true);
  assert.equal(await G.client(cfg, fake(false)).isPrivate(), false);
});
