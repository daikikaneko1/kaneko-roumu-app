// 出来高管理（スマホで入力・PCで集計）。合言葉は労務とは別：入力用（番頭さん）・閲覧用（幹部）。
import * as C from './dk-core.js';
import { decryptSecret } from './crypto.js';
import { importPriv, generateRoleKey } from './dk-crypto.js';
import { GitHubBackend, MemoryBackend, DekidakaStore } from './dk-store.js';
import { Sync } from './store.js';
import CONFIG from './config.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = { pass: 'dk.pass', role: 'dk.role', who: 'dk.who', sent: 'dk.sent', rm: 'dk.reportMonth', aggAll: 'dk.aggAll' };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const S = { role: null, scope: 0, store: null, sync: null, doc: null, demo: false, pendingInfo: { n: 0, unreadable: 0 } };
const ui = { kid: null, ym: null, blk: null, last: null, edit: null };
const DK = CONFIG.dekidaka || null;

// ---------- 表示用 ----------
const yen = v => (v == null ? '' : Math.round(v).toLocaleString('ja-JP'));
const yenOr = (v, empty = '<span class="warn">未設定</span>') => (v == null ? empty : yen(v));
const num = (v, d = 2) => (v == null ? '' : Number(v.toFixed(d)).toLocaleString('ja-JP', { maximumFractionDigits: d }));
const pct = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const dt = s => (s ? new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const can = ds => C.canRead(S.doc, ds);
const isView = () => S.role === 'view';
const K = id => S.doc.keisho.find(k => k.id === id);
const activeK = () => S.doc.keisho.filter(k => k.active !== false).sort((a, b) => a.no - b.no);
const kname = k => k.short || k.name;

// ---------- 起動・合言葉 ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1') return startDemo(params.get('role') === 'input' ? 'input' : 'view', Number(params.get('scope') ?? 2));
  if (!DK || !DK.bundle) return fatal('出来高はまだ準備中です。管理者に連絡してください。');
  const pass = localStorage.getItem(KEY.pass);
  if (!pass) return loginScreen();
  const u = await unlock(pass, localStorage.getItem(KEY.role));
  if (!u) { localStorage.removeItem(KEY.pass); return loginScreen('合言葉が違うか、変更されました。もう一度入れてください。'); }
  start(u);
}
async function unlock(pass, hint) {
  const order = hint === 'input' ? ['input', 'view'] : ['view', 'input'];
  for (const role of order) { const s = await decryptSecret(DK.bundle[role], pass); if (s) { const o = JSON.parse(s); return { role, token: o.token, priv: await importPriv(o.priv) }; } }
  return null;
}
function fatal(msg) { $('#nav').hidden = true; $('#main').innerHTML = `<div class="card login"><h2>出来高管理</h2><p>${esc(msg)}</p></div>`; }
function loginScreen(err = '') {
  $('#nav').hidden = true;
  $('#main').innerHTML = `<div class="card login"><h2>出来高の合言葉</h2>
    <p class="muted">労務稼働予定とは<b>別の合言葉</b>です（入力用・閲覧用）。</p>
    ${err ? `<p class="warn">${esc(err)}</p>` : ''}
    <input id="pass" type="password" autocomplete="current-password" placeholder="合言葉">
    <label class="chk"><input type="checkbox" id="remember" checked> このスマホで覚える</label>
    <button class="primary wide" id="go">開く</button><p id="msg" class="muted"></p></div>`;
  const go = async () => {
    const p = $('#pass').value.trim(); if (!p) return;
    $('#msg').textContent = '確認中…（数秒かかります）';
    const u = await unlock(p); if (!u) { $('#msg').textContent = '合言葉が違います'; return; }
    if ($('#remember').checked) { localStorage.setItem(KEY.pass, p); localStorage.setItem(KEY.role, u.role); }
    start(u);
  };
  $('#go').onclick = go; $('#pass').onkeydown = e => { if (e.key === 'Enter') go(); };
}
async function start(u) {
  const backend = new GitHubBackend({ owner: CONFIG.owner, repo: CONFIG.repo, branch: CONFIG.branch, token: u.token });
  await open(new DekidakaStore({ backend, dir: DK.dir, role: u.role, priv: u.priv, pubs: DK.pub, scope: DK.inputScope }), u.role, DK.inputScope);
}
async function open(store, role, scope, demo = false) {
  Object.assign(S, { role, scope: Number(scope), store, demo });
  $('#main').innerHTML = '<p class="center">読み込み中…</p>';
  try { await loadAll(); } catch (e) {
    if (e.auth) return fatal('データの鍵が使えません（期限切れか無効）。管理者に連絡してください。');
    if (e.nokey) return fatal('この合言葉では出来高データを開けません。管理者に連絡してください。');
    return fatal('読み込みできませんでした。電波の良い所でもう一度開いてください。（' + e.message + '）');
  }
  buildNav();
  window.onhashchange = render;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  if (!demo) setInterval(refresh, 90000);
  window.addEventListener('beforeunload', e => { if (S.sync && S.sync.pending.length) { e.preventDefault(); e.returnValue = ''; } });
  document.title = `出来高管理（${C.ROLES[role]}）`;
  if (!location.hash || location.hash === '#') location.hash = '#input'; else render();
}
// 閲覧用：全体データ＋未取り込みの入力（取り込んで保存し直す）。入力用：読める範囲だけ・未取り込みは重ねて表示（保存しない）
async function loadAll() {
  if (isView()) {
    if (!S.sync) S.sync = new Sync(S.store, C.applyOps, { onChange: showStatus });
    if (S.sync.pending.length) await S.sync.save(who());
    await S.sync.load();
    const pe = await S.store.pendingEntries(S.sync.base.merged);
    S.pendingInfo = { n: pe.entries.length, unreadable: pe.unreadable };
    if (pe.entries.length) { S.sync.push({ type: 'merge', entries: pe.entries }); scheduleSave(); }
    S.doc = S.sync.doc;
  } else {
    const { doc } = await S.store.load();
    const pe = await S.store.pendingEntries(doc.merged);
    S.pendingInfo = { n: pe.entries.length, unreadable: pe.unreadable };
    S.doc = C.overlayEntries(doc, pe.entries); S.doc.readable = doc.readable;
  }
  showStatus();
}
async function refresh() { if (!S.store || (S.sync && (S.sync.pending.length || S.sync.saving))) return; if (document.querySelector('#main input:focus, #main textarea:focus')) return; try { await loadAll(); ui.keepScroll = true; render(); } catch { } }
let saveTimer = null;
function scheduleSave() {
  if (S.demo) { S.sync.base = S.sync.doc; S.sync.pending = []; S.doc = S.sync.doc; showStatus(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { try { await S.sync.save(who()); S.doc = S.sync.doc; ui.keepScroll = true; render(); } catch (e) { if (e.auth) alert('保存できません：データの鍵が無効です。管理者に連絡してください。'); } }, 800);
}
function op(o) { S.sync.push({ ...o, by: who() }); S.doc = S.sync.doc; scheduleSave(); render(); }
const who = () => localStorage.getItem(KEY.who) || '';
function showStatus() {
  const el = $('#status'); el.className = '';
  const r = `<span class="role ${S.role}">${C.ROLES[S.role] || ''}</span>`;
  if (S.demo) { el.innerHTML = r + ' 体験（架空の数字）'; return; }
  const sy = S.sync;
  if (sy && sy.status === 'error') { el.className = 'err'; el.innerHTML = r + ' ⚠ 保存できていません'; }
  else if (sy && (sy.status === 'saving' || sy.pending.length)) { el.className = 'pend'; el.innerHTML = r + ' 保存中…'; }
  else el.innerHTML = r + (sy ? ' 保存済み ✓' : '');
}

// ---------- 画面 ----------
function navItems() {
  const items = [['input', '✏️', '入力']];
  if (can('master') || can('claims')) items.push(['list', '📄', '請書']);
  if (can('labor') && can('targets')) items.push(['agg', '📊', '集計'], ['sum', '📋', 'サマリー']);
  items.push(['settings', '⚙️', isView() ? '設定' : 'その他']);
  return items;
}
function buildNav() { const n = $('#nav'); n.innerHTML = navItems().map(([h, i, t]) => `<a href="#${h}" data-nav="${h}"><span>${i}</span>${t}</a>`).join(''); n.hidden = false; }
function render() {
  if (!S.doc) return;
  const [r, a, b] = location.hash.slice(1).split('/').map(decodeURIComponent);
  const allowed = navItems().map(x => x[0]).concat(['sheet', 'editk', 'editg', 'done']);
  const route = allowed.includes(r) ? r : 'input';
  document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('on', x.dataset.nav === ({ sheet: 'list', editk: 'settings', editg: 'settings', done: 'input' }[route] || route)));
  const f = { input: () => vInput(a, b), done: vDone, list: vList, sheet: () => vSheet(a), agg: vAgg, sum: vSum, settings: vSettings, editk: () => vEditK(a), editg: () => vEditG(a) }[route];
  const y = window.scrollY; $('#main').innerHTML = f(); bind();
  window.scrollTo(0, ui.keepScroll ? y : 0); ui.keepScroll = false; showStatus();
}
const H = {};
function bind() {
  $('#main').querySelectorAll('[data-a]').forEach(el => { const ev = el.tagName === 'SELECT' ? 'onchange' : 'onclick'; el[ev] = e => { e.stopPropagation(); const [n, ...args] = el.dataset.a.split('|'); H[n] && H[n](...args, el); }; });
}
H.go = h => { location.hash = '#' + h; };

