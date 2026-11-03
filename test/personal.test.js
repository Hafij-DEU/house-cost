// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/personal.js');
const L = require('../web/i18n.js');
const { ME } = P;

const entry = (over = {}) => P.makeEntry({ title: 'Dinner', amount: 9000, date: '2026-11-03', category: 'food', paidBy: ME, people: [], ...over });

test('an entry without people is all mine', () => {
  const e = entry();
  assert.deepEqual(e.shares, []);
  assert.equal(e.paidBy, ME);
  assert.equal(P.myCost(e), 9000);
  assert.equal(P.owedToMe(e), 0);
  assert.equal(P.iOwe(e), 0);
});

test('equal split puts me first and marks the payer paid', () => {
  const e = entry({ amount: 1000, people: [' Ali ', 'Ayşe', ''] });
  assert.deepEqual(e.shares.map(s => s.who), [ME, 'Ali', 'Ayşe']);
  assert.equal(e.shares.reduce((t, s) => t + s.amount, 0), 1000);
  assert.deepEqual(e.shares.map(s => s.paid), [true, false, false]);
  assert.equal(P.owedToMe(e), 1000 - P.myCost(e));
});

test('someone else paid: I owe my share until I tick it', () => {
  const p = P.emptyPersonal();
  const e = entry({ people: ['Ali'], paidBy: 'Ali' });
  p.entries.push(e);
  assert.equal(P.iOwe(e), 4500);
  assert.deepEqual(P.balances(p), { owedToMe: 0, iOwe: 4500, people: [{ name: 'Ali', owesMe: 0, iOwe: 4500 }] });
  assert.equal(P.setPaid(p, e.id, 'Ali', true), false, 'the payer share cannot change');
  assert.equal(P.setPaid(p, e.id, ME, true), true);
  assert.equal(P.balances(p).iOwe, 0);
});

test('balances add up per person, names match without case', () => {
  const p = P.emptyPersonal();
  p.entries.push(entry({ amount: 2000, people: ['Ali'] }), entry({ amount: 600, people: ['ali', 'Can'] }), entry({ amount: 400, people: ['Can'], paidBy: 'Can' }));
  const b = P.balances(p);
  assert.equal(b.owedToMe, 1000 + 200 + 200);
  assert.equal(b.iOwe, 200);
  assert.deepEqual(b.people.find(r => r.name === 'Ali'), { name: 'Ali', owesMe: 1200, iOwe: 0 });
  assert.deepEqual(b.people.find(r => r.name === 'Can'), { name: 'Can', owesMe: 200, iOwe: 200 });
  assert.equal(P.settleWith(p, 'CAN'), 2);
  assert.equal(P.balances(p).people.some(r => r.name === 'Can'), false);
  assert.equal(P.balances(p).owedToMe, 1200);
});

test('split errors', () => {
  const ok = { amount: 1000, paidBy: ME, people: ['Ali'], customShares: null };
  assert.equal(P.splitError(ok), '');
  assert.equal(P.splitError({ ...ok, people: ['@me'] }), 'p.err.name');
  assert.equal(P.splitError({ ...ok, people: ['Ali', 'ALI'] }), 'p.err.dupName');
  assert.equal(P.splitError({ ...ok, paidBy: 'Bob' }), 'p.err.payer');
  assert.equal(P.splitError({ ...ok, customShares: [{ who: ME, amount: 400 }, { who: 'Ali', amount: 500 }] }), 'p.err.custom');
  assert.equal(P.splitError({ ...ok, customShares: [{ who: ME, amount: 1100 }, { who: 'Ali', amount: -100 }] }), 'p.err.custom');
  assert.equal(P.splitError({ ...ok, customShares: [{ who: ME, amount: 300 }, { who: 'Ali', amount: 700 }] }), '');
  for (const lang of ['en', 'tr']) {
    L.use(lang);
    for (const k of ['p.err.name', 'p.err.dupName', 'p.err.payer', 'p.err.custom']) assert.notEqual(L.t(k), k, lang + ' ' + k);
  }
  L.use('en');
});

test('custom split drops zero shares of others but keeps mine', () => {
  const e = entry({ amount: 1000, people: ['Ali', 'Can'], customShares: [{ who: ME, amount: 0 }, { who: 'Ali', amount: 1000 }, { who: 'Can', amount: 0 }] });
  assert.deepEqual(e.shares.map(s => [s.who, s.amount]), [[ME, 0], ['Ali', 1000]]);
  assert.equal(P.myCost(e), 0);
});

test('month report counts my cost per category', () => {
  const p = P.emptyPersonal();
  p.entries.push(entry({ amount: 1000 }), entry({ amount: 3000, people: ['Ali'], category: 'travel' }), entry({ date: '2026-10-30' }));
  const rep = P.monthReport(p, '2026-11');
  assert.equal(rep.entries.length, 2);
  assert.equal(rep.total, 1000 + 1500);
  assert.deepEqual(rep.byCategory.map(c => [c.id, c.amount]), [['travel', 1500], ['food', 1000]]);
});

test('removing an entry hands back its files', () => {
  const p = P.emptyPersonal();
  const e = entry();
  p.entries.push(e);
  const f = P.addFile(p, { entryId: e.id, name: 'r.png', type: 'image/png', size: 10 });
  assert.deepEqual(P.removeEntry(p, e.id), [f]);
  assert.deepEqual(p, P.emptyPersonal());
});

test('backup roundtrip and merge never delete', () => {
  const p = P.emptyPersonal();
  const a = entry({ title: 'A' }), b = entry({ title: 'B' });
  p.entries.push(a, b);
  P.addFile(p, { entryId: a.id, name: 'r.pdf', type: 'application/pdf', size: 10 });
  const back = P.readBackup(JSON.parse(JSON.stringify(P.makeBackup(p, { x: 'data:,' }))));
  assert.deepEqual(back.data, p);
  assert.deepEqual(back.blobs, { x: 'data:,' });
  assert.throws(() => P.readBackup({ app: 'house-cost', data: p }));
  assert.throws(() => P.readBackup({ app: 'house-cost-personal', data: { entries: [{ id: 1 }], files: [] } }));

  const mine = { version: 1, entries: [{ ...a, title: 'A new', updatedAt: a.updatedAt + 5 }, entry({ title: 'C' })], files: [] };
  const got = P.mergePersonal(mine, back.data);
  assert.deepEqual(got, { entries: 1, files: 1 });
  assert.deepEqual(mine.entries.map(e => e.title).sort(), ['A new', 'B', 'C']);
  assert.deepEqual(P.mergePersonal(mine, back.data), { entries: 0, files: 0 });
});

test('every personal category has a name in both languages', () => {
  for (const lang of ['en', 'tr']) {
    L.use(lang);
    for (const [id] of P.PCATEGORIES) assert.notEqual(L.t('pcat.' + id), 'pcat.' + id, lang + ' ' + id);
  }
  L.use('en');
});
