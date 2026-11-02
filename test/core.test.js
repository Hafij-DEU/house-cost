// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../web/logic.js');
const G = require('../web/gh-sync.js');
const X = require('../web/export.js');

const clone = x => JSON.parse(JSON.stringify(x));

function house() {
  const s = H.emptyState();
  const a = H.addPerson(s, 'Hafij').person, b = H.addPerson(s, 'Rakib').person, c = H.addPerson(s, 'Sami').person;
  s.meId = a.id;
  return { s, a, b, c };
}

test('equal split gives remainder cents to the first people', () => {
  const sp = H.splitEqual(1000, ['x', 'y', 'z']);
  assert.deepEqual(sp.map(s => s.amount), [334, 333, 333]);
  assert.equal(sp.reduce((t, s) => t + s.amount, 0), 1000);
});

test('balances: payer is owed, others owe until paid back', () => {
  const { s, a, b, c } = house();
  const e = H.makeExpense({ title: 'Gas', amount: 900, payerId: a.id, shareIds: [a.id, b.id, c.id], date: '2026-11-02', category: 'gas' });
  s.expenses.push(e);
  let me = H.summary(s).find(r => r.person.id === a.id);
  assert.equal(me.owed, 600);
  assert.equal(H.openShares(s, b.id, a.id).length, 1);
  H.setSharePaid(s, e.id, b.id, true);
  me = H.summary(s).find(r => r.person.id === a.id);
  assert.equal(me.owed, 300);
  // Rakib pays a bill for Hafij and Rakib; debts net per pair.
  s.expenses.push(H.makeExpense({ title: 'Net', amount: 400, payerId: b.id, shareIds: [a.id, b.id], date: '2026-11-03' }));
  const d = H.pairDebts(s);
  assert.deepEqual(d.map(x => [x.from, x.to, x.amount]).sort(), [[a.id, b.id, 200], [c.id, a.id, 300]].sort());
  assert.equal(H.settlePair(s, c.id, a.id), 1);
  assert.equal(H.pairDebts(s).length, 1);
});

test('monthReport: totals, categories, days and people', () => {
  const { s, a, b } = house();
  s.expenses.push(H.makeExpense({ title: 'Rice', amount: 1000, payerId: a.id, shareIds: [a.id, b.id], date: '2026-11-02', category: 'groceries' }));
  s.expenses.push(H.makeExpense({ title: 'Oil', amount: 500, payerId: b.id, shareIds: [a.id, b.id], date: '2026-11-02', category: 'groceries' }));
  s.expenses.push(H.makeExpense({ title: 'Wifi', amount: 3000, payerId: a.id, shareIds: [a.id, b.id], date: '2026-11-10', category: 'internet' }));
  s.expenses.push(H.makeExpense({ title: 'Old', amount: 7, payerId: a.id, shareIds: [a.id], date: '2026-10-31' }));
  const r = H.monthReport(s, '2026-11');
  assert.equal(r.total, 4500);
  assert.equal(r.expenses.length, 3);
  assert.equal(r.expenses[0].title, 'Wifi');
  assert.deepEqual(r.byCategory.map(c => [c.id, c.amount]), [['internet', 3000], ['groceries', 1500]]);
  assert.equal(r.days['2026-11-02'].total, 1500);
  const me = r.people.find(p => p.personId === a.id);
  assert.equal(me.spent, 4000);
  assert.equal(me.share, 2250);
});

test('merge: two offline devices converge, deletes and files travel', () => {
  const { s: one, a, b } = house();
  const two = clone(one);
  two.deviceId = 'other';
  const e = H.makeExpense({ title: 'Gas', amount: 600, payerId: a.id, shareIds: [a.id, b.id], date: '2026-11-02' });
  one.expenses.push(e);
  const f = H.addFile(one, { expenseId: e.id, name: 'bill.JPG', type: 'image/jpeg', size: 10 });
  assert.match(f.path, /^files\/[\w]+\.jpg$/);
  H.merge(two, clone(H.exportShared(one)));
  assert.equal(H.filesOf(two, e.id).length, 1);
  // Device two ticks a share, device one renames a person meanwhile.
  H.setSharePaid(two, e.id, b.id, true);
  H.renamePerson(one, b.id, 'Rakibul');
  H.merge(one, clone(H.exportShared(two)));
  H.merge(two, clone(H.exportShared(one)));
  assert.ok(H.sameShared(H.exportShared(one), H.exportShared(two)));
  assert.equal(one.expenses[0].shares.find(x => x.personId === b.id).paid, true);
  assert.equal(two.people.find(p => p.id === b.id).name, 'Rakibul');
  // Deleting the expense removes its file everywhere.
  H.removeExpense(two, e.id);
  H.merge(one, clone(H.exportShared(two)));
  assert.equal(one.expenses.length, 0);
  assert.equal(one.files.length, 0);
  assert.equal(one.meId, a.id, 'meId stays local');
});

test('validateState rejects path traversal in file paths', () => {
  const { s } = house();
  s.files = [{ id: 'x', expenseId: 'e', name: 'a', type: 'image/png', size: 1, path: '../.github/workflows/x.yml', updatedAt: 1 }];
  assert.throws(() => H.validateState(clone(s)));
});