// ---- 入力（請書 → 締め月 → 請求額・人工・備考 → 保存）----
function defaultYm(k) { const ms = C.keishoMonths(k); const cur = C.closeMonthOf(today, S.doc.settings.cycleDay || 21); return ms.includes(cur) ? cur : cur < ms[0] ? ms[0] : ms[ms.length - 1]; }
function vInput(kid, ym) {
  const ks = activeK();
  if (!kid || !K(kid)) {
    return `<h2>① 請書をえらぶ</h2><div class="steps"><b>①請書</b> → ②締め月 → ③数字 → 保存</div>
     ${ks.map(k => `<button class="wide pick" data-a="go|input/${esc(k.id)}"><span class="no">${esc(k.no)}</span><span class="t"><b>${esc(kname(k))}</b><small>${esc(k.name)}${k.taisho === false ? '・出来高対象外' : ''}</small></span><span class="arrow">›</span></button>`).join('')}
     ${sentList(3)}`;
  }
  const k = K(kid), ms = C.keishoMonths(k), day = S.doc.settings.cycleDay || 21;
  ym = ms.includes(ym) ? ym : defaultYm(k);
  const i = ms.indexOf(ym);
  const cur = { amount: C.val(S.doc, k.id, ym, 'amount'), ninku: C.val(S.doc, k.id, ym, 'ninku'), note: C.val(S.doc, k.id, ym, 'note') };
  const showCur = f => (f === 'amount' ? can('claims') : can('labor'));
  const hint = f => { if (!showCur(f)) return ''; const v = cur[f]; return `<div class="cur">今の値：${v == null ? 'なし' : f === 'amount' ? yen(v) + ' 円' : f === 'ninku' ? num(v, 3) + ' 人工' : esc(v)}</div>`; };
  const pre = f => (isView() && cur[f] != null ? (f === 'amount' ? String(cur[f]) : String(cur[f])) : '');
  const clr = f => (isView() ? `<label class="chk small"><input type="checkbox" id="clr-${f}"> 空にする</label>` : '');
  return `<div class="steps"><a href="#input">①請書</a> → <b>②締め月・③数字</b> → 保存</div>
   <div class="card"><div class="muted small">請書</div><div class="big-name">${esc(kname(k))}</div><div class="muted small">${esc(k.name)}</div><button class="link" data-a="go|input">請書を変える</button></div>
   <div class="card"><label class="f">② 締め月</label>
    <select id="ym" data-a="ympick|${esc(k.id)}">${ms.map(m => `<option value="${m}" ${m === ym ? 'selected' : ''}>${C.closeLabel(m, day)}</option>`).join('')}</select>
    <div class="monthpick"><button data-a="go|input/${esc(k.id)}/${ms[i - 1] || ym}" ${i <= 0 ? 'disabled' : ''}>◀ 前の月</button><button data-a="go|input/${esc(k.id)}/${ms[i + 1] || ym}" ${i >= ms.length - 1 ? 'disabled' : ''}>次の月 ▶</button></div></div>
   <div class="card"><label class="f" for="amount">③ 当月請求額（税抜・円）</label>
    <input id="amount" type="text" inputmode="numeric" autocomplete="off" placeholder="例 1,250,000" value="${esc(pre('amount'))}">${hint('amount')}${clr('amount')}
    ${k.hasNinku !== false ? `<label class="f" for="ninku">当月投入人工</label><input id="ninku" type="text" inputmode="decimal" autocomplete="off" placeholder="例 52.5" value="${esc(pre('ninku'))}">${hint('ninku')}${clr('ninku')}` : '<p class="muted small">この請書は人工を入れません（Excel と同じ）。</p>'}
    <label class="f" for="note">備考</label><input id="note" type="text" autocomplete="off" value="${esc(pre('note'))}">${hint('note')}${clr('note')}
    <label class="f" for="who">入力した人</label><input id="who" type="text" autocomplete="name" value="${esc(who())}">
    <p class="muted small">${isView() ? '変えた項目だけ保存します。' : '空欄の項目は変わりません（前の値のまま）。'}</p>
    <button class="primary wide big" data-a="submit|${esc(k.id)}|${ym}">保存する</button></div>`;
}
H.ympick = (kid, el) => { location.hash = `#input/${kid}/${el.value}`; };
function parseAmount(s) { s = s.replace(/[,，円\s]/g, '').replace(/[０-９－]/g, c => c === '－' ? '-' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); if (s === '') return undefined; if (!/^-?\d+$/.test(s)) return NaN; return Number(s); }
function parseNinku(s) { s = s.replace(/[,\s人工]/g, '').replace(/[０-９．]/g, c => c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); if (s === '') return undefined; if (!/^\d+(\.\d+)?$/.test(s)) return NaN; return Number(s); }
H.submit = (kid, ym) => {
  const k = K(kid), fields = {};
  const a = parseAmount($('#amount').value), n = $('#ninku') ? parseNinku($('#ninku').value) : undefined, note = $('#note').value.trim();
  if (Number.isNaN(a)) return alert('請求額は数字で入れてください（マイナスは先頭に -）');
  if (Number.isNaN(n)) return alert('人工は数字で入れてください（例 52.5）');
  const w = $('#who').value.trim(); if (w !== who()) localStorage.setItem(KEY.who, w);
  if (isView()) {
    const cur = f => C.val(S.doc, kid, ym, f);
    if ($('#clr-amount')?.checked) fields.amount = null; else if (a !== undefined && a !== cur('amount')) fields.amount = a;
    if ($('#clr-ninku')?.checked) fields.ninku = null; else if (n !== undefined && n !== cur('ninku')) fields.ninku = n;
    if ($('#clr-note')?.checked) fields.note = null; else if (note !== '' && note !== (cur('note') ?? '')) fields.note = note;
  } else { if (a !== undefined) fields.amount = a; if (n !== undefined) fields.ninku = n; if (note !== '') fields.note = note; }
  if (!Object.keys(fields).length) return alert(isView() ? '変わった項目がありません' : '数字を1つ以上入れてください');
  confirmSheet(k, ym, fields);
};
function fieldsHtml(k, ym, fields) {
  const row = (l, v) => `<tr><th>${l}</th><td>${v}</td></tr>`;
  return `<table class="kv">${row('請書', esc(kname(k)))}${row('締め月', C.closeLabel(ym, S.doc.settings.cycleDay || 21))}
   ${'amount' in fields ? row('当月請求額', fields.amount == null ? '空にする' : yen(fields.amount) + ' 円') : ''}
   ${'ninku' in fields ? row('当月投入人工', fields.ninku == null ? '空にする' : num(fields.ninku, 3) + ' 人工') : ''}
   ${'note' in fields ? row('備考', fields.note == null ? '空にする' : esc(fields.note)) : ''}</table>`;
}
function confirmSheet(k, ym, fields) {
  const el = $('#sheet'); el.hidden = false;
  el.innerHTML = `<div class="box"><div class="center"><b>この内容で保存しますか？</b></div>${fieldsHtml(k, ym, fields)}<div class="flex"><button id="cc">戻る</button><button class="primary" id="co">保存する</button></div><p id="cm" class="muted center"></p></div>`;
  const close = () => { el.hidden = true; el.innerHTML = ''; };
  $('#cc').onclick = close;
  $('#co').onclick = async () => {
    $('#co').disabled = true; $('#cm').textContent = '保存中…';
    try {
      const at = new Date().toISOString(), key = C.keyOf(k.id, ym);
      if (isView()) { S.sync.push({ type: 'set', key, fields, by: who() }); S.doc = S.sync.doc; if (!S.demo) await S.sync.save(who()); else scheduleSave(); S.doc = S.sync.doc; }
      else { const e = await S.store.addEntry({ key, fields, by: who(), at }); S.doc = C.overlayEntries(S.doc, [e]); S.doc.readable = C.readableDatasets('input', S.scope); }
      const rec = { kid: k.id, kname: kname(k), ym, fields, at, by: who(), role: S.role };
      ui.last = rec; remember(rec); close(); location.hash = '#done';
    } catch (e) { $('#co').disabled = false; $('#cm').textContent = '保存できませんでした。電波を確認してもう一度押してください。（' + e.message + '）'; }
  };
}
// 送った内容はこのスマホにだけ残す（入力用は他の人の入力・結果は読めない）
function remember(rec) { try { const a = JSON.parse(localStorage.getItem(KEY.sent) || '[]'); a.unshift(rec); localStorage.setItem(KEY.sent, JSON.stringify(a.slice(0, 30))); } catch { } }
const sentAll = () => { try { return JSON.parse(localStorage.getItem(KEY.sent) || '[]'); } catch { return []; } };
function sentList(max = 30) {
  const a = sentAll().slice(0, max); if (!a.length) return '';
  return `<h3>このスマホから送った内容</h3>${a.map(r => `<div class="card sent"><div class="muted small">${dt(r.at)} ${esc(r.by || '')}</div>${fieldsHtml({ short: r.kname }, r.ym, r.fields)}</div>`).join('')}
   ${max < 30 && sentAll().length > max ? '<a href="#settings">もっと見る</a>' : ''}`;
}
function vDone() {
  const r = ui.last; if (!r) return vInput();
  return `<div class="card ok"><h2>✓ 保存しました</h2><p class="muted small">${dt(r.at)}${r.by ? ' ・ ' + esc(r.by) : ''}</p>${fieldsHtml({ short: r.kname }, r.ym, r.fields)}
   ${!isView() ? '<p class="muted small">この内容は、このスマホにだけ控えとして残ります。</p>' : ''}</div>
   <button class="primary wide" data-a="go|input/${esc(r.kid)}/${C.nextMonth(r.ym)}">同じ請書の次の月を入れる</button>
   <button class="wide" data-a="go|input">別の請書を入れる</button>`;
}

