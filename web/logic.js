// House Cost core: pure functions over the state object, no DOM.
// Money is kept in integer cents so splits always add up exactly.
//
// Sync model: every record carries updatedAt (ms). Deletes leave a tombstone
// in state.gone {id: deletedAt}. merge() takes the newer copy of each record,
// so two devices can edit offline and still end up equal.
(function (root) {
  'use strict';

  // [id, label, emoji, color]
  const CATEGORIES = [
    ['groceries', 'Groceries', '🛒', '#22C55E'], ['gas', 'Gas', '🔥', '#F97316'],
    ['electricity', 'Electricity', '💡', '#EAB308'], ['water', 'Water', '🚰', '#0EA5E9'],
    ['internet', 'Internet', '📶', '#8B5CF6'], ['rent', 'Rent', '🏠', '#F43F5E'],
    ['cleaning', 'Cleaning', '🧽', '#14B8A6'], ['repair', 'Repair', '🔧', '#64748B'],
    ['other', 'Other', '📦', '#6366F1'],
  ];

  let clock = 0;
  /** Strictly increasing ms timestamp, so two edits in the same ms still order. */
  function now() {
    clock = Math.max(Date.now(), clock + 1);
    return clock;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function emptyState() {
    return {
      version: 2, deviceId: uid(), meId: null,
      currency: '₺', currencyAt: 0,
      people: [], expenses: [], files: [], gone: {},
    };
  }

  /** "12.5" or "12,50" -> 1250. Returns NaN for anything that is not a positive amount. */
  function parseAmount(text) {
    const clean = String(text).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(clean)) return NaN;
    const cents = Math.round(parseFloat(clean) * 100);
    return cents > 0 ? cents : NaN;
  }

  function formatMoney(cents, currency) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = abs % 100;
    return sign + (currency || '') + whole + (frac ? '.' + String(frac).padStart(2, '0') : '');
  }

  /** Equal split; the leftover cents go one each to the first people in the list. */
  function splitEqual(total, personIds) {
    const n = personIds.length;
    const base = Math.floor(total / n);
    let rest = total - base * n;
    return personIds.map(id => {
      const amount = base + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
      return { personId: id, amount };
    });
  }

  /**
   * Builds an expense. The payer's own share is marked paid from the start;
   * everyone else's share stays open until they pay it back to the payer.
   */
  function makeExpense({ title, amount, payerId, shareIds, date, customShares, category, note, by }) {
    const t = now();
    const shares = customShares
      ? customShares.filter(s => s.amount > 0).map(s => ({ personId: s.personId, amount: s.amount }))
      : splitEqual(amount, shareIds);
    return {
      id: uid(),
      title: title.trim(),
      category: category || 'other',
      note: (note || '').trim(),
      amount,
      payerId,
      date: date || today(),
      updatedAt: t,
      by: by || '',
      shares: shares.map(s => ({ ...s, paid: s.personId === payerId, updatedAt: t })),
    };
  }

  /** Text in the app language when i18n.js is loaded (browser), else the English given. */
  const say = (key, english, vars) => (root.I18n ? root.I18n.t(key, vars) : english);

  function addPerson(state, name) {
    const clean = name.trim();
    if (!clean) return { error: say('err.nameEmpty', 'Enter a name.') };
    if (state.people.some(p => p.name.toLowerCase() === clean.toLowerCase())) {
      return { error: say('err.nameDup', clean + ' is already in the house.', { name: clean }) };
    }
    const person = { id: uid(), name: clean, updatedAt: now() };
    state.people.push(person);
    return { person };
  }

  function renamePerson(state, personId, name) {
    const p = state.people.find(x => x.id === personId);
    if (!p) return;
    p.name = name.trim();
    p.updatedAt = now();
  }

  function removeRecord(state, listName, id) {
    state[listName] = state[listName].filter(x => x.id !== id);
    state.gone[id] = now();
  }

  /** Deletes an expense together with its attached files. */
  function removeExpense(state, id) {
    removeRecord(state, 'expenses', id);
    for (const f of (state.files || []).filter(x => x.expenseId === id)) removeRecord(state, 'files', f.id);
  }

  /** Metadata of a photo/PDF attached to an expense; the bytes live outside the state. */
  function addFile(state, { expenseId, name, type, size, by }) {
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(name) || [, type === 'application/pdf' ? 'pdf' : 'jpg'])[1].toLowerCase();
    const id = uid();
    const file = { id, expenseId, name, type, size, path: 'files/' + id + '.' + ext, updatedAt: now(), by: by || '' };
    (state.files = state.files || []).push(file);
    return file;
  }

  const filesOf = (state, expenseId) => (state.files || []).filter(f => f.expenseId === expenseId);

  function setCurrency(state, symbol) {
    state.currency = symbol;
    state.currencyAt = now();
  }

  function personUsed(state, personId) {
    return state.expenses.some(e => e.payerId === personId || e.shares.some(s => s.personId === personId));
  }

  function markShare(share, paid) {
    share.paid = paid;
    share.paidOn = paid ? today() : undefined;
    share.updatedAt = now();
  }

  function setSharePaid(state, expenseId, personId, paid) {
    const exp = state.expenses.find(e => e.id === expenseId);
    if (!exp || exp.payerId === personId) return;
    const share = exp.shares.find(s => s.personId === personId);
    if (share) markShare(share, paid);
  }

  /** Marks every open share that `fromId` owes `toId` as paid. Returns how many were closed. */
  function settlePair(state, fromId, toId) {
    let count = 0;
    for (const exp of state.expenses) {
      if (exp.payerId !== toId) continue;
      for (const s of exp.shares) {
        if (s.personId === fromId && !s.paid) {
          markShare(s, true);
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Per person:
   *   spent    - money they paid at the shop
   *   share    - their own portion of all costs
   *   owes     - open shares they still have to pay back to others
   *   owed     - open shares others still have to pay back to them
   *   net      - owed - owes (positive: gets money back)
   */
  function summary(state) {
    const rows = {};
    const blank = person => ({ person, spent: 0, share: 0, owes: 0, owed: 0, net: 0 });
    for (const p of state.people) rows[p.id] = blank(p);
    const row = id => rows[id] || (rows[id] = blank({ id, name: '(removed)' }));

    for (const exp of state.expenses) {
      row(exp.payerId).spent += exp.amount;
      for (const s of exp.shares) {
        row(s.personId).share += s.amount;
        if (!s.paid && s.personId !== exp.payerId) {
          row(s.personId).owes += s.amount;
          row(exp.payerId).owed += s.amount;
        }
      }
    }
    for (const r of Object.values(rows)) r.net = r.owed - r.owes;
    return Object.values(rows);
  }

  /**
   * Open debts between each pair, netted both ways: if A owes B 100 and B owes
   * A 30, the result is one line "A pays B 70" with the gross amounts behind it.
   */
  function pairDebts(state) {
    const raw = new Map(); // "from|to" -> cents
    for (const exp of state.expenses) {
      for (const s of exp.shares) {
        if (s.paid || s.personId === exp.payerId) continue;
        const key = s.personId + '|' + exp.payerId;
        raw.set(key, (raw.get(key) || 0) + s.amount);
      }
    }
    const done = new Set();
    const out = [];
    for (const [key, amount] of raw) {
      if (done.has(key)) continue;
      const [from, to] = key.split('|');
      const backKey = to + '|' + from;
      const back = raw.get(backKey) || 0;
      done.add(key);
      done.add(backKey);
      const diff = amount - back;
      if (diff > 0) out.push({ from, to, amount: diff, gross: amount, offset: back });
      else if (diff < 0) out.push({ from: to, to: from, amount: -diff, gross: back, offset: amount });
    }
    return out.sort((a, b) => b.amount - a.amount);
  }

  /** Shares `fromId` still owes `toId`, newest first. */
  function openShares(state, fromId, toId) {
    const list = [];
    for (const exp of state.expenses) {
      if (exp.payerId !== toId) continue;
      for (const s of exp.shares) {
        if (s.personId === fromId && !s.paid) list.push({ expense: exp, amount: s.amount });
      }
    }
    return list.sort((a, b) => b.expense.date.localeCompare(a.expense.date));
  }

  const categoryOf = id => CATEGORIES.find(c => c[0] === id) || CATEGORIES[CATEGORIES.length - 1];

  /**
   * Everything about one month ("2026-11"): its expenses (newest first), the
   * total, spend per category and per day, and each person's part in it.
   */
  function monthReport(state, ym) {
    const expenses = state.expenses.filter(e => e.date.startsWith(ym))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const cats = new Map(), days = {}, people = new Map();
    const row = id => people.get(id) || people.set(id, { personId: id, spent: 0, share: 0, owes: 0, owed: 0 }).get(id);
    for (const p of state.people) row(p.id);
    let total = 0;
    for (const e of expenses) {
      total += e.amount;
      const cat = categoryOf(e.category)[0];
      cats.set(cat, (cats.get(cat) || 0) + e.amount);
      const day = days[e.date] || (days[e.date] = { total: 0, cats: [] });
      day.total += e.amount;
      if (!day.cats.includes(cat)) day.cats.push(cat);
      row(e.payerId).spent += e.amount;
      for (const s of e.shares) {
        row(s.personId).share += s.amount;
        if (!s.paid && s.personId !== e.payerId) {
          row(s.personId).owes += s.amount;
          row(e.payerId).owed += s.amount;
        }
      }
    }
    const byCategory = CATEGORIES.filter(c => cats.has(c[0]))
      .map(([id, label, emoji, color]) => ({ id, label: say('cat.' + id, label), emoji, color, amount: cats.get(id) }))
      .sort((a, b) => b.amount - a.amount);
    return { ym, expenses, total, byCategory, days, people: [...people.values()] };
  }

  // ---------- sync ----------

  /** Newer expense wins; paid ticks still merge per share when the share itself did not change. */
  function mergeExpense(a, b) {
    const [win, lose] = (b.updatedAt || 0) > (a.updatedAt || 0) ? [b, a] : [a, b];
    const out = JSON.parse(JSON.stringify(win));
    if (win.payerId !== lose.payerId) return out;
    for (const s of out.shares) {
      const other = lose.shares.find(o => o.personId === s.personId);
      if (other && other.amount === s.amount && (other.updatedAt || 0) > (s.updatedAt || 0)) {
        s.paid = other.paid;
        s.paidOn = other.paidOn;
        s.updatedAt = other.updatedAt;
      }
    }
    return out;
  }

  function mergeList(mine, theirs, gone, mergeOne) {
    const byId = new Map(mine.map(x => [x.id, x]));
    for (const t of theirs) {
      const m = byId.get(t.id);
      byId.set(t.id, m ? mergeOne(m, t) : JSON.parse(JSON.stringify(t)));
    }
    return [...byId.values()].filter(x => !(gone[x.id] >= (x.updatedAt || 0)));
  }

  /**
   * Merges another device's copy into `state` (in place). meId and deviceId
   * stay local: each phone knows who its own owner is. Returns true when
   * anything changed.
   */
  function merge(state, other) {
    const before = fingerprint(state);
    const gone = { ...state.gone };
    for (const [id, at] of Object.entries(other.gone || {})) gone[id] = Math.max(gone[id] || 0, at);
    state.gone = gone;
    state.people = mergeList(state.people, other.people || [], gone,
      (a, b) => JSON.parse(JSON.stringify((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)));
    state.expenses = mergeList(state.expenses, other.expenses || [], gone, mergeExpense);
    state.files = mergeList(state.files || [], other.files || [], gone,
      (a, b) => JSON.parse(JSON.stringify((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)));
    if ((other.currencyAt || 0) > (state.currencyAt || 0)) {
      state.currency = other.currency;
      state.currencyAt = other.currencyAt;
    }
    if (state.meId && gone[state.meId] && !state.people.some(p => p.id === state.meId)) state.meId = null;
    return fingerprint(state) !== before;
  }

  /** The synced part of the state, in a stable order (used to detect changes). */
  function fingerprint(state) {
    const sort = list => [...list].sort((a, b) => a.id.localeCompare(b.id));
    const gone = state.gone || {};
    return JSON.stringify([state.currency, sort(state.people || []), sort(state.expenses || []),
      sort(state.files || []), Object.keys(gone).sort().map(k => k + gone[k])]);
  }

  /** True when two states (or exported files) hold the same shared data. */
  function sameShared(a, b) {
    return fingerprint(a) === fingerprint(b);
  }

  /** What a device publishes for the others: everything except its local identity. */
  function exportShared(state) {
    return {
      app: 'house-cost', version: 2, deviceId: state.deviceId, exportedAt: Date.now(),
      currency: state.currency, currencyAt: state.currencyAt,
      people: state.people, expenses: state.expenses, files: state.files || [], gone: state.gone,
    };
  }

  /** Accepts a saved state, a sync/export file or an old v1 backup; throws on anything else. */
  function validateState(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.people) || !Array.isArray(data.expenses)) {
      throw new Error(say('err.notFile', 'Not a House Cost file.'));
    }
    const ids = new Set(data.people.map(p => p.id));
    for (const p of data.people) {
      if (typeof p.id !== 'string' || typeof p.name !== 'string') throw new Error(say('err.badPerson', 'Broken person in file.'));
    }
    for (const e of data.expenses) {
      if (!ids.has(e.payerId) || !Array.isArray(e.shares) || !Number.isInteger(e.amount)) {
        throw new Error(say('err.badExpense', 'Broken expense in file: ' + (e.title || e.id), { name: e.title || e.id }));
      }
      e.updatedAt = e.updatedAt || 1;
      e.category = e.category || 'other';
      e.note = e.note || '';
      for (const s of e.shares) s.updatedAt = s.updatedAt || 1;
    }
    for (const p of data.people) p.updatedAt = p.updatedAt || 1;
    const files = Array.isArray(data.files) ? data.files : [];
    for (const f of files) {
      if (typeof f.id !== 'string' || typeof f.path !== 'string' || !/^files\/[\w.-]+$/.test(f.path)) throw new Error(say('err.badFile', 'Broken file entry.'));
      f.updatedAt = f.updatedAt || 1;
    }
    return {
      version: 2,
      deviceId: data.deviceId || uid(),
      meId: ids.has(data.meId) ? data.meId : null,
      currency: data.currency || '₺',
      currencyAt: data.currencyAt || 0,
      people: data.people,
      expenses: data.expenses,
      files,
      gone: data.gone && typeof data.gone === 'object' ? data.gone : {},
    };
  }

  const api = {
    CATEGORIES, categoryOf, now, uid, today, emptyState, parseAmount, formatMoney, splitEqual, makeExpense,
    addPerson, renamePerson, removeRecord, removeExpense, addFile, filesOf, setCurrency, personUsed,
    setSharePaid, settlePair, summary, pairDebts, openShares, monthReport, merge, sameShared,
    exportShared, validateState,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HouseCost = api;
})(typeof window !== 'undefined' ? window : globalThis);