test('xlsx export is a valid zip with parseable XML', () => {
  const { s, a, b } = house();
  const e = H.makeExpense({ title: 'Gas <cyl> & co', amount: 1250, payerId: a.id, shareIds: [a.id, b.id], date: '2026-11-02', category: 'gas', note: 'line1\nline2' });
  s.expenses.push(e);
  H.addFile(s, { expenseId: e.id, name: 'r.pdf', type: 'application/pdf', size: 5 });
  const bytes = X.monthWorkbook(s, '2026-11');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  const file = path.join(dir, 'm.xlsx');
  fs.writeFileSync(file, bytes);
  execFileSync('unzip', ['-tq', file]);
  execFileSync('unzip', ['-q', file, '-d', path.join(dir, 'x')]);
  const parts = execFileSync('find', [path.join(dir, 'x'), '-name', '*.xml', '-o', '-name', '*.rels']).toString().trim().split('\n');
  assert.ok(parts.length >= 6);
  execFileSync('python3', ['-I', '-c', 'import sys,xml.dom.minidom as m\nfor p in sys.argv[1:]: m.parse(p)', ...parts]);
  const sheet = fs.readFileSync(path.join(dir, 'x/xl/worksheets/sheet1.xml'), 'utf8');
  assert.match(sheet, /Gas &lt;cyl&gt; &amp; co/);
  fs.rmSync(dir, { recursive: true });
});

test('month web page escapes text and embeds images', () => {
  const { s, a, b } = house();
  const e = H.makeExpense({ title: '<script>x</script>', amount: 100, payerId: a.id, shareIds: [a.id, b.id], date: '2026-11-02' });
  s.expenses.push(e);
  const f = H.addFile(s, { expenseId: e.id, name: 'p.jpg', type: 'image/jpeg', size: 3 });
  const html = X.monthPage(s, '2026-11', { [f.id]: 'data:image/jpeg;base64,AAAA' });
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('data:image/jpeg;base64,AAAA'));
});

// ---- mock GitHub contents API ----
function mockGithub() {
  const files = new Map(); // path -> {content(base64), sha}
  let n = 0, raceOnce = false;
  const log = [];
  const res = (status, body, raw) => ({
    status, ok: status >= 200 && status < 300, statusText: String(status),
    json: async () => body, text: async () => raw, arrayBuffer: async () => Buffer.from(raw || '', 'binary'),
  });
  async function fetchImpl(url, opt = {}) {
    const u = new URL(url);
    const method = opt.method || 'GET';
    log.push(method + ' ' + u.pathname);
    if (!u.pathname.includes('/contents/')) return res(200, {});
    const p = decodeURIComponent(u.pathname.split('/contents/')[1]);
    const f = files.get(p);
    if (method === 'GET') {
      if (!f) return res(404, { message: 'Not Found' });
      if ((opt.headers.Accept || '').includes('raw')) return res(200, null, Buffer.from(f.content, 'base64').toString('binary'));
      return res(200, { sha: f.sha, content: f.content });
    }
    const body = JSON.parse(opt.body);
    if (method === 'PUT') {
      if (raceOnce && p === 'house-cost.json') {
        raceOnce = false;
        // Someone else commits just before us.
        const other = JSON.parse(Buffer.from(files.get(p).content, 'base64').toString());
        other.people.push({ id: 'zz', name: 'Late', updatedAt: Date.now() + 5 });
        files.set(p, { content: Buffer.from(JSON.stringify(other)).toString('base64'), sha: 's' + ++n });
      }
      if (f && body.sha !== files.get(p).sha) return res(body.sha ? 409 : 422, { message: 'sha' });
      files.set(p, { content: body.content, sha: 's' + ++n });
      return res(201, { content: { sha: 's' + n } });
    }
    if (method === 'DELETE') {
      if (!f) return res(404, {});
      files.delete(p);
      return res(200, {});
    }
  }
  return { files, fetchImpl, log, race: () => (raceOnce = true) };
}

test('gh sync: first push, merge from a second device, conflict retry', async () => {
  const gh = mockGithub();
  const cfg = { owner: 'o', repo: 'r', path: 'house-cost.json', token: 't', api: 'https://api.test' };
  const c1 = G.client(cfg, gh.fetchImpl), c2 = G.client(cfg, gh.fetchImpl);
  const { s: one, a, b } = house();
  one.expenses.push(H.makeExpense({ title: 'Rice', amount: 200, payerId: a.id, shareIds: [a.id, b.id], date: '2026-11-02' }));
  assert.deepEqual(await G.syncRound(c1, H, one, 'm'), { pulledChanges: false, pushed: true });

  const two = H.emptyState();
  let r = await G.syncRound(c2, H, two, 'm');
  assert.equal(r.pulledChanges, true);
  assert.equal(r.pushed, false);
  assert.equal(two.expenses[0].title, 'Rice');

  two.expenses.push(H.makeExpense({ title: 'Gas', amount: 900, payerId: b.id, shareIds: [a.id, b.id], date: '2026-11-03' }));
  gh.race();
  r = await G.syncRound(c2, H, two, 'm');
  assert.equal(r.pushed, true);
  assert.ok(two.people.some(p => p.name === 'Late'), 'merged the racing commit');
  await G.syncRound(c1, H, one, 'm');
  assert.ok(H.sameShared(H.exportShared(one), H.exportShared(two)));
});

test('gh files: upload once, download bytes, delete', async () => {
  const gh = mockGithub();
  const c = G.client({ owner: 'o', repo: 'r', path: 'house-cost.json', token: 't', api: 'https://api.test' }, gh.fetchImpl);
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  assert.equal(await c.putFile('files/a.jpg', bytes.toString('base64'), 'x'), true);
  assert.equal(await c.putFile('files/a.jpg', bytes.toString('base64'), 'x'), false);
  assert.deepEqual([...await c.getFile('files/a.jpg')], [...bytes]);
  assert.equal(await c.getFile('files/none.jpg'), null);
  assert.equal(await c.deleteFile('files/a.jpg', 'x'), true);
  assert.equal(await c.deleteFile('files/a.jpg', 'x'), false);
});