// ---- 請書一覧・月次シート ----
function vList() {
  const R = reportMonth();
  const rows = activeK().map(k => { const c = C.cumThrough(S.doc, k, R); const rate = k.amount ? c.amount / k.amount : null;
    return `<tr data-a="go|sheet/${esc(k.id)}" class="click"><td class="nm"><b>${esc(kname(k))}</b><br><small>${esc(k.name)}${k.taisho === false ? '・対象外' : ''}</small></td>${can('master') ? `<td>${yenOr(k.amount)}</td>` : ''}${can('claims') ? `<td>${yen(c.amount)}</td>` : ''}${can('master') && can('claims') ? `<td>${k.amount ? pct(rate) : '—'}</td>` : ''}${can('labor') ? `<td>${num(c.ninku, 1)}</td>` : ''}</tr>`; }).join('');
  return `<h2>請書</h2><p class="muted small">累計は ${C.ymSlash(R || '')} 分まで（報告月はサマリーで変えられます）。行を押すと月ごとの表。</p>
   <div class="grid-wrap"><table class="grid dk"><thead><tr><th class="nm">請書</th>${can('master') ? '<th>請書金額</th>' : ''}${can('claims') ? '<th>累計請求</th>' : ''}${can('master') && can('claims') ? '<th>消化率</th>' : ''}${can('labor') ? '<th>累計人工</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function vSheet(id) {
  const k = K(id); if (!k) return vList();
  const ser = C.keishoSeries(S.doc, k), L = can('labor');
  const last = Math.max(...ser.map((r, i) => (r.amount != null || r.ninku != null || r.note ? i : -1)), -1);
  const show = localStorage.getItem(KEY.aggAll) === '1' ? ser : ser.slice(0, Math.max(last + 2, 1));
  const src = (f, ym) => { const r = S.doc.records[C.keyOf(k.id, ym)]; return r && r[f] && r[f].src === 'entry' ? ' e' : ''; };
  return `<h2>${esc(kname(k))}</h2><p class="muted small">${esc(k.name)}／請書金額 ${yenOr(k.amount)}${k.start ? '／契約 ' + esc(k.start) + '〜' + esc(k.end || '') : ''}</p>
   ${allToggle()}
   <div class="grid-wrap"><table class="grid dk"><thead><tr><th class="nm">締め月</th><th>当月請求額</th>${L ? '<th>当月人工</th>' : ''}<th>累計請求額</th>${L ? '<th>累計人工</th><th class="l">備考</th>' : ''}</tr></thead><tbody>
   ${show.map(r => `<tr ${isView() ? `data-a="go|input/${esc(k.id)}/${r.ym}" class="click"` : ''}><td class="nm">${C.ymSlash(r.ym)}</td><td class="${r.amount < 0 ? 'neg' : ''}${src('amount', r.ym)}">${yen(r.amount)}</td>${L ? `<td class="${src('ninku', r.ym)}">${num(r.ninku, 3)}</td>` : ''}<td>${yen(r.cumAmount)}</td>${L ? `<td>${num(r.cumNinku, 2)}</td><td class="l">${esc(r.note || '')}</td>` : ''}</tr>`).join('')}
   <tr class="tot"><td class="nm">合計</td><td>${yen(ser.reduce((s, r) => s + (r.amount || 0), 0))}</td>${L ? `<td>${num(ser.reduce((s, r) => s + (r.ninku || 0), 0), 3)}</td>` : ''}<td></td>${L ? '<td></td><td></td>' : ''}</tr></tbody></table></div>
   ${isView() ? '<p class="muted small">行を押すとその月を直せます。水色＝入力用から届いた値。</p>' : ''}`;
}
const allToggle = () => { const on = localStorage.getItem(KEY.aggAll) === '1'; return `<button class="toggle ${on ? 'on' : ''}" data-a="aggall">${on ? '☑' : '☐'} 先の空の月も表示</button>`; };
H.aggall = () => { localStorage.setItem(KEY.aggAll, localStorage.getItem(KEY.aggAll) === '1' ? '0' : '1'); ui.keepScroll = true; render(); };

// ---- 出来高集計（Excel「出来高集計」）----
function vAgg() {
  const bl = C.blocks(S.doc); if (!bl.length) return '<p>出来高対象の請書がありません。</p>';
  const b = bl.find(x => x.id === ui.blk) || bl[0]; ui.blk = b.id;
  const p = S.doc.settings.period || {}; const months = C.monthsBetween(p.from || b.members[0].from, p.to || b.members[0].to);
  const s = C.groupSeries(S.doc, b.members, b.target, months);
  const last = Math.max(...s.rows.map((r, i) => (r.per.some(x => x.amount || x.ninku) ? i : -1)), -1);
  const rows = localStorage.getItem(KEY.aggAll) === '1' ? s.rows : s.rows.slice(0, Math.max(last + 2, 1));
  const multi = b.members.length > 1, T = b.target;
  const head = `<tr><th class="nm">締め月</th>${multi ? b.members.map(k => `<th>${esc(kname(k))}<br>請求</th><th>${esc(kname(k))}<br>人工</th>`).join('') : ''}<th>${multi ? '合算' : ''}請求</th><th>${multi ? '合算' : ''}人工</th><th>月次出来高<br>(円/人工)</th>${T ? '<th>目標差異</th><th>達成率</th>' : ''}<th>累計請求</th><th>累計人工</th><th>累計出来高</th></tr>`;
  const cls = v => (T && v != null ? (v >= T ? 'good' : v >= T * 0.9 ? 'mid' : 'bad') : '');
  const tr = r => `<tr><td class="nm">${C.ymSlash(r.ym)}</td>${multi ? r.per.map(x => `<td class="${x.amount < 0 ? 'neg' : ''}">${yen(x.amount)}</td><td>${num(x.ninku, 2)}</td>`).join('') : ''}<td class="${r.G < 0 ? 'neg' : ''}">${yen(r.G)}</td><td>${num(r.H, 2)}</td><td class="${cls(r.I)}">${yen(r.I)}</td>${T ? `<td class="${r.J < 0 ? 'neg' : ''}">${yen(r.J)}</td><td>${r.K == null ? '' : pct(r.K)}</td>` : ''}<td>${yen(r.L)}</td><td>${num(r.M, 2)}</td><td class="${cls(r.N)}">${yen(r.N)}</td></tr>`;
  const tot = `<tr class="tot"><td class="nm">合計</td>${multi ? s.tot.per.map(x => `<td>${yen(x.amount)}</td><td>${num(x.ninku, 2)}</td>`).join('') : ''}<td>${yen(s.tot.G)}</td><td>${num(s.tot.H, 2)}</td><td class="${cls(s.tot.I)}">${yen(s.tot.I)}</td>${T ? '<td></td><td></td>' : ''}<td></td><td></td><td></td></tr>`;
  return `<h2>出来高集計</h2><div class="tabs wrap">${bl.map(x => `<button data-a="blk|${x.id}" class="${x.id === b.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
   <p class="muted small">${multi ? esc(b.members.map(kname).join('＋')) + ' の合算' : '単独で出来高管理'}${T ? `／目標 ${yen(T)} 円/人工` : '／目標なし'}。出来高＝請求÷人工（人工0の月は空欄）。</p>
   ${allToggle()}<div class="grid-wrap"><table class="grid dk"><thead>${head}</thead><tbody>${rows.map(tr).join('')}${tot}</tbody></table></div>
   <button class="wide" data-a="csv|month">⬇ 月次CSV</button>`;
}
H.blk = id => { ui.blk = id; ui.keepScroll = true; render(); };

// ---- 会議サマリー ----
function dataMonths() { const s = new Set(); for (const [key, r] of Object.entries(S.doc.records)) if ((r.amount && r.amount.v != null) || (r.ninku && r.ninku.v != null)) s.add(key.split('|')[1]); return [...s].sort(); }
function reportMonth() { const ms = dataMonths(), saved = localStorage.getItem(KEY.rm); return saved && ms.includes(saved) ? saved : C.latestDataMonth(S.doc); }
function vSum() {
  const R = reportMonth(), sm = C.summary(S.doc, R), ms = dataMonths();
  const sec = b => {
    const multi = b.members.length > 1, cols = multi ? [...b.items, null] : b.items;
    const cell = (i, f) => (i ? f(i) : '');
    const row = (l, fi, fsum) => `<tr><th>${l}</th>${cols.map(i => `<td>${i ? fi(i) : fsum()}</td>`).join('')}</tr>`;
    return `<div class="card sumsec"><h3>${esc(b.name)}${multi ? '（合算）' : '（単独）'}${b.target ? `<span class="muted small">　目標 ${yen(b.target)} 円/人工</span>` : ''}</h3>
     <table class="kv sum"><tr><th>項目</th>${cols.map(i => `<th>${i ? esc(kname(i.k)) : '合算'}</th>`).join('')}</tr>
     ${row('請書金額', i => yenOr(i.amount), () => yenOr(b.sumAmount))}
     ${row('累計請求', i => yen(i.cum), () => yen(b.sumCum))}
     ${row('消化率', i => (i.amount ? pct(i.rate) : '<span class="warn">未設定</span>'), () => (b.sumAmount ? pct(b.rate) : '<span class="warn">未設定</span>'))}
     ${row('累計人工', i => num(i.cumNinku, 1), () => num(b.cumNinku, 1))}
     </table>
     <div class="kpis"><div><small>${multi ? '合算' : ''}出来高</small><b>${b.dekidaka == null ? '—' : yen(b.dekidaka)}</b><small>円/人工</small></div>
      ${b.target ? `<div><small>目標との差</small><b class="${b.diff < 0 ? 'neg' : ''}">${b.diff == null ? '—' : (b.diff > 0 ? '+' : '') + yen(b.diff)}</b><small>達成率 ${b.dekidaka == null ? '—' : pct(b.dekidaka / b.target)}</small></div><div><small>評価</small><b class="mark">${b.eval || '—'}</b><small>◎目標以上 ○9割以上 △</small></div>` : ''}</div></div>`;
  };
  const t = sm.totals;
  const totals = `<div class="card"><h3>総請求額集計</h3><table class="kv sum"><tr><th>区分</th><th>累計請求額</th><th>構成比</th></tr>
    ${t.trades.map(tr => tr.items.map(i => `<tr><th>${esc(kname(i.k))}${i.k.taisho === false ? ' <small>(対象外)</small>' : ''}</th><td>${yen(i.cum)}</td><td>${pct(i.share)}</td></tr>`).join('') + `<tr class="tot"><th>${esc(tr.trade)} 合計</th><td>${yen(tr.sum)}</td><td>${pct(tr.share)}</td></tr>`).join('')}
    <tr class="tot"><th>総合計</th><td>${yen(t.total)}</td><td>${pct(t.share)}</td></tr></table></div>`;
  const n = S.doc.notes || {};
  const notes = can('notes') ? `<div class="card"><h3>総括コメント</h3>${isView() ? `<textarea id="comment" rows="4">${esc(n.comment || '')}</textarea><button class="wide" data-a="comment">コメントを保存</button>` : `<p>${esc(n.comment || '（なし）')}</p>`}
    ${(n.meeting || []).length ? `<h3>打ち合わせメモ（Excelから）</h3><ul>${n.meeting.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</div>` : '';
  return `<h2>出来高会議サマリー</h2>
   <div class="card"><label class="f">報告月</label><select data-a="rm">${ms.map(m => `<option value="${m}" ${m === R ? 'selected' : ''}>${C.ymSlash(m)}${m === C.latestDataMonth(S.doc) ? '（最新）' : ''}</option>`).join('')}</select>
   <p class="muted small">締め：${esc(S.doc.settings.cycle || '21日～翌20日')}。累計は報告月の分まで。${S.doc.settings.excelReportMonth ? `Excel の報告月の欄は ${C.ymSlash(S.doc.settings.excelReportMonth)} のまま（Excel の累計は全期間）。` : ''}</p></div>
   <div class="sumgrid">${sm.secs.map(sec).join('')}</div>${totals}${notes}
   <button class="wide" data-a="csv|sum">⬇ サマリーCSV</button>`;
}
H.rm = (el) => { localStorage.setItem(KEY.rm, el.value); ui.keepScroll = true; render(); };
H.comment = () => op({ type: 'notes', patch: { comment: $('#comment').value } });

// ---- 設定・請書マスタ ----
function vSettings() {
  const d = S.doc, info = `<div class="card"><p>あなたは <b>${C.ROLES[S.role]}</b> で開いています。</p><p class="muted small">入力用が見られる範囲：${esc(C.SCOPES[S.scope])}</p>
    ${S.pendingInfo.unreadable && !isView() ? `<p class="muted small">ほかに、あなたの合言葉では読めない入力が ${S.pendingInfo.unreadable} 件あります。</p>` : ''}
    <p class="muted small">最終更新：${esc(d.updatedAt ? new Date(d.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '－')} ${esc(d.updatedBy || '')}</p>
    <label class="f">あなたの名前（入力の記録に残ります）</label><input type="text" id="whoS" value="${esc(who())}"><button class="wide" data-a="whoSave">名前を保存</button>
    <button class="wide" data-a="reload">最新を読み込む</button></div>`;
  const csv = (can('claims') ? '<button class="wide" data-a="csv|month">⬇ 月次CSV（請書×締め月）</button>' : '') + (can('labor') && can('targets') ? '<button class="wide" data-a="csv|sum">⬇ 会議サマリーCSV</button>' : '');
  const master = isView() ? `<h3>請書マスタ</h3>${activeK().concat(d.keisho.filter(k => k.active === false)).map(k => `<div class="card site" data-a="go|editk/${esc(k.id)}"><span class="no">${esc(k.no)}</span><div style="flex:1"><div class="nm">${esc(kname(k))}${k.active === false ? ' <span class="badge">使わない</span>' : ''}</div><div class="meta">${esc(k.name)}／${yenOr(k.amount)}／${k.taisho === false ? '出来高対象外' : k.group ? esc((d.groups.find(g => g.id === k.group) || {}).name || '') + 'で合算' : '単独管理'}</div></div><span class="arrow">›</span></div>`).join('')}
    <button class="wide" data-a="go|editk/new">＋ 請書を追加</button>
    <h3>合算グループ・目標単価</h3>${d.groups.map(g => `<div class="card site" data-a="go|editg/${esc(g.id)}"><div style="flex:1"><div class="nm">${esc(g.name)}</div><div class="meta">目標 ${yenOr(g.target, '目標なし')} 円/人工／${esc(C.groupMembers(d, g.id).map(kname).join('＋') || '請書なし')}</div></div><span class="arrow">›</span></div>`).join('')}
    <button class="wide" data-a="go|editg/new">＋ グループを追加</button>` : '';
  return `<h2>${isView() ? '設定' : 'その他'}</h2>${info}${csv ? `<div class="card">${csv}</div>` : ''}${master}
   ${!isView() ? sentList() + (sentAll().length ? '<button class="wide" data-a="sentClr">このスマホの控えを消す</button>' : '') : ''}
   <div class="card"><p class="muted small">このスマホに覚えた出来高の合言葉を消します（共用スマホ・機種変更のとき）。</p><button class="danger wide" data-a="lock">合言葉を忘れる</button></div>
   <p class="muted small"><a href="./">労務稼働予定へ</a></p>`;
}
H.whoSave = () => { localStorage.setItem(KEY.who, $('#whoS').value.trim()); alert('保存しました'); };
H.reload = async () => { try { await loadAll(); render(); } catch (e) { alert(e.message); } };
H.sentClr = () => { if (confirm('このスマホに残っている控えを消しますか？')) { localStorage.removeItem(KEY.sent); render(); } };
H.lock = () => { if (!confirm('出来高の合言葉を消しますか？次に開くとき入れ直しが必要です。')) return; localStorage.removeItem(KEY.pass); localStorage.removeItem(KEY.role); localStorage.removeItem(KEY.sent); location.hash = ''; location.reload(); };
H.csv = kind => {
  const R = reportMonth(); const text = kind === 'sum' ? C.csvSummary(S.doc, R) : C.csvMonthly(S.doc);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = kind === 'sum' ? `出来高サマリー_${R}.csv` : `出来高_月次_${today}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
function vEditK(id) {
  if (!isView()) return vInput();
  const d = S.doc, isNew = id === 'new';
  const k = isNew ? { id: '', no: Math.max(0, ...d.keisho.map(x => x.no || 0)) + 1, name: '', short: '', trade: '鳶', kubun: '', amount: null, start: '', end: '', from: C.closeMonthOf(today), to: (d.settings.period || {}).to || C.closeMonthOf(today), taisho: true, group: null, hasNinku: true, active: true, note: '' } : K(id);
  if (!k) return vSettings();
  const f = (key, label, type = 'text', extra = '') => `<label class="f">${label}</label><input type="${type}" data-k="${key}" value="${esc(k[key] ?? '')}" ${extra}>`;
  return `<h2>${isNew ? '請書を追加' : '請書を直す'}</h2><div class="card">
   ${f('no', 'No.', 'number', 'inputmode="numeric"')}${f('name', '請書名称（例 鳶工事 請書①）')}${f('short', '短い名前（例 鳶1 鉄骨）')}
   <label class="f">職種</label><select data-k="trade">${['鳶', '土工'].map(t => `<option ${k.trade === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
   ${f('kubun', '工事区分（鉄骨・仮設 など）')}
   <label class="f">請書金額（税抜・円）空欄＝未設定</label><input type="text" inputmode="numeric" data-k="amount" value="${k.amount == null ? '' : k.amount}">
   ${f('start', '契約開始（例 2026-03-02）')}${f('end', '契約終了')}
   ${f('from', '入力できる最初の締め月（YYYY-MM）')}${f('to', '最後の締め月（YYYY-MM）')}
   <label class="chk"><input type="checkbox" data-k="taisho" ${k.taisho !== false ? 'checked' : ''}> 出来高の対象（小口は外す）</label>
   <label class="f">合算グループ</label><select data-k="group"><option value="">なし（単独で管理）</option>${d.groups.map(g => `<option value="${esc(g.id)}" ${k.group === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
   <label class="f">単独のときの目標単価（円/人工、空欄＝なし）</label><input type="text" inputmode="numeric" data-k="target" value="${k.target ? k.target : ''}">
   <label class="chk"><input type="checkbox" data-k="hasNinku" ${k.hasNinku !== false ? 'checked' : ''}> 人工を入れる</label>
   <label class="chk"><input type="checkbox" data-k="active" ${k.active !== false ? 'checked' : ''}> 使う（外すと一覧・集計から隠す。データは消えません）</label>
   ${f('note', '備考')}
   <button class="primary wide" data-a="saveK|${esc(id)}">保存</button><button class="wide" data-a="go|settings">やめる</button></div>`;
}
H.saveK = id => {
  const v = {}; document.querySelectorAll('[data-k]').forEach(i => { v[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
  const amount = v.amount === '' ? null : parseAmount(v.amount), target = v.target === '' ? null : parseAmount(v.target);
  if (Number.isNaN(amount) || Number.isNaN(target)) return alert('金額は数字で入れてください');
  if (!/^\d{4}-\d{2}$/.test(v.from) || !/^\d{4}-\d{2}$/.test(v.to) || v.from > v.to) return alert('締め月は 2026-11 の形で、最初≦最後にしてください');
  if (!v.name) return alert('請書名称を入れてください');
  const patch = { no: Number(v.no) || 0, name: v.name, short: v.short || v.name, trade: v.trade, kubun: v.kubun, amount, start: v.start || null, end: v.end || null, from: v.from, to: v.to, taisho: v.taisho, group: v.group || null, target, hasNinku: v.hasNinku, active: v.active, note: v.note };
  if (id === 'new') op({ type: 'keishoAdd', k: { id: 'k' + Date.now().toString(36), ...patch } }); else op({ type: 'keisho', id, patch });
  location.hash = '#settings';
};
function vEditG(id) {
  if (!isView()) return vInput();
  const isNew = id === 'new', g = isNew ? { name: '', target: null, method: '', note: '' } : S.doc.groups.find(x => x.id === id); if (!g) return vSettings();
  return `<h2>${isNew ? 'グループを追加' : 'グループを直す'}</h2><div class="card">
   <label class="f">名前</label><input type="text" data-k="name" value="${esc(g.name)}">
   <label class="f">目標単価（円/人工）</label><input type="text" inputmode="numeric" data-k="target" value="${g.target ?? ''}">
   <label class="f">算出方法</label><input type="text" data-k="method" value="${esc(g.method || '')}">
   <label class="f">備考</label><input type="text" data-k="note" value="${esc(g.note || '')}">
   <p class="muted small">どの請書を合算するかは、請書の画面の「合算グループ」で選びます。</p>
   <button class="primary wide" data-a="saveG|${esc(id)}">保存</button><button class="wide" data-a="go|settings">やめる</button></div>`;
}
H.saveG = id => {
  const v = {}; document.querySelectorAll('[data-k]').forEach(i => { v[i.dataset.k] = i.value.trim(); });
  const target = v.target === '' ? null : parseAmount(v.target); if (Number.isNaN(target)) return alert('目標は数字で入れてください'); if (!v.name) return alert('名前を入れてください');
  const patch = { name: v.name, target, method: v.method, note: v.note };
  if (id === 'new') op({ type: 'groupAdd', g: { id: 'g' + Date.now().toString(36), ...patch } }); else op({ type: 'group', id, patch });
  location.hash = '#settings';
};

// ---------- 体験モード（架空の請書・架空の数字。保存されません）----------
async function startDemo(role, scope) {
  const V = await generateRoleKey(), I = await generateRoleKey();
  const pubs = { view: V.pub, input: I.pub }, be = new MemoryBackend();
  const vstore = new DekidakaStore({ backend: be, role: 'view', priv: await importPriv(V.priv), pubs, scope });
  await vstore.save(demoDoc(), null);
  const store = role === 'view' ? vstore : new DekidakaStore({ backend: be, role: 'input', priv: await importPriv(I.priv), pubs, scope });
  await open(store, role, scope, true);
}
function demoDoc() {
  const at = '2026-01-01T00:00:00.000Z', by = '体験';
  const K = (id, no, short, trade, amount, group, taisho = true, hasNinku = true) => ({ id, no, name: `デモ請書${'ABCDEF'[no - 1]}（架空）`, short, trade, kubun: '架空', from: '2026-04', to: '2027-03', hasNinku, active: true, amount, start: '2026-04-01', end: '2027-03-31', taisho, group, note: '体験用の架空データ' });
  const keisho = [K('d1', 1, 'デモ鳶A', '鳶', 12345678, 'gd-t'), K('d2', 2, 'デモ鳶B', '鳶', null, 'gd-t'), K('d3', 3, 'デモ鳶C', '鳶', 2222222, null), K('d4', 4, 'デモ土工A', '土工', 9876543, 'gd-d'), K('d5', 5, 'デモ土工B', '土工', 1111111, 'gd-d'), K('d6', 6, 'デモ小口', '土工', null, null, false, false)];
  const records = {}, put = (id, ym, a, n, note) => { records[`${id}|${ym}`] = { amount: { v: a, at, by }, ...(n != null ? { ninku: { v: n, at, by } } : {}), ...(note ? { note: { v: note, at, by } } : {}) }; };
  ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((ym, i) => { put('d1', ym, 1111111 + i * 111111, 22 + i, i === 0 ? '架空' : ''); put('d2', ym, 333333, 11); put('d4', ym, 777777 - i * 11111, 22); if (i % 2) put('d5', ym, 123456, 3); put('d6', ym, 111111, null); });
  put('d3', '2026-07', 999999, 33);
  return { schema: C.SCHEMA, merged: [], updatedAt: at, updatedBy: by, settings: { cycleDay: 21, cycle: '毎月21日～翌月20日締め（体験）', period: { from: '2026-04', to: '2027-03' } }, keisho, groups: [{ id: 'gd-t', name: 'デモ鳶（A＋B）', target: 33333 }, { id: 'gd-d', name: 'デモ土工（A＋B）', target: 22222 }], records, notes: { comment: '体験用のコメント（架空）', meeting: [] } };
}

boot().catch(e => fatal('エラー：' + e.message));
