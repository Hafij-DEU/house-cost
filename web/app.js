// House Cost UI. Offline first: the data always lives on this device
// (localStorage, attachments in IndexedDB); GitHub sync runs when you ask for
// it, or automatically when "Auto sync" is on and the device is online.
(function () {
  'use strict';
  const H = window.HouseCost, G = window.GhSync, X = window.HouseExport, FS = window.FileStore;
  const L = window.I18n, T = L.t;
  const KEY = 'housecost.v1', GH_KEY = 'housecost.gh', SYNC_KEY = 'housecost.sync';
  const DATA_PATH = 'house-cost.json';
  const MAX_FILE = 15 * 1024 * 1024;
  const host = window.HouseCostHost || null; // injected by the Android app
  const $ = id => document.getElementById(id);

  let state = load();
  let sync = loadSync();
  let curYm = H.today().slice(0, 7);
  let selDay = null;
  let tab = 'home';
  const openExp = new Set(), openPanels = new Set();

  // ---------- storage ----------
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return H.validateState(JSON.parse(raw));
    } catch (e) {
      console.error('Could not load saved data', e);
    }
    return H.emptyState();
  }

  function store() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      toast(T('err.save', { msg: e.message }));
    }
  }

  /** Local sync bookkeeping: unsynced change count, their descriptions, uploaded attachments. */
  function loadSync() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { /* fresh */ }
    return { pending: s.pending || 0, log: s.log || [], lastAt: s.lastAt || 0, uploaded: s.uploaded || [], trash: s.trash || [] };
  }
  const storeSync = () => localStorage.setItem(SYNC_KEY, JSON.stringify(sync));

  /** Every change goes through here: save locally, remember it for the next sync, redraw. */
  function save(what) {
    store();
    sync.pending++;
    if (what) sync.log = [...sync.log, what].slice(-30);
    storeSync();
    render();
    if (ghCfg() && ghCfg().auto) scheduleAutoSync();
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fmt = c => L.money(H.formatMoney(c, state.currency));
  const money = c => esc(fmt(c));
  const nameOf = id => (state.people.find(p => p.id === id) || { name: T('removed') }).name;
  const isMe = id => id && id === state.meId;
  const label = id => (isMe(id) ? T('you') : esc(nameOf(id)));
  const myName = () => (state.people.find(p => p.id === state.meId) || { name: '' }).name;

  function hue(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }
  const avatar = p => `<span class="avatar" style="--av:hsl(${hue(p.name)} 65% 52%)">${esc((p.name[0] || '?').toUpperCase())}</span>`;

  function shortMoney(c) {
    const v = c / 100;
    if (v >= 100000) return Math.round(v / 1000) + 'k';
    if (v >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }

  function prettyDate(iso, withYear) {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(L.locale, { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  }

  function shiftYm(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return T('ago.now');
    if (s < 3600) return T('ago.min', { n: Math.round(s / 60) });
    if (s < 86400) return T('ago.h', { n: Math.round(s / 3600) });
    return new Date(ms).toLocaleString(L.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function size(n) {
    return L.money(n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /** Confirm dialog; resolves true when the user taps the OK button. */
  function ask(title, bodyHtml, okText) {
    const dlg = $('confirmDlg');
    $('cTitle').textContent = title;
    $('cBody').innerHTML = bodyHtml || '';
    $('cOk').textContent = okText || 'OK';
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  /** Hands a file to the user: share sheet / save on Android, download (or Web Share) in a browser. */
  async function deliver(name, mime, bytes, how) {
    if (host) {
      const b64 = bytesToBase64(bytes);
      if (how === 'save' && host.saveFile) host.saveFile(name, mime, b64);
      else if (how === 'open' && host.openFile) host.openFile(name, mime, b64);
      else host.shareFile(name, mime, b64);
      return;
    }
    const file = new File([bytes], name, { type: mime });
    if (how === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(T('toast.savedFile', { name }));
  }

  // ---------- tabs + back ----------
  function showTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $('monthNav').classList.toggle('hidden', name !== 'home');
    $('fab').classList.toggle('hidden', name === 'people');
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Android back button: close the sheet, then go Home, then leave the app.
  window.__houseBack = () => {
    const dlg = document.querySelector('dialog[open]');
    if (dlg) { dlg.close('cancel'); return true; }
    if ($('sheet').classList.contains('open')) { closeSheet(); return true; }
    if (tab !== 'home') { showTab('home'); return true; }
    return false;
  };

  // ---------- render ----------
  function render() {
    renderHome();
    renderBalances();
    renderPeople();
    renderSyncUi();
  }

  function setupHint() {
    if (state.people.length < 2) return T('hint.addPeople');
    if (!state.people.some(p => p.id === state.meId)) return T('hint.pickMe');
    return '';
  }

  // ---------- home ----------
  function renderHome() {
    const hint = setupHint();
    $('setupHint').innerHTML = hint;
    $('setupHint').classList.toggle('hidden', !hint);

    $('mLabel').textContent = X.monthName(curYm);
    const rep = H.monthReport(state, curYm);
    const prev = H.monthReport(state, shiftYm(curYm, -1)).total;
    $('monthTotal').textContent = fmt(rep.total);
    let sub = T('n.expense', { n: rep.expenses.length });
    if (prev && rep.total) {
      const pct = Math.round((rep.total - prev) * 100 / prev);
      sub += ' · ' + T('home.vs', { arrow: pct >= 0 ? '▲' : '▼', pct: Math.abs(pct) });
    }
    $('monthSub').textContent = sub;
    const mine = rep.people.find(r => r.personId === state.meId);
    $('myMonthShare').textContent = mine ? fmt(mine.share) : '–';
    document.querySelector('.hero-side').classList.toggle('hidden', !mine);

    $('catBar').innerHTML = rep.byCategory.map(c => `<span style="flex:${c.amount};background:${c.color}" title="${esc(L.cat(c.id))}"></span>`).join('');
    $('catBar').classList.toggle('hidden', !rep.total);
    $('catLegend').innerHTML = rep.byCategory.map(c =>
      `<span class="lg"><i style="background:${c.color}"></i>${c.emoji} ${esc(L.cat(c.id))} <b>${money(c.amount)}</b> <span class="muted">${Math.round(c.amount * 100 / rep.total)}%</span></span>`).join('');

    renderCalendar(rep);
    renderList(rep);
  }

  function renderCalendar(rep) {
    if (!$('calHead').childElementCount) {
      // Monday first; names in the device language.
      $('calHead').innerHTML = [...Array(7)].map((_, i) =>
        `<span>${new Date(2024, 0, 1 + i).toLocaleDateString(L.locale, { weekday: 'narrow' })}</span>`).join('');
    }
    const [y, m] = curYm.split('-').map(Number);
    const first = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    const count = new Date(y, m, 0).getDate();
    const max = Math.max(0, ...Object.values(rep.days).map(d => d.total));
    const today = H.today();
    let html = '<span class="day out"></span>'.repeat(first);
    for (let d = 1; d <= count; d++) {
      const iso = curYm + '-' + String(d).padStart(2, '0');
      const info = rep.days[iso];
      const cls = ['day'];
      let style = '', extra = '';
      if (info) {
        const heat = Math.round(14 + 66 * Math.sqrt(info.total / max));
        cls.push('has');
        if (heat > 52) cls.push('hot');
        style = `--heat:${heat}%`;
        extra = `<span class="amt">${shortMoney(info.total)}</span><span class="dots">${info.cats.slice(0, 4)
          .map(c => `<i style="background:${H.categoryOf(c)[3]}"></i>`).join('')}</span>`;
      }
      if (iso === today) cls.push('today');
      if (iso === selDay) cls.push('sel');
      html += `<button class="${cls.join(' ')}" style="${style}" data-day="${iso}">${d}${extra}</button>`;
    }
    $('calGrid').innerHTML = html;
  }

  function renderList(rep) {
    const list = selDay ? rep.expenses.filter(e => e.date === selDay) : rep.expenses;
    $('listTitle').textContent = selDay ? prettyDate(selDay) : T('list.all');
    $('dayClear').classList.toggle('hidden', !selDay);
    if (!list.length) {
      $('expenseList').innerHTML = `<div class="empty"><span class="big">🧾</span>${selDay ? T('list.emptyDay') : T('list.emptyMonth', { month: esc(X.monthName(curYm)) })}<br>${T('list.tapAdd')}</div>`;
      return;
    }
    let html = '', lastDate = '';
    for (const e of list) {
      if (e.date !== lastDate && !selDay) {
        lastDate = e.date;
        const dayTotal = list.filter(x => x.date === e.date).reduce((s, x) => s + x.amount, 0);
        html += `<div class="day-group"><span>${prettyDate(e.date)}</span><span>${money(dayTotal)}</span></div>`;
      }
      html += expenseCard(e);
    }
    $('expenseList').innerHTML = html;
    loadThumbs($('expenseList'));
  }

  function expenseCard(e) {
    const cat = H.categoryOf(e.category);
    const open = e.shares.filter(s => !s.paid && s.personId !== e.payerId).reduce((a, s) => a + s.amount, 0);
    const files = H.filesOf(state, e.id);
    const chips = e.shares.map(s => {
      if (s.personId === e.payerId) return `<span class="chip payer">${label(s.personId)} ${money(s.amount)} · ${T('chip.paidIt')}</span>`;
      return `<button class="chip ${s.paid ? 'paid' : 'unpaid'}" data-toggle="${e.id}|${s.personId}" title="${T('chip.tap')}">
        ${s.paid ? '✓' : '○'} ${label(s.personId)} ${money(s.amount)} ${s.paid ? T('chip.paidBack') : T('chip.owes')}</button>`;
    }).join('');
    return `<div class="exp ${openExp.has(e.id) ? 'open' : ''}" style="--cat:${cat[3]}" data-exp="${e.id}">
      <div class="exp-row" data-open="${e.id}">
        <span class="exp-ic">${cat[2]}</span>
        <span class="exp-main"><b>${esc(e.title)}</b>
          <small>${esc(L.cat(cat[0]))} · ${T('card.paidBy', { name: label(e.payerId) })} · ${T('n.person', { n: e.shares.length })}${files.length ? ' · 📎' + files.length : ''}</small></span>
        <span class="exp-amt"><b>${money(e.amount)}</b>
          ${e.shares.length > 1 ? (open ? `<small class="neg">${T('card.open', { amt: money(open) })}</small>` : `<small class="pos">${T('card.settled')}</small>`) : ''}</span>
      </div>
      <div class="exp-body">
        ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
        <div class="chips">${chips}</div>
        ${files.length ? `<div class="thumbs">${files.map(thumb).join('')}</div>` : ''}
        <div class="stamp">${e.by ? T('card.savedBy', { name: esc(e.by) }) + ' · ' : ''}${T('card.lastChange', { ago: esc(ago(e.updatedAt)) })}</div>
        <div class="exp-actions"><button class="small" data-edit="${e.id}">${T('act.edit')}</button><button class="small" data-del="${e.id}">${T('act.delete')}</button></div>
      </div></div>`;
  }

  const thumb = f => `<button type="button" class="thumb ${f.type === 'application/pdf' ? 'pdf' : ''}" data-file="${f.id}" title="${esc(f.name)}">${f.type.startsWith('image/') ? '' : esc(f.name.slice(0, 18))}</button>`;

  // Object URLs of local images, made once per file.
  const thumbUrls = new Map();
  async function loadThumbs(root) {
    for (const el of root.querySelectorAll('.thumb[data-file]')) {
      const f = state.files.find(x => x.id === el.dataset.file);
      if (!f || !f.type.startsWith('image/')) continue;
      let url = thumbUrls.get(f.id);
      if (!url) {
        const blob = await FS.get(f.id).catch(() => null);
        if (!blob) { el.textContent = '☁ ' + f.name.slice(0, 14); continue; }
        url = URL.createObjectURL(blob);
        thumbUrls.set(f.id, url);
      }
      el.style.backgroundImage = `url("${url}")`;
    }
  }

  $('mPrev').addEventListener('click', () => { curYm = shiftYm(curYm, -1); selDay = null; renderHome(); });
  $('mNext').addEventListener('click', () => { curYm = shiftYm(curYm, 1); selDay = null; renderHome(); });
  $('dayClear').addEventListener('click', () => { selDay = null; renderHome(); });
  $('calGrid').addEventListener('click', e => {
    const d = e.target.closest('[data-day]');
    if (!d) return;
    selDay = selDay === d.dataset.day ? null : d.dataset.day;
    renderHome();
  });

  $('expenseList').addEventListener('click', async e => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const [expId, personId] = t.dataset.toggle.split('|');
      const exp = state.expenses.find(x => x.id === expId);
      const share = exp.shares.find(s => s.personId === personId);
      H.setSharePaid(state, expId, personId, !share.paid);
      const msg = T(share.paid ? 'log.paidBack' : 'log.notPaidBack', { who: nameOf(personId), payer: nameOf(exp.payerId), title: exp.title });
      toast(msg);
      save(msg);
      return;
    }
    const f = e.target.closest('[data-file]');
    if (f) return viewFile(f.dataset.file);
    const ed = e.target.closest('[data-edit]');
    if (ed) return openSheet(ed.dataset.edit);
    const del = e.target.closest('[data-del]');
    if (del) {
      const exp = state.expenses.find(x => x.id === del.dataset.del);
      const nFiles = H.filesOf(state, exp.id).length;
      if (!await ask(T('del.q'), `<div class="sum-line"><span>${esc(exp.title)}</span><b>${money(exp.amount)}</b></div>` +
        (nFiles ? `<p class="muted">${T('del.files', { n: nFiles })}</p>` : ''), T('del.ok'))) return;
      trashFiles(H.filesOf(state, exp.id));
      H.removeExpense(state, exp.id);
      toast(T('toast.deleted'));
      save(T('log.deleted', { title: exp.title, amt: fmt(exp.amount) }));
      return;
    }
    const row = e.target.closest('[data-open]');
    if (row) {
      const id = row.dataset.open;
      if (openExp.has(id)) openExp.delete(id); else openExp.add(id);
      row.parentElement.classList.toggle('open');
    }
  });

  // ---------- attachments ----------
  /** Remembers deleted attachments so the next sync can remove them from the repo too. */
  function trashFiles(files) {
    for (const f of files) {
      sync.trash.push({ id: f.id, path: f.path });
      FS.del(f.id).catch(() => {});
      if (thumbUrls.has(f.id)) { URL.revokeObjectURL(thumbUrls.get(f.id)); thumbUrls.delete(f.id); }
    }
    storeSync();
  }

  /** The bytes of an attachment: from this device, or downloaded from GitHub and kept. */
  async function fileBlob(f) {
    const local = await FS.get(f.id).catch(() => null);
    if (local) return local;
    const gh = ghClient();
    if (!gh || !navigator.onLine) return null;
    const bytes = await gh.getFile(f.path);
    if (!bytes) return null;
    const blob = new Blob([bytes], { type: f.type });
    await FS.put(f.id, blob);
    if (!sync.uploaded.includes(f.id)) { sync.uploaded.push(f.id); storeSync(); }
    return blob;
  }

  let viewing = null;
  async function viewFile(id) {
    const f = state.files.find(x => x.id === id);
    if (!f) return;
    let blob;
    try {
      blob = await fileBlob(f);
    } catch (e) {
      return toast(T('file.dlErr', { msg: e.message }));
    }
    if (!blob) return toast(T(ghClient() ? 'file.notHere' : 'file.otherPhone'));
    if (viewing) URL.revokeObjectURL(viewing.url);
    viewing = { f, blob, url: URL.createObjectURL(blob) };
    $('vName').textContent = f.name;
    $('vBody').innerHTML = f.type.startsWith('image/')
      ? `<img src="${viewing.url}" alt="${esc(f.name)}">`
      : `<div class="empty"><span class="big">📄</span>${esc(f.name)}<br>${size(blob.size)}</div>`;
    $('viewDlg').showModal();
    loadThumbs($('expenseList'));
  }
  $('vOpen').addEventListener('click', async () => {
    if (!viewing) return;
    if (host) return deliver(viewing.f.name, viewing.f.type, new Uint8Array(await viewing.blob.arrayBuffer()), 'open');
    window.open(viewing.url, '_blank', 'noopener');
  });
  $('vShare').addEventListener('click', async () => {
    if (viewing) deliver(viewing.f.name, viewing.f.type, new Uint8Array(await viewing.blob.arrayBuffer()), 'share');
  });

  // ---------- add / edit sheet ----------
  let editingId = null, formCat = 'groceries', formFiles = [], formPeopleKey = '';

  function openSheet(id) {
    renderFormPeople();
    editingId = id || null;
    const exp = id && state.expenses.find(e => e.id === id);
    $('sheetTitle').textContent = T(exp ? 'sheet.edit' : 'sheet.new');
    $('fSubmit').textContent = T(exp ? 'f.saveEdit' : 'f.saveNew');
    $('fError').textContent = '';
    formFiles = [];
    if (exp) {
      $('fTitle').value = exp.title;
      $('fNote').value = exp.note || '';
      formCat = exp.category || 'other';
      $('fAmount').value = (exp.amount / 100).toString();
      $('fDate').value = exp.date;
      $('fPayer').value = exp.payerId;
      const equal = H.splitEqual(exp.amount, exp.shares.map(s => s.personId));
      $('fCustom').checked = !equal.every((s, i) => s.amount === exp.shares[i].amount);
      document.querySelectorAll('#fShares input[type=checkbox]').forEach(i => {
        const share = exp.shares.find(s => s.personId === i.value);
        i.checked = !!share;
        document.querySelector(`[data-amt="${i.value}"]`).value = share ? (share.amount / 100).toString() : '';
      });
      formFiles = H.filesOf(state, exp.id).map(f => ({ record: f, name: f.name, type: f.type }));
    } else {
      $('fTitle').value = '';
      $('fAmount').value = '';
      $('fNote').value = '';
      formCat = 'groceries';
      const thisMonth = H.today().slice(0, 7);
      $('fDate').value = selDay || (curYm === thisMonth ? H.today() : curYm + '-01');
      $('fCustom').checked = false;
      document.querySelectorAll('#fShares input[type=checkbox]').forEach(i => (i.checked = true));
      document.querySelectorAll('#fShares .amt').forEach(i => (i.value = ''));
      $('fPayer').value = state.meId || (state.people[0] || {}).id || '';
    }
    renderCats();
    renderFormFiles();
    applyCustomMode();
    updatePreview();
    $('sheet').classList.add('open');
    $('sheet').setAttribute('aria-hidden', 'false');
    if (!exp) setTimeout(() => $('fAmount').focus(), 220);
  }

  function closeSheet() {
    $('sheet').classList.remove('open');
    $('sheet').setAttribute('aria-hidden', 'true');
    document.activeElement && document.activeElement.blur();
    for (const f of formFiles) if (f.url) URL.revokeObjectURL(f.url);
    formFiles = [];
    editingId = null;
  }

  $('fab').addEventListener('click', () => {
    if (state.people.length < 1) { toast(T('toast.addPeopleFirst')); showTab('people'); return; }
    openSheet(null);
  });
  $('fClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });

  function renderCats() {
    $('fCats').innerHTML = H.CATEGORIES.map(([id, name, emoji, color]) =>
      `<button type="button" class="cat-opt ${id === formCat ? 'on' : ''}" style="--cat:${color}" data-cat="${id}"><span class="e">${emoji}</span>${esc(L.cat(id))}</button>`).join('');
  }
  $('fCats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    formCat = b.dataset.cat;
    renderCats();
  });

  function renderFormPeople() {
    // Rebuild the people pickers only when the people list changes, so ticks are not lost.
    const key = state.people.map(p => p.id + p.name).join() + state.meId;
    if (key === formPeopleKey) return;
    formPeopleKey = key;
    $('fPayer').innerHTML = state.people.map(p => `<option value="${p.id}">${esc(p.name)}${isMe(p.id) ? ' ' + T('f.me') : ''}</option>`).join('');
    $('fShares').innerHTML = state.people.length
      ? state.people.map(p => `<label class="check"><input type="checkbox" value="${p.id}" checked>
          <span class="grow">${esc(p.name)}</span><input class="amt hidden" inputmode="decimal" placeholder="0.00" data-amt="${p.id}"></label>`).join('')
      : `<div class="empty">${T('f.addPeopleFirst')}</div>`;
  }

  function applyCustomMode() {
    const custom = $('fCustom').checked;
    document.querySelectorAll('#fShares .amt').forEach(i => i.classList.toggle('hidden', !custom));
  }

  const chosenIds = () => [...document.querySelectorAll('#fShares input[type=checkbox]:checked')].map(i => i.value);

  function updatePreview() {
    const amount = H.parseAmount($('fAmount').value);
    const ids = chosenIds();
    const p = $('fPreview');
    if (!ids.length) { p.textContent = T('prev.pick'); return; }
    if (isNaN(amount)) { p.textContent = T('prev.sharing', { n: ids.length }); return; }
    if ($('fCustom').checked) {
      const sum = ids.reduce((s, id) => s + (H.parseAmount(document.querySelector(`[data-amt="${id}"]`).value) || 0), 0);
      const left = amount - sum;
      p.textContent = left === 0 ? T('prev.ok') : (left > 0 ? T('prev.left', { amt: fmt(left) }) : T('prev.over', { amt: fmt(-left) }));
      return;
    }
    const split = H.splitEqual(amount, ids);
    const a = split[0].amount, b = split[split.length - 1].amount;
    p.textContent = T('prev.each', { amt: fmt(b) + (a !== b ? '–' + fmt(a) : ''), n: ids.length });
  }

  $('expenseForm').addEventListener('input', updatePreview);
  $('fCustom').addEventListener('change', () => { applyCustomMode(); updatePreview(); });
  $('fAll').addEventListener('click', () => { document.querySelectorAll('#fShares input[type=checkbox]').forEach(i => (i.checked = true)); updatePreview(); });
  $('fNone').addEventListener('click', () => { document.querySelectorAll('#fShares input[type=checkbox]').forEach(i => (i.checked = false)); updatePreview(); });

  function renderFormFiles() {
    $('fFiles').innerHTML = formFiles.map((f, i) => f.removed ? '' : `<div class="file-item">
      <button type="button" class="thumb ${f.type === 'application/pdf' ? 'pdf' : ''}" data-ffile="${i}" title="${esc(f.name)}"
        style="${f.url ? `background-image:url('${f.url}')` : ''}">${f.type.startsWith('image/') ? '' : esc(f.name.slice(0, 18))}</button>
      <button type="button" class="x" data-fdel="${i}" aria-label="${T('f.remove')}">✕</button></div>`).join('');
    // Existing attachments show their local image when there is one.
    formFiles.forEach(async (f, i) => {
      if (f.url || !f.record || !f.type.startsWith('image/')) return;
      const blob = await FS.get(f.record.id).catch(() => null);
      if (!blob) return;
      f.url = URL.createObjectURL(blob);
      const el = document.querySelector(`[data-ffile="${i}"]`);
      if (el) el.style.backgroundImage = `url('${f.url}')`;
    });
  }

  $('fAddFile').addEventListener('click', () => $('fFileInput').click());
  $('fFileInput').addEventListener('change', async e => {
    const picked = [...e.target.files];
    e.target.value = '';
    for (const raw of picked) {
      if (!/^image\//.test(raw.type) && raw.type !== 'application/pdf') { toast(T('f.onlyMedia', { name: raw.name })); continue; }
      const file = await FS.prepare(raw);
      if (file.size > MAX_FILE) { toast(T('f.tooBig', { name: raw.name, max: size(MAX_FILE) })); continue; }
      formFiles.push({ blob: file, name: file.name, type: file.type, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
    }
    renderFormFiles();
  });
  $('fFiles').addEventListener('click', e => {
    const d = e.target.closest('[data-fdel]');
    if (d) { formFiles[+d.dataset.fdel].removed = true; renderFormFiles(); }
  });

  $('expenseForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('fError');
    const title = $('fTitle').value.trim();
    const amount = H.parseAmount($('fAmount').value);
    const payerId = $('fPayer').value;
    const ids = chosenIds();
    err.textContent = '';
    if (isNaN(amount)) return (err.textContent = T('err.amount'));
    if (!title) return (err.textContent = T('err.title'));
    if (!payerId) return (err.textContent = T('err.payer'));
    if (!ids.length) return (err.textContent = T('err.shares'));
    if (!$('fDate').value) return (err.textContent = T('err.date'));

    let customShares = null;
    if ($('fCustom').checked) {
      customShares = ids.map(id => ({ personId: id, amount: H.parseAmount(document.querySelector(`[data-amt="${id}"]`).value) || 0 }));
      if (customShares.reduce((s, x) => s + x.amount, 0) !== amount) return (err.textContent = T('err.custom'));
    }

    const exp = H.makeExpense({
      title, amount, payerId, shareIds: ids, date: $('fDate').value, customShares,
      category: formCat, note: $('fNote').value, by: myName(),
    });
    const old = editingId && state.expenses.find(x => x.id === editingId);
    if (old) {
      exp.id = old.id;
      // Keep "paid back" ticks for people whose share and payer did not change.
      if (old.payerId === exp.payerId) {
        for (const s of exp.shares) {
          const before = old.shares.find(o => o.personId === s.personId);
          if (before && before.amount === s.amount && before.paid) { s.paid = true; s.paidOn = before.paidOn; s.updatedAt = before.updatedAt; }
        }
      }
    }

    const cat = H.categoryOf(exp.category);
    const keptFiles = formFiles.filter(f => !f.removed);
    const body =
      `<div class="sum-line"><span>${T('sum.type')}</span><b>${cat[2]} ${esc(L.cat(cat[0]))}</b></div>
       <div class="sum-line"><span>${T('sum.what')}</span><b>${esc(exp.title)}</b></div>
       <div class="sum-line"><span>${T('sum.amount')}</span><b>${money(exp.amount)}</b></div>
       <div class="sum-line"><span>${T('sum.date')}</span><b>${prettyDate(exp.date, true)}</b></div>
       <div class="sum-line"><span>${T('sum.paidBy')}</span><b>${label(exp.payerId)}</b></div>
       ${exp.note ? `<div class="sum-line"><span>${T('sum.details')}</span><span>${esc(exp.note)}</span></div>` : ''}
       ${keptFiles.length ? `<div class="sum-line"><span>${T('sum.files')}</span><span>${esc(keptFiles.map(f => f.name).join(', '))}</span></div>` : ''}
       <h2>${T('sum.shares')}</h2>
       ${exp.shares.map(s => `<div class="sum-line"><span>${label(s.personId)}${s.personId === exp.payerId ? ' ' + T('sum.paidIt') : ''}</span><b>${money(s.amount)}</b></div>`).join('')}`;
    if (!await ask(T(old ? 'dlg.saveEditQ' : 'dlg.saveNewQ'), body, T('dlg.confirmSave'))) return;

    // Attachments: store new bytes locally, drop the removed ones.
    try {
      for (const f of formFiles) {
        if (f.removed && f.record) {
          trashFiles([f.record]);
          H.removeRecord(state, 'files', f.record.id);
        } else if (!f.removed && f.blob) {
          const rec = H.addFile(state, { expenseId: exp.id, name: f.name, type: f.type, size: f.blob.size, by: myName() });
          await FS.put(rec.id, f.blob);
        }
      }
    } catch (e2) {
      toast(T('err.storeFile', { msg: e2.message }));
    }

    if (old) state.expenses[state.expenses.indexOf(old)] = exp;
    else state.expenses.push(exp);
    const what = T(old ? 'log.edited' : 'log.added', { title: exp.title, amt: fmt(exp.amount), payer: nameOf(exp.payerId) });
    curYm = exp.date.slice(0, 7);
    if (selDay && selDay !== exp.date) selDay = null;
    openExp.add(exp.id);
    closeSheet();
    toast(old ? T('toast.saved') : T('toast.added', { title: exp.title }));
    save(what);
  });

  // ---------- month exports ----------
  $('xExcel').addEventListener('click', () => {
    if (!H.monthReport(state, curYm).expenses.length) return toast(T('x.none', { month: X.monthName(curYm) }));
    deliver(`house-cost-${curYm}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', X.monthWorkbook(state, curYm), 'save');
  });

  $('xShare').addEventListener('click', () => {
    const rep = H.monthReport(state, curYm);
    if (!rep.expenses.length) return toast(T('x.none', { month: X.monthName(curYm) }));
    const files = rep.expenses.flatMap(e => H.filesOf(state, e.id));
    $('shTitle').textContent = T('share.title', { month: X.monthName(curYm) });
    $('shFiles').closest('label').classList.toggle('hidden', !files.length);
    $('shInfo').textContent = files.length ? T('share.nFiles', { n: files.length }) : '';
    const dlg = $('shareDlg');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'ok') return;
      const embedded = {};
      let missing = 0;
      if (files.length && $('shFiles').checked) {
        toast(T('share.preparing'));
        for (const f of files) {
          const blob = await fileBlob(f).catch(() => null);
          if (blob) embedded[f.id] = await FS.blobToDataUrl(blob);
          else missing++;
        }
      }
      const html = X.monthPage(state, curYm, embedded);
      await deliver(`house-cost-${curYm}.html`, 'text/html', new TextEncoder().encode(html), 'share');
      if (missing) toast(T('share.missing', { n: missing }));
    }, { once: true });
  });

  // ---------- balances ----------
  function renderBalances() {
    const hint = setupHint();
    $('balHint').innerHTML = hint;
    $('balHint').classList.toggle('hidden', !hint);
    const hasMe = state.people.some(p => p.id === state.meId);
    ['myTotals', 'iOweTitle', 'iOwe', 'oweMeTitle', 'oweMe'].forEach(id => $(id).classList.toggle('hidden', !hasMe));
    const rows = H.summary(state);
    if (hasMe) {
      const mine = rows.find(r => r.person.id === state.meId);
      $('myTotals').innerHTML =
        stat(T('stat.iOwe'), mine.owes, mine.owes ? 'neg' : '') +
        stat(T('stat.owedMe'), mine.owed, mine.owed ? 'pos' : '') +
        stat(T('stat.myShare'), mine.share, '');
      $('iOwe').innerHTML = debtPanels('owe');
      $('oweMe').innerHTML = debtPanels('owed');
    }

    $('everyone').innerHTML = state.people.length
      ? `<table><tr><th>${T('tbl.name')}</th><th>${T('tbl.paidShop')}</th><th>${T('tbl.ownShare')}</th><th>${T('tbl.owes')}</th><th>${T('tbl.owed')}</th></tr>` +
        rows.map(r => `<tr><td>${isMe(r.person.id) ? '<b>' + esc(r.person.name) + '</b>' : esc(r.person.name)}</td>
          <td>${money(r.spent)}</td><td>${money(r.share)}</td>
          <td class="${r.owes ? 'neg' : ''}">${money(r.owes)}</td>
          <td class="${r.owed ? 'pos' : ''}">${money(r.owed)}</td></tr>`).join('') +
        '</table>'
      : `<div class="empty">${T('ppl.none')}</div>`;

    const debts = H.pairDebts(state);
    $('allDebts').innerHTML = debts.length
      ? debts.map(d => `<div class="card person">
          <div class="grow"><b>${label(d.from)} → ${label(d.to)}</b>
            ${d.offset ? `<span class="muted">${T('debt.minus', { gross: money(d.gross), offset: money(d.offset) })}</span>` : ''}</div>
          <b class="neg">${money(d.amount)}</b>
          <button class="small" data-settle="${d.from}|${d.to}">${T('debt.settled')}</button></div>`).join('')
      : `<div class="empty"><span class="big">🎉</span>${T('debt.none')}</div>`;
  }

  const stat = (title, cents, cls) => `<div class="stat"><span>${title}</span><b class="${cls}">${money(cents)}</b></div>`;

  /** "owe": what I still have to pay each person. "owed": what each person still has to pay me. */
  function debtPanels(kind) {
    const me = state.meId;
    const panels = state.people.filter(p => p.id !== me).map(p => {
      const from = kind === 'owe' ? me : p.id;
      const to = kind === 'owe' ? p.id : me;
      const shares = H.openShares(state, from, to);
      if (!shares.length) return '';
      const total = shares.reduce((s, x) => s + x.amount, 0);
      const key = kind + ':' + p.id;
      const headText = T(kind === 'owe' ? 'debt.youOwe' : 'debt.owesYou', { name: esc(p.name) });
      const allText = T(kind === 'owe' ? 'debt.iPaidAll' : 'debt.paidMeAll', { name: esc(p.name) });
      return `<div class="card debt ${kind} ${openPanels.has(key) ? 'open' : ''}" data-panel="${key}">
        <div class="debt-head">${avatar(p)}<span class="who">${headText}<br><span class="muted">${T('n.item', { n: shares.length })} · ${T('debt.tapSee')}</span></span>
          <span class="amt ${kind === 'owe' ? 'neg' : 'pos'}">${money(total)}</span></div>
        <div class="debt-body">
          ${shares.map(s => `<label class="debt-line check">
            <input type="checkbox" data-pay="${s.expense.id}|${from}">
            <span class="grow">${H.categoryOf(s.expense.category)[2]} ${esc(s.expense.title)} <small>${prettyDate(s.expense.date, true)} · ${T('debt.total', { amt: money(s.expense.amount) })}</small></span>
            <b>${money(s.amount)}</b></label>`).join('')}
          <p class="muted">${T(kind === 'owe' ? 'debt.tickOwe' : 'debt.tickOwed')}</p>
          <div class="debt-foot"><button class="small primary" data-settle="${from}|${to}" data-oneway="1">${allText}</button></div>
        </div></div>`;
    }).join('');
    return panels || `<div class="empty">${T(kind === 'owe' ? 'debt.oweNobody' : 'debt.nobodyOwesYou')}</div>`;
  }

  $('tab-balances').addEventListener('click', async e => {
    const settle = e.target.closest('[data-settle]');
    if (settle) {
      const [from, to] = settle.dataset.settle.split('|');
      const oneWay = settle.dataset.oneway;
      const msg = oneWay
        ? T('settle.oneWay', { from: label(from), to: label(to) })
        : T('settle.both', { from: label(from), to: label(to) });
      if (!await ask(T('settle.title'), `<p>${msg}</p>`, T('settle.ok'))) return;
      let n = H.settlePair(state, from, to);
      if (!oneWay) n += H.settlePair(state, to, from);
      toast(T('toast.nMarked', { n }));
      save(T('log.settled', { from: nameOf(from), to: nameOf(to) }));
      return;
    }
    const head = e.target.closest('.debt-head');
    if (head) {
      const panel = head.parentElement;
      const key = panel.dataset.panel;
      if (openPanels.has(key)) openPanels.delete(key); else openPanels.add(key);
      panel.classList.toggle('open');
    }
  });
  $('tab-balances').addEventListener('change', e => {
    const box = e.target.closest('[data-pay]');
    if (!box) return;
    const [expId, personId] = box.dataset.pay.split('|');
    H.setSharePaid(state, expId, personId, true);
    const exp = state.expenses.find(x => x.id === expId);
    toast(T('toast.markedPaid', { title: exp.title }));
    save(T('log.paidBack', { who: nameOf(personId), payer: nameOf(exp.payerId), title: exp.title }));
  });

  // ---------- people + settings ----------
  function renderPeople() {
    $('peopleList').innerHTML = state.people.length ? state.people.map(p => `<div class="card person">
        ${avatar(p)}
        <div class="grow"><b>${esc(p.name)}</b>${isMe(p.id) ? `<span class="muted">${T('ppl.thisIsYou')}</span>` : ''}</div>
        ${isMe(p.id) ? '' : `<button class="small" data-me="${p.id}">${T('ppl.thisIsMe')}</button>`}
        <button class="small" data-rename="${p.id}">${T('ppl.rename')}</button>
        <button class="small" data-remove="${p.id}" aria-label="${T('ppl.remove')}">✕</button></div>`).join('')
      : `<div class="empty">${T('ppl.nobody')}</div>`;
    if (document.activeElement !== $('sCurrency')) $('sCurrency').value = state.currency;
  }

  $('personForm').addEventListener('submit', e => {
    e.preventDefault();
    const res = H.addPerson(state, $('pName').value);
    $('pError').textContent = res.error || '';
    if (res.error) return;
    if (!state.meId && state.people.length === 1) state.meId = res.person.id;
    $('pName').value = '';
    save(T('log.addedPerson', { name: res.person.name }));
  });

  $('peopleList').addEventListener('click', async e => {
    const me = e.target.closest('[data-me]');
    if (me) { state.meId = me.dataset.me; store(); render(); return; } // local only, not synced
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const p = state.people.find(x => x.id === rn.dataset.rename);
      const name = (prompt(T('ppl.newName'), p.name) || '').trim();
      if (!name || name === p.name) return;
      if (state.people.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) return toast(T('toast.exists', { name }));
      const before = p.name;
      H.renamePerson(state, p.id, name);
      save(T('log.renamed', { from: before, to: name }));
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const p = state.people.find(x => x.id === rm.dataset.remove);
      if (H.personUsed(state, p.id)) return toast(T('toast.personUsed', { name: p.name }));
      if (!await ask(T('ppl.removeQ', { name: p.name }), '', T('ppl.remove'))) return;
      H.removeRecord(state, 'people', p.id);
      if (state.meId === p.id) state.meId = null;
      save(T('log.removed', { name: p.name }));
    }
  });

  let currencyTimer;
  $('sCurrency').addEventListener('input', e => {
    H.setCurrency(state, e.target.value.trim());
    store();
    render();
    clearTimeout(currencyTimer);
    currencyTimer = setTimeout(() => save(T('log.currency', { c: state.currency })), 1200);
  });

  $('sCopy').addEventListener('click', async () => {
    const text = JSON.stringify(state);
    $('sBackup').value = text;
    try {
      await navigator.clipboard.writeText(text);
      $('sMsg').textContent = T('bk.copied');
    } catch (err) {
      $('sBackup').select();
      $('sMsg').textContent = T('bk.inBox');
    }
  });

  $('sRestore').addEventListener('click', async () => {
    try {
      const data = H.validateState(JSON.parse($('sBackup').value));
      if (!await ask(T('bk.restoreQ'), `<p>${T('bk.restoreBody', { people: T('n.person', { n: data.people.length }), expenses: T('n.expense', { n: data.expenses.length }) })}</p>`, T('set.restore'))) return;
      data.deviceId = state.deviceId;
      state = data;
      $('sBackup').value = '';
      $('sMsg').textContent = T('bk.restored');
      formPeopleKey = '';
      save(T('log.restored'));
    } catch (err) {
      $('sMsg').textContent = T('bk.err', { msg: err.message });
    }
  });

  $('sReset').addEventListener('click', async () => {
    if (!await ask(T('reset.q'), `<p>${T('reset.body')}</p>`, T('reset.ok'))) return;
    // Tombstone everything so the delete reaches the other devices too.
    trashFiles(state.files);
    const gone = { ...state.gone };
    for (const x of [...state.people, ...state.expenses, ...state.files]) gone[x.id] = H.now();
    state = { ...H.emptyState(), deviceId: state.deviceId, currency: state.currency, gone };
    formPeopleKey = '';
    save(T('log.deletedAll'));
    toast(T('toast.deletedAll'));
  });

  // File exchange without GitHub (MeshDrop, chat…).
  $('fileSend').addEventListener('click', () => {
    const text = JSON.stringify(H.exportShared(state), null, 1);
    deliver('house-cost-' + H.today() + '.json', 'application/json', new TextEncoder().encode(text), 'share');
    $('fileMsg').textContent = T('file.noMedia');
  });
  $('fileImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      H.validateState(JSON.parse(text));
      const changed = H.merge(state, JSON.parse(text));
      formPeopleKey = '';
      if (changed) save(T('log.merged', { name: file.name }));
      $('fileMsg').textContent = T(changed ? 'file.merged' : 'file.nothingNew', { name: file.name });
      cleanLocalFiles();
    } catch (err) {
      $('fileMsg').textContent = T('file.importErr', { msg: err.message });
    }
  });

  /** Drops local bytes of attachments that were deleted (here or on another phone). */
  async function cleanLocalFiles() {
    try {
      const live = new Set(state.files.map(f => f.id));
      for (const k of await FS.keys()) if (!live.has(k)) await FS.del(k);
    } catch (e) { /* storage not available */ }
  }

  // ---------- GitHub sync ----------
  function ghCfg() {
    try { return JSON.parse(localStorage.getItem(GH_KEY)) || null; } catch (e) { return null; }
  }

  function ghClient() {
    const c = ghCfg();
    if (!c || !c.token || !c.repo) return null;
    const [owner, repo] = c.repo.split('/');
    return G.client({ owner, repo, path: DATA_PATH, token: c.token });
  }

  function commitMessage() {
    const who = myName();
    const log = sync.log;
    const head = log.length ? log[log.length - 1] + (log.length > 1 ? ' ' + T('commit.more', { n: log.length - 1 }) : '') : T('commit.default');
    return (who ? who + ': ' : '') + head + (log.length > 1 ? '\n\n' + log.map(l => '- ' + l).join('\n') : '');
  }

  let syncing = null, autoTimer = null, syncError = '';
  function scheduleAutoSync() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => syncNow(false), 4000);
  }

  function syncNow(manual) {
    const gh = ghClient();
    if (!gh) {
      if (manual) { toast(T('sync.connectFirst')); showTab('people'); $('ghRepo').focus(); }
      return Promise.resolve();
    }
    if (!navigator.onLine) {
      if (manual) toast(T('sync.offline'));
      renderSyncUi();
      return Promise.resolve();
    }
    if (syncing) return syncing;
    syncing = runSync(gh, manual).finally(() => { syncing = null; renderSyncUi(); });
    renderSyncUi();
    return syncing;
  }

  async function runSync(gh, manual) {
    const s = state;
    const pendingBefore = sync.pending, logBefore = sync.log.length;
    try {
      // 1. Attachments first, so the data file never points at bytes that are not there.
      const up = new Set(sync.uploaded);
      for (const f of s.files) {
        if (up.has(f.id)) continue;
        const blob = await FS.get(f.id).catch(() => null);
        if (!blob) continue; // someone else's file, not downloaded here
        await gh.putFile(f.path, await FS.blobToBase64(blob), T('commit.attach', { name: f.name }));
        up.add(f.id);
        sync.uploaded = [...up];
        storeSync();
      }
      // 2. The data file: pull, merge, push.
      const res = await G.syncRound(gh, H, s, commitMessage());
      // 3. Attachments deleted on this phone go from the repo too.
      for (const t of [...sync.trash]) {
        await gh.deleteFile(t.path, T('commit.detach'));
        sync.trash = sync.trash.filter(x => x.id !== t.id);
        sync.uploaded = sync.uploaded.filter(id => id !== t.id);
        storeSync();
      }
      if (s !== state) return; // data was replaced (restore/reset) while syncing
      store();
      sync.pending = Math.max(0, sync.pending - pendingBefore);
      sync.log = sync.log.slice(logBefore);
      sync.lastAt = Date.now();
      syncError = '';
      storeSync();
      if (res.pulledChanges) { formPeopleKey = ''; cleanLocalFiles(); }
      render();
      if (manual || res.pulledChanges) toast(T(res.pulledChanges ? 'sync.gotNew' : (res.pushed ? 'sync.done' : 'sync.upToDate')));
    } catch (e) {
      syncError = e.message || String(e);
      if (manual) toast(T('sync.failed', { msg: syncError }));
    }
  }

  function renderSyncUi() {
    const cfg = ghCfg();
    const connected = !!(cfg && cfg.token);
    const btn = $('syncBtn');
    btn.classList.toggle('busy', !!syncing);
    btn.classList.toggle('offline', !navigator.onLine);
    const badge = $('syncBadge');
    badge.textContent = sync.pending > 99 ? '99+' : String(sync.pending);
    badge.classList.toggle('hidden', !connected || !sync.pending);
    btn.title = !connected ? T('sync.notConnected') : (sync.pending ? T('sync.nNotSynced', { n: sync.pending }) : T('sync.done'));

    if (document.activeElement !== $('ghRepo')) $('ghRepo').value = cfg ? cfg.repo : '';
    $('ghToken').placeholder = connected ? T('gh.tokenSaved') : 'github_pat_…';
    $('ghAuto').checked = !!(cfg && cfg.auto);
    $('ghSave').textContent = T(connected ? 'gh.save' : 'gh.connect');
    $('ghSyncNow').classList.toggle('hidden', !connected);
    $('ghForget').classList.toggle('hidden', !connected);
    const gh = ghClient();
    $('ghHistory').classList.toggle('hidden', !gh);
    if (gh) $('ghHistory').href = gh.historyUrl;

    const st = $('syncStatus');
    let text = '', cls = '';
    if (!connected) text = T('st.notConnected');
    else if (syncing) text = T('st.syncing');
    else if (syncError) { text = T('st.lastFailed', { msg: syncError }); cls = 'error'; }
    else {
      text = (sync.lastAt ? T('st.last', { ago: ago(sync.lastAt) }) : T('st.never')) +
        ' · ' + (sync.pending ? T('st.waiting', { n: sync.pending }) : T('st.allSynced')) +
        (navigator.onLine ? '' : ' · ' + T('st.offline'));
      cls = sync.pending ? '' : 'ok';
    }
    st.textContent = text;
    st.className = cls;
  }

  $('syncBtn').addEventListener('click', () => syncNow(true));
  $('ghSyncNow').addEventListener('click', () => syncNow(true));
  $('ghSave').addEventListener('click', () => {
    const repo = $('ghRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    const old = ghCfg() || {};
    const token = $('ghToken').value.trim() || old.token;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast(T('gh.badRepo'));
    if (!token) return toast(T('gh.needToken'));
    localStorage.setItem(GH_KEY, JSON.stringify({ repo, token, auto: $('ghAuto').checked }));
    $('ghToken').value = '';
    syncError = '';
    // A new repo means nothing is uploaded there yet.
    if (old.repo !== repo) { sync.uploaded = []; storeSync(); }
    syncNow(true);
    renderSyncUi();
  });
  $('ghAuto').addEventListener('change', () => {
    const cfg = ghCfg();
    if (!cfg) return;
    cfg.auto = $('ghAuto').checked;
    localStorage.setItem(GH_KEY, JSON.stringify(cfg));
    toast(T(cfg.auto ? 'gh.autoOn' : 'gh.autoOff'));
    if (cfg.auto) syncNow(false);
  });
  $('ghForget').addEventListener('click', async () => {
    if (!await ask(T('gh.disconnectQ'), `<p>${T('gh.disconnectBody')}</p>`, T('gh.disconnect'))) return;
    localStorage.removeItem(GH_KEY);
    syncError = '';
    renderSyncUi();
  });

  window.addEventListener('online', () => { renderSyncUi(); if ((ghCfg() || {}).auto) syncNow(false); });
  window.addEventListener('offline', renderSyncUi);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (ghCfg() || {}).auto) syncNow(false);
  });
  // Another tab of the web app changed the data.
  window.addEventListener('storage', e => {
    if (e.key === KEY) { state = load(); formPeopleKey = ''; render(); }
  });

  // ---------- language ----------
  /** Static text from data-i18n attributes; the rest comes from render(). */
  function applyLang() {
    L.apply(document);
    $('sLang').value = L.pref();
    $('calHead').innerHTML = ''; // weekday names are rebuilt in the new language
    formPeopleKey = '';
    $('sheetTitle').textContent = T(editingId ? 'sheet.edit' : 'sheet.new');
    $('fSubmit').textContent = T(editingId ? 'f.saveEdit' : 'f.saveNew');
    updatePreview();
  }
  $('sLang').addEventListener('change', e => {
    L.setPref(e.target.value);
    applyLang();
    render();
  });

  // ---------- start ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !host) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  applyLang();
  showTab(state.people.length < 2 ? 'people' : 'home');
  render();
  if ((ghCfg() || {}).auto) syncNow(false);
})();
