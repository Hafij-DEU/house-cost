// Month exports: an Excel workbook (.xlsx, written by hand: a zip of XML parts)
// and a standalone web page anyone can open in a browser. No DOM, no libraries.
(function (root) {
  'use strict';
  const H = root.HouseCost || (typeof require === 'function' ? require('./logic.js') : null);
  const L = root.I18n || (typeof require === 'function' ? require('./i18n.js') : null);
  const t = L.t;

  // ---------- zip (stored, no compression) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** entries: [{name, data: string|Uint8Array}] -> Uint8Array of a zip file. */
  function zip(entries, date) {
    const enc = new TextEncoder();
    const d = date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const chunks = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true); // UTF-8 names
      head.setUint16(10, time, true);
      head.setUint16(12, day, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, data.length, true);
      head.setUint32(22, data.length, true);
      head.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(head.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, day, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  // ---------- xlsx ----------
  const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  function colName(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Cell styles (index into cellXfs below): 0 text, 1 bold, 2 money, 3 bold money, 4 wrapped text.
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  /** A cell is a string, a number, null, or {v, s} with an explicit style. */
  function sheetXml(rows, widths) {
    const cols = widths && widths.length
      ? '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      : '';
    const body = rows.map((row, r) => `<row r="${r + 1}">` + row.map((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return '';
      const ref = colName(c) + (r + 1);
      const v = typeof cell === 'object' ? cell.v : cell;
      const s = typeof cell === 'object' ? cell.s : (typeof cell === 'number' ? 2 : 0);
      if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${cols}<sheetData>${body}</sheetData></worksheet>`;
  }

  /** sheets: [{name, rows, widths}] -> Uint8Array (.xlsx). */
  function xlsx(sheets) {
    const safe = sheets.map((s, i) => ({ ...s, name: (s.name.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet' + (i + 1)) }));
    const entries = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${safe.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${safe.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${safe.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
      { name: 'xl/styles.xml', data: STYLES },
      ...safe.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, s.widths) })),
    ];
    return zip(entries);
  }

  function monthName(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(L.locale, { month: 'long', year: 'numeric' });
  }

  const nameIn = state => id => (state.people.find(p => p.id === id) || { name: t('removed') }).name;

  /** Workbook for one month: every expense with each person's share, plus a summary. */
  function monthWorkbook(state, ym) {
    const rep = H.monthReport(state, ym);
    const name = nameIn(state);
    const money = c => c / 100;
    const cur = c => L.money(H.formatMoney(c, state.currency));
    const B = v => ({ v, s: 1 });
    const people = state.people;
    const head = [t('xl.date'), t('xl.type'), t('xl.what'), t('xl.details'), t('xl.paidBy'), t('xl.amount', { c: state.currency }),
      ...people.map(p => t('xl.share', { name: p.name })), t('xl.open'), t('xl.files'), t('xl.changed')].map(B);
    const rows = [head];
    for (const e of [...rep.expenses].reverse()) {
      const open = e.shares.filter(s => !s.paid && s.personId !== e.payerId);
      rows.push([
        e.date, L.cat(H.categoryOf(e.category)[0]), e.title, e.note ? { v: e.note, s: 4 } : '', name(e.payerId), money(e.amount),
        ...people.map(p => {
          const s = e.shares.find(x => x.personId === p.id);
          return s ? money(s.amount) : null;
        }),
        open.map(s => `${name(s.personId)} ${cur(s.amount)}`).join(', ') || t('xl.allPaid'),
        H.filesOf(state, e.id).map(f => f.name).join(', '),
        (stamp => (e.by ? t('xl.by', { time: stamp, name: e.by }) : stamp))(new Date(e.updatedAt).toISOString().slice(0, 16).replace('T', ' ')),
      ]);
    }
    const shareTotals = people.map(p => rep.expenses.reduce((s, e) => s + ((e.shares.find(x => x.personId === p.id) || {}).amount || 0), 0));
    rows.push([B(t('xl.total')), '', '', '', '', { v: money(rep.total), s: 3 }, ...shareTotals.map(c => ({ v: money(c), s: 3 }))]);

    const summary = [
      [B(monthName(ym)), '', '', '', ''],
      [B(t('xl.person')), B(t('tbl.paidShop')), B(t('tbl.ownShare')), B(t('xl.stillOwes')), B(t('xl.stillOwed'))],
      ...rep.people.map(r => [name(r.personId), money(r.spent), money(r.share), money(r.owes), money(r.owed)]),
      [],
      [B(t('xl.type')), B(t('sum.amount')), B(t('xl.shareOfMonth'))],
      ...rep.byCategory.map(c => [L.cat(c.id), money(c.amount), rep.total ? Math.round(c.amount * 1000 / rep.total) / 10 + '%' : '']),
      [B(t('xl.total')), { v: money(rep.total), s: 3 }],
    ];
    return xlsx([
      { name: t('xl.expensesSheet', { ym }), rows, widths: [11, 13, 26, 34, 14, 12, ...people.map(() => 12), 28, 22, 22] },
      { name: t('xl.summary'), rows: summary, widths: [22, 14, 14, 22, 22] },
    ]);
  }

  // ---------- web page ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * One self-contained HTML page for a month. attachments: {fileId: dataUrl}
   * for the photos/PDFs to embed (missing ones are listed by name only).
   */
  function monthPage(state, ym, attachments) {
    const rep = H.monthReport(state, ym);
    const name = nameIn(state);
    const m = c => esc(L.money(H.formatMoney(c, state.currency)));
    const att = attachments || {};
    const debts = new Map();
    for (const e of rep.expenses) {
      for (const s of e.shares) {
        if (s.paid || s.personId === e.payerId) continue;
        const k = s.personId + '|' + e.payerId;
        debts.set(k, (debts.get(k) || 0) + s.amount);
      }
    }
    const bar = rep.byCategory.map(c => `<span style="flex:${c.amount};background:${c.color}" title="${esc(L.cat(c.id))}"></span>`).join('');
    const legend = rep.byCategory.map(c => `<span class="lg"><i style="background:${c.color}"></i>${c.emoji} ${esc(L.cat(c.id))} <b>${m(c.amount)}</b></span>`).join('');
    const items = rep.expenses.map(e => {
      const cat = H.categoryOf(e.category);
      const chips = e.shares.map(s => s.personId === e.payerId
        ? `<span class="chip own">${esc(name(s.personId))} ${m(s.amount)} · ${t('chip.paidIt')}</span>`
        : `<span class="chip ${s.paid ? 'ok' : 'no'}">${s.paid ? '✓' : '○'} ${esc(name(s.personId))} ${m(s.amount)} ${s.paid ? t('chip.paidBack') : t('chip.owes')}</span>`).join('');
      const files = H.filesOf(state, e.id).map(f => {
        const url = att[f.id];
        if (url && f.type.startsWith('image/')) return `<a href="${url}" download="${esc(f.name)}"><img src="${url}" alt="${esc(f.name)}"></a>`;
        if (url) return `<a class="file" href="${url}" download="${esc(f.name)}">📄 ${esc(f.name)}</a>`;
        return `<span class="file">📎 ${esc(f.name)}</span>`;
      }).join('');
      return `<article style="border-left-color:${cat[3]}">
  <div class="row"><b>${cat[2]} ${esc(e.title)}</b><b>${m(e.amount)}</b></div>
  <div class="meta">${esc(e.date)} · ${esc(L.cat(cat[0]))} · ${t('pg.paidBy', { name: esc(name(e.payerId)) })}</div>
  ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
  <div class="chips">${chips}</div>
  ${files ? `<div class="files">${files}</div>` : ''}
</article>`;
    }).join('\n');
    const people = rep.people.filter(r => r.spent || r.share).map(r =>
      `<tr><td>${esc(name(r.personId))}</td><td>${m(r.spent)}</td><td>${m(r.share)}</td><td>${r.owes ? m(r.owes) : '–'}</td></tr>`).join('');
    const debtRows = [...debts].map(([k, v]) => {
      const [from, to] = k.split('|');
      return `<li>${esc(name(from))} → ${esc(name(to))}: <b>${m(v)}</b></li>`;
    }).join('');
    return `<!doctype html>
<html lang="${L.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>House Cost · ${esc(monthName(ym))}</title>
<style>
:root{--bg:#F5F6FB;--card:#fff;--text:#111827;--muted:#6B7280;--line:#E5E7EB;--ok:#DCFCE7;--no:#FEE2E2;--own:#E0E7FF}
@media (prefers-color-scheme:dark){:root{--bg:#0E1016;--card:#181B24;--text:#E5E7EB;--muted:#9CA3AF;--line:#2A2F3A;--ok:#14351F;--no:#3B1717;--own:#262B4D}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
header{background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;border-radius:20px;padding:20px;margin-bottom:14px}
header h1{margin:0;font-size:15px;font-weight:500;opacity:.9}header .total{font-size:34px;font-weight:800;margin:4px 0}
header small{opacity:.85}
.bar{display:flex;height:12px;border-radius:99px;overflow:hidden;margin:12px 0 8px;background:var(--line)}
.lg{display:inline-flex;align-items:center;gap:6px;margin:0 12px 6px 0;font-size:13px}.lg i{width:10px;height:10px;border-radius:50%}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:22px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:14px;overflow:hidden;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:500}
ul{background:var(--card);border-radius:14px;padding:10px 10px 10px 30px;margin:0}
article{background:var(--card);border-radius:14px;border-left:5px solid;padding:12px 14px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:10px}.meta{color:var(--muted);font-size:13px;margin:2px 0 8px}
.note{background:var(--bg);border-radius:8px;padding:6px 8px;margin:0 0 8px;white-space:pre-wrap;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{padding:4px 10px;border-radius:99px;font-size:13px}
.chip.ok{background:var(--ok)}.chip.no{background:var(--no)}.chip.own{background:var(--own)}
.files{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.files img{height:96px;border-radius:8px;display:block}
.file{display:inline-block;padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;color:inherit}
footer{color:var(--muted);font-size:12px;text-align:center;margin:24px 0}
</style></head><body><main>
<header><h1>House Cost · ${esc(monthName(ym))}</h1><div class="total">${m(rep.total)}</div>
<small>${t('n.expense', { n: rep.expenses.length })}</small></header>
${rep.byCategory.length ? `<div class="bar">${bar}</div><div>${legend}</div>` : ''}
<h2>${t('pg.people')}</h2>
<table><tr><th>${t('tbl.name')}</th><th>${t('tbl.paidShop')}</th><th>${t('tbl.ownShare')}</th><th>${t('tbl.stillOwes')}</th></tr>${people || `<tr><td colspan="4">${t('pg.nothing')}</td></tr>`}</table>
<h2>${t('pg.openTitle')}</h2>
${debtRows ? `<ul>${debtRows}</ul>` : `<p>${t('pg.allPaid')}</p>`}
<h2>${t('pg.expenses')}</h2>
${items || `<p>${t('pg.noExp')}</p>`}
<footer>${esc(t('pg.made', { time: new Date().toLocaleString(L.locale) }))}</footer>
</main></body></html>
`;
  }

  const api = { crc32, zip, xlsx, monthWorkbook, monthPage, monthName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HouseExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
