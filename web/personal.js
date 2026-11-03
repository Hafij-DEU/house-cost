// Personal money: my own spending, splits with anyone (not only housemates)
// and the receipts that go with them. It lives only on this device, apart from
// the house state: it is never synced, never in the house file, never in the
// house backup. Pure functions, no DOM; money in integer cents like logic.js.
(function (root) {
  'use strict';
  const H = typeof module !== 'undefined' && module.exports ? require('./logic.js') : root.HouseCost;
  const ME = '@me';

  // [id, emoji, color]; names come from i18n ('pcat.' + id).
  const PCATEGORIES = [
    ['food', '🍽', '#F97316'], ['groceries', '🛒', '#22C55E'], ['transport', '🚌', '#0EA5E9'],
    ['shopping', '🛍', '#EC4899'], ['bills', '🧾', '#EAB308'], ['health', '💊', '#14B8A6'],
    ['fun', '🎉', '#8B5CF6'], ['travel', '✈', '#F43F5E'], ['other', '📦', '#6366F1'],
  ];

  const say = (key, english, vars) => (root.I18n ? root.I18n.t(key, vars) : english);

  function pcategoryOf(id) {
    return PCATEGORIES.find(c => c[0] === id) || PCATEGORIES[PCATEGORIES.length - 1];
  }

  function emptyPersonal() {
    return { version: 1, entries: [], files: [] };
  }

  /** Names to split with: trimmed, empty ones dropped. */
  const cleanNames = names => (names || []).map(n => String(n).trim()).filter(Boolean);

  /**
   * Checks a split before it is saved. people: the other names (not me).
   * customShares: null for an equal split, else [{who, amount}] for me and each name.
   * Returns '' when it is fine, else an i18n key.
   */
  function splitError({ amount, paidBy, people, customShares }) {
    const names = cleanNames(people);
    const lower = names.map(n => n.toLowerCase());
    if (names.some(n => n.startsWith('@'))) return 'p.err.name';
    if (new Set(lower).size !== lower.length) return 'p.err.dupName';
    if (paidBy !== ME && !names.includes(paidBy)) return 'p.err.payer';
    if (customShares) {
      if (customShares.some(s => !(s.amount >= 0))) return 'p.err.custom';
      if (customShares.reduce((t, s) => t + s.amount, 0) !== amount) return 'p.err.custom';
    }
    return '';
  }

  /**
   * Builds an entry. No people: it is all mine (shares stay empty). With people,
   * the payer's own share is paid from the start and the others stay open.
   */
  function makeEntry({ title, amount, date, category, note, paidBy, people, customShares }) {
    const t = H.now();
    const names = cleanNames(people);
    const payer = names.length ? paidBy || ME : ME;
    const raw = !names.length ? []
      : customShares ? customShares.filter(s => s.amount > 0 || s.who === ME)
        : H.splitEqual(amount, [ME, ...names]).map(s => ({ who: s.personId, amount: s.amount }));
    return {
      id: H.uid(),
      title: String(title).trim(),
      amount,
      date: date || H.today(),
      category: pcategoryOf(category)[0],
      note: (note || '').trim(),
      paidBy: payer,
      shares: raw.map(s => ({ who: s.who, amount: s.amount, paid: s.who === payer })),
      updatedAt: t,
    };
  }

  const myShare = e => e.shares.find(s => s.who === ME);
  /** What this entry costs me: my share, or all of it when it is not split. */
  const myCost = e => (e.shares.length ? (myShare(e) || { amount: 0 }).amount : e.amount);
  /** What others still have to pay me for it. */
  const owedToMe = e => (e.paidBy === ME ? e.shares.filter(s => s.who !== ME && !s.paid).reduce((t, s) => t + s.amount, 0) : 0);
  /** What I still have to pay the one who paid it. */
  function iOwe(e) {
    const mine = myShare(e);
    return e.paidBy !== ME && mine && !mine.paid ? mine.amount : 0;
  }

  function monthReport(p, ym) {
    const entries = p.entries.filter(e => e.date.startsWith(ym))
      .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
    const cats = {};
    for (const e of entries) cats[e.category] = (cats[e.category] || 0) + myCost(e);
    const byCategory = Object.entries(cats).filter(([, a]) => a > 0)
      .map(([id, amount]) => ({ id, emoji: pcategoryOf(id)[1], color: pcategoryOf(id)[2], amount }))
      .sort((a, b) => b.amount - a.amount);
    return { entries, total: entries.reduce((t, e) => t + myCost(e), 0), byCategory };
  }

  /** Open money per person, all time: {owedToMe, iOwe, people: [{name, owesMe, iOwe}]}. */
  function balances(p) {
    const by = new Map();
    const row = name => {
      const key = name.toLowerCase();
      if (!by.has(key)) by.set(key, { name, owesMe: 0, iOwe: 0 });
      return by.get(key);
    };
    for (const e of p.entries) {
      if (e.paidBy === ME) for (const s of e.shares) { if (s.who !== ME && !s.paid) row(s.who).owesMe += s.amount; }
      else if (iOwe(e)) row(e.paidBy).iOwe += iOwe(e);
    }
    const people = [...by.values()].filter(r => r.owesMe || r.iOwe).sort((a, b) => b.owesMe + b.iOwe - a.owesMe - a.iOwe);
    return {
      owedToMe: people.reduce((t, r) => t + r.owesMe, 0),
      iOwe: people.reduce((t, r) => t + r.iOwe, 0),
      people,
    };
  }

  function setPaid(p, entryId, who, paid) {
    const e = p.entries.find(x => x.id === entryId);
    const s = e && e.shares.find(x => x.who === who);
    if (!s || who === e.paidBy) return false;
    s.paid = !!paid;
    e.updatedAt = H.now();
    return true;
  }

  /** Marks everything open between me and this person as paid. Returns how many shares changed. */
  function settleWith(p, name) {
    const key = name.toLowerCase();
    let n = 0;
    for (const e of p.entries) {
      let changed = false;
      for (const s of e.shares) {
        if (s.paid) continue;
        const mineToThem = s.who === ME && e.paidBy.toLowerCase() === key;
        const theirsToMe = e.paidBy === ME && s.who.toLowerCase() === key;
        if (mineToThem || theirsToMe) { s.paid = true; changed = true; n++; }
      }
      if (changed) e.updatedAt = H.now();
    }
    return n;
  }

  const filesOf = (p, entryId) => p.files.filter(f => f.entryId === entryId);

  function addFile(p, { entryId, name, type, size }) {
    const rec = { id: H.uid(), entryId, name, type, size, updatedAt: H.now() };
    p.files.push(rec);
    return rec;
  }

  /** Removes an entry and its file records; returns the removed files so their bytes can go too. */
  function removeEntry(p, id) {
    const gone = filesOf(p, id);
    p.entries = p.entries.filter(e => e.id !== id);
    p.files = p.files.filter(f => f.entryId !== id);
    return gone;
  }

  function validatePersonal(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries) || !Array.isArray(data.files)) {
      throw new Error(say('p.err.notData', 'Not personal data.'));
    }
    for (const e of data.entries) {
      if (!e || typeof e.id !== 'string' || typeof e.title !== 'string' || !Number.isInteger(e.amount) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || typeof e.paidBy !== 'string' || !Array.isArray(e.shares) ||
        e.shares.some(s => !s || typeof s.who !== 'string' || !Number.isInteger(s.amount))) {
        throw new Error(say('p.err.badEntry', 'Broken entry in file.'));
      }
    }
    for (const f of data.files) {
      if (!f || typeof f.id !== 'string' || typeof f.entryId !== 'string' || typeof f.name !== 'string' || typeof f.type !== 'string') {
        throw new Error(say('p.err.badEntry', 'Broken entry in file.'));
      }
    }
    return { version: 1, entries: data.entries, files: data.files };
  }

  /**
   * Adds what another copy has: new entries, and newer versions of mine.
   * Nothing is deleted, so restoring an old backup never loses newer entries.
   * Returns {entries, files}: how many came in.
   */
  function mergePersonal(p, other) {
    let entries = 0, files = 0;
    for (const e of other.entries) {
      const at = p.entries.findIndex(x => x.id === e.id);
      if (at < 0) { p.entries.push(e); entries++; }
      else if (e.updatedAt > p.entries[at].updatedAt) { p.entries[at] = e; entries++; }
    }
    const live = new Set(p.entries.map(e => e.id));
    for (const f of other.files) {
      if (live.has(f.entryId) && !p.files.some(x => x.id === f.id)) { p.files.push(f); files++; }
    }
    return { entries, files };
  }

  /** Backup file content; blobs: {fileId: dataUrl} for the attachments on this device. */
  function makeBackup(p, blobs) {
    return { app: 'house-cost-personal', version: 1, savedAt: new Date().toISOString(), data: p, blobs: blobs || {} };
  }

  function readBackup(obj) {
    if (!obj || obj.app !== 'house-cost-personal') throw new Error(say('p.err.notBackup', 'Not a personal backup file.'));
    return { data: validatePersonal(obj.data), blobs: obj.blobs && typeof obj.blobs === 'object' ? obj.blobs : {} };
  }

  const api = {
    ME, PCATEGORIES, pcategoryOf, emptyPersonal, splitError, makeEntry, myCost, owedToMe, iOwe,
    monthReport, balances, setPaid, settleWith, filesOf, addFile, removeEntry,
    validatePersonal, mergePersonal, makeBackup, readBackup,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Personal = api;
})(typeof window !== 'undefined' ? window : globalThis);
