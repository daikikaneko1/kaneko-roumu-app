// 出来高管理（スマホで入力・PCで集計）。合言葉は労務とは別：入力用（番頭さん）・閲覧用（幹部）。
import * as C from './dk-core.js';
import { decryptSecret } from './crypto.js';
import { importPriv, generateRoleKey } from './dk-crypto.js';
import { GitHubBackend, MemoryBackend, DekidakaStore } from './dk-store.js';
import { Sync } from './store.js';
import CONFIG from './config.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = { pass: 'dk.pass', role: 'dk.role', who: 'dk.who', sent: 'dk.sent', rm: 'dk.reportMonth', aggAll: 'dk.aggAll', site: 'dk.site', showDone: 'dk.showDone', reqs: 'dk.reqs' };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const S = { role: null, scope: 0, store: null, sync: null, doc: null, demo: false, pendingInfo: { n: 0, unreadable: 0 }, requests: [] };
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
// 現場：選んでいる現場（このスマホに覚える）。無ければ竣工でない最初の現場
const sites = () => C.sitesOf(S.doc);
const siteName = id => (C.siteById(S.doc, id) || {}).name || '（現場なし）';
function curSite() {
  const ss = sites(); if (!ss.length) return null;
  const v = ui.site || localStorage.getItem(KEY.site);
  if (v && ss.some(x => x.id === v)) return v;
  return (ss.find(x => !x.done) || ss[0]).id;
}
const siteK = sid => C.siteKeisho(S.doc, sid);
function sitebar(sid) {
  if (!sites().length) return '';
  const st = C.siteById(S.doc, sid) || {};
  return `<div class="sitebar"><span class="sn">🏗 <b>${esc(st.name || '')}</b>${st.done ? ' <span class="badge">竣工</span>' : ''}</span><span class="sbtn">${isView() && st.id ? `<button class="edit" data-a="go|edits/${esc(st.id)}" title="現場名・竣工を直す">✎ 現場名</button>` : ''}${sites().length > 1 ? '<button class="link" data-a="go|home">現場を変える</button>' : ''}</span></div>`;
}

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
  if (!location.hash || location.hash === '#') location.hash = '#home'; else render();
}
// 閲覧用：全体データ＋未取り込みの入力（取り込んで保存し直す）。入力用：読める範囲だけ・未取り込みは重ねて表示（保存しない）
async function loadAll() {
  if (isView()) {
    if (!S.sync) S.sync = new Sync(S.store, C.applyOps, { onChange: showStatus });
    if (S.sync.pending.length) await S.sync.save(who());
    await S.sync.load();
    const pe = await S.store.pendingEntries(S.sync.base.merged);
    S.pendingInfo = { n: pe.entries.length, unreadable: pe.unreadable };
    S.requests = pe.requests || [];
    if (pe.entries.length) { S.sync.push({ type: 'merge', entries: pe.entries }); scheduleSave(); }
    S.doc = S.sync.doc;
  } else {
    const { doc } = await S.store.load();
    const pe = await S.store.pendingEntries(doc.merged);
    S.pendingInfo = { n: pe.entries.length, unreadable: pe.unreadable }; S.requests = pe.requests || [];
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
function op(o) { opMany([o]); }
function opMany(list) { for (const o of list) S.sync.push({ ...o, by: who(), when: new Date().toISOString() }); S.doc = S.sync.doc; scheduleSave(); render(); }
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
  const items = [['home', '🏗', '現場'], ['input', '✏️', '入力']];
  if (can('master') || can('claims')) items.push(['list', '📄', '請書']);
  if (can('labor') && can('targets')) items.push(['agg', '📊', '集計'], ['sum', '📋', 'サマリー']);
  items.push(['settings', '⚙️', isView() ? '設定' : 'その他']);
  return items;
}
function buildNav() { const n = $('#nav'); n.innerHTML = navItems().map(([h, i, t]) => `<a href="#${h}" data-nav="${h}"><span>${i}</span>${t}</a>`).join(''); n.hidden = false; }
function render() {
  if (!S.doc) return;
  const [r, a, b] = location.hash.slice(1).split('/').map(decodeURIComponent);
  const allowed = navItems().map(x => x[0]).concat(['sheet', 'editk', 'editg', 'edits', 'done', 'reqnew', 'req', 'reqdone']);
  const route = allowed.includes(r) ? r : 'home';
  document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('on', x.dataset.nav === ({ sheet: 'list', editk: 'list', editg: 'settings', edits: 'home', req: 'home', done: 'input', reqnew: 'input', reqdone: 'input' }[route] || route)));
  const f = { home: vHome, input: () => vInput(a, b), done: vDone, list: vList, sheet: () => vSheet(a), agg: vAgg, sum: vSum, settings: vSettings, editk: () => vEditK(a), editg: () => vEditG(a), edits: () => vEditS(a), reqnew: vReqNew, req: () => vReq(a), reqdone: vReqDone }[route];
  const y = window.scrollY; $('#main').innerHTML = f(); bind();
  window.scrollTo(0, ui.keepScroll ? y : 0); ui.keepScroll = false; showStatus();
}
const H = {};
function bind() {
  $('#main').querySelectorAll('[data-a]').forEach(el => { const ev = el.tagName === 'SELECT' ? 'onchange' : 'onclick'; el[ev] = e => { e.stopPropagation(); const [n, ...args] = el.dataset.a.split('|'); H[n] && H[n](...args, el); }; });
}
H.go = h => { location.hash = '#' + h; };

// ---- 現場（トップ）：現場カード＋会社合計。竣工は隠す ----
H.site = id => { ui.site = id; localStorage.setItem(KEY.site, id); location.hash = can('master') || can('claims') ? '#list' : '#input'; };
H.showDone = () => { localStorage.setItem(KEY.showDone, localStorage.getItem(KEY.showDone) === '1' ? '0' : '1'); ui.keepScroll = true; render(); };
const blockLine = b => `<div class="bl"><span class="bn">${esc(b.name)}</span><span><b class="${b.target && b.dekidaka != null ? (b.dekidaka >= b.target ? 'good' : b.dekidaka >= b.target * 0.9 ? 'mid' : 'bad') : ''}">${b.dekidaka == null ? '—' : yen(b.dekidaka)}</b> 円/人工</span>${b.target ? `<span>目標差 <b class="${b.diff < 0 ? 'neg' : ''}">${b.diff == null ? '—' : (b.diff > 0 ? '+' : '') + yen(b.diff)}</b></span><span>達成率 <b>${pct(b.achieve)}</b> ${b.eval || ''}</span>` : '<span class="muted">目標なし</span>'}</div>`;
function vHome() {
  const all = sites(), showDone = localStorage.getItem(KEY.showDone) === '1', nDone = all.filter(x => x.done).length;
  const vis = all.filter(x => showDone || !x.done), Cl = can('claims'), L = can('labor') && can('targets');
  const cards = vis.map(st => {
    const r = C.siteResult(S.doc, st.id);
    return `<div class="card site sitecard" data-a="site|${esc(st.id)}"><div style="flex:1;min-width:0">
      <div class="nmrow"><div class="nm">${esc(st.name)}${st.done ? ' <span class="badge">竣工</span>' : ''}</div>${isView() ? `<button class="edit" data-a="go|edits/${esc(st.id)}" title="現場名・竣工を直す">✎ 編集</button>` : ''}</div>
      <div class="meta">請書 ${r.count}件${r.koguCount ? `・小口 ${r.koguCount}件` : ''}${can('master') ? `／請書金額 ${yenOr(r.amount, '未設定')}` : ''}</div>
      ${Cl ? `<div class="kv2"><span>累計請求 <b>${yen(r.cum)}</b> 円</span>${L ? `<span>累計人工 <b>${num(r.cumNinku, 2)}</b></span>` : ''}</div>${r.koguCount ? `<div class="kv2 sub"><span>うち請書 ${yen(r.keishoCum)} 円</span><span>うち小口（積み上げ） ${yen(r.kogu)} 円</span></div>` : ''}` : ''}
      ${L ? r.secs.filter(b => b.target).map(blockLine).join('') : ''}</div><span class="arrow">›</span></div>`;
  }).join('');
  let company = '';
  if (Cl && vis.length) {
    const cr = C.companyResult(S.doc, vis.map(x => x.id));
    company = `<div class="card company"><h3>会社合計<span class="muted small">（${showDone ? '竣工も含む' : '竣工を除く'} ${vis.length}現場）</span></h3>
      <div class="kv2"><span>累計請求 <b>${yen(cr.cum)}</b> 円</span>${L ? `<span>累計人工 <b>${num(cr.cumNinku, 2)}</b></span>` : ''}</div>${cr.kogu ? `<div class="kv2 sub"><span>うち請書 ${yen(cr.cum - cr.kogu)} 円</span><span>うち小口 ${yen(cr.kogu)} 円</span></div>` : ''}
      ${L ? cr.trades.map(t => blockLine({ name: t.trade + '（目標のある合算・単独）', dekidaka: t.dekidaka, target: t.target, diff: t.diff, achieve: t.achieve, eval: C.evalMark(t.dekidaka, t.target) })).join('') : ''}</div>`;
  }
  const reqs = reqCards();
  return `<h2>現場</h2>${reqs}
   ${all.length ? '' : `<div class="card warn">${isView() ? '現場がまだありません。「＋ 現場を追加」から作ってください。' : '現場がまだありません。幹部に連絡してください。'}</div>`}
   <div class="sitegrid">${cards}</div>${company}
   ${nDone ? `<button class="toggle ${showDone ? 'on' : ''}" data-a="showDone">${showDone ? '☑' : '☐'} 竣工の現場も表示（${nDone}）</button>` : ''}
   ${isView() ? '<button class="wide" data-a="go|edits/new">＋ 現場を追加</button>' : ''}
   <p class="muted small">現場を押すと、その現場の請書一覧・入力・集計・サマリーへ。${Cl ? '累計は入力のある全部の月。' : ''}</p>`;
}
// 請書追加の申請：閲覧用＝確認待ちの一覧（承認・却下）、入力用＝自分たちの申請の状況
function reqCards() {
  if (!can('master')) return '';
  const pend = S.requests || [];
  if (isView()) return pend.length ? `<div class="card notice"><h3>請書追加の申請 ${pend.length}件（確認待ち）</h3>${pend.map(q => `<div class="site" data-a="go|req/${esc(q.id)}"><div style="flex:1"><div class="nm">${esc(q.req.name)}</div><div class="meta">${esc(siteName(q.req.siteId))}／${q.req.kind === 'kogu' ? '小口・' : ''}${esc(q.req.trade || '')} ${esc(q.req.kubun || '')}／${dt(q.at)} ${esc(q.by || '')}</div></div><span class="arrow">›</span></div>`).join('')}</div>` : '';
  const done = (S.doc.requests || []).slice(-5).reverse();
  if (!pend.length && !done.length) return '';
  return `<div class="card"><h3>請書追加の申請</h3>${pend.map(q => `<div class="meta">⏳ ${esc(q.req.name)}（${esc(siteName(q.req.siteId))}）幹部の確認待ち</div>`).join('')}${done.map(q => `<div class="meta">${q.decision === 'approved' ? '✓ 追加されました' : '✕ 見送り'}：${esc((q.req || {}).name || '')}</div>`).join('')}</div>`;
}

// ---- 入力（現場 → 請書 → 締め月 → 請求額・人工・備考 → 保存）----
function defaultYm(k) { const ms = C.keishoMonths(k); const cur = C.closeMonthOf(today, S.doc.settings.cycleDay || 21); return ms.includes(cur) ? cur : cur < ms[0] ? ms[0] : ms[ms.length - 1]; }
function vInput(kid, ym) {
  const sid = curSite(), ks = sites().length ? siteK(sid) : activeK();
  if (!kid || !K(kid)) {
    return `${sitebar(sid)}<h2>① 請書をえらぶ</h2><div class="steps">${sites().length > 1 ? '<a href="#home">現場</a> → ' : ''}<b>①請書</b> → ②締め月 → ③数字 → 保存</div>
     ${ks.length ? '' : '<p class="muted">この現場には請書がまだありません。</p>'}
     ${ks.map(k => `<button class="wide pick" data-a="go|input/${esc(k.id)}"><span class="no">${esc(k.no)}</span><span class="t"><b>${esc(kname(k))}</b><small>${esc(k.name)}${C.isKogu(k) ? '・小口（単月請求）' : k.taisho === false ? '・出来高対象外' : ''}</small></span><span class="arrow">›</span></button>`).join('')}
     ${addKButton(sid)}
     ${sentList(3)}`;
  }
  const k = K(kid); if (sites().length) ui.site = C.siteOfK(S.doc, k);
  const ms = C.keishoMonths(k), day = S.doc.settings.cycleDay || 21;
  ym = ms.includes(ym) ? ym : defaultYm(k);
  const i = ms.indexOf(ym);
  const cur = { amount: C.val(S.doc, k.id, ym, 'amount'), ninku: C.val(S.doc, k.id, ym, 'ninku'), note: C.val(S.doc, k.id, ym, 'note') };
  const showCur = f => (f === 'amount' ? can('claims') : can('labor'));
  const hint = f => { if (!showCur(f)) return ''; const v = cur[f]; return `<div class="cur">今の値：${v == null ? 'なし' : f === 'amount' ? yen(v) + ' 円' : f === 'ninku' ? num(v, 3) + ' 人工' : esc(v)}</div>`; };
  const pre = f => (isView() && cur[f] != null ? (f === 'amount' ? String(cur[f]) : String(cur[f])) : '');
  const clr = f => (isView() ? `<label class="chk small"><input type="checkbox" id="clr-${f}"> 空にする</label>` : '');
  return `<div class="steps"><a href="#input">①請書</a> → <b>②締め月・③数字</b> → 保存</div>
   <div class="card">${sites().length ? `<div class="muted small">現場：${esc(siteName(C.siteOfK(S.doc, k)))}</div>` : ''}<div class="muted small">請書</div><div class="big-name">${esc(kname(k))}</div><div class="muted small">${esc(k.name)}</div><button class="link" data-a="go|input">請書を変える</button></div>
   <div class="card"><label class="f">② 締め月</label>
    <select id="ym" data-a="ympick|${esc(k.id)}">${ms.map(m => `<option value="${m}" ${m === ym ? 'selected' : ''}>${C.closeLabel(m, day)}</option>`).join('')}</select>
    <div class="monthpick"><button data-a="go|input/${esc(k.id)}/${ms[i - 1] || ym}" ${i <= 0 ? 'disabled' : ''}>◀ 前の月</button><button data-a="go|input/${esc(k.id)}/${ms[i + 1] || ym}" ${i >= ms.length - 1 ? 'disabled' : ''}>次の月 ▶</button></div></div>
   <div class="card"><label class="f" for="amount">③ ${C.isKogu(k) ? '当月の小口請求額（税抜・円）' : '当月請求額（税抜・円）'}</label>${C.isKogu(k) ? '<p class="muted small">小口はその月の請求をそのまま入れます（請書金額から引くのではなく、累計に積み上がります）。</p>' : ''}
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
  const sn = k.site ?? (k.id && sites().length ? siteName(C.siteOfK(S.doc, k)) : null);
  return `<table class="kv">${sn ? row('現場', esc(sn)) : ''}${row('請書', esc(kname(k)))}${row('締め月', C.closeLabel(ym, S.doc.settings.cycleDay || 21))}
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
      const rec = { kid: k.id, kname: kname(k), site: sites().length ? siteName(C.siteOfK(S.doc, k)) : null, ym, fields, at, by: who(), role: S.role };
      ui.last = rec; remember(rec); close(); location.hash = '#done';
    } catch (e) { $('#co').disabled = false; $('#cm').textContent = '保存できませんでした。電波を確認してもう一度押してください。（' + e.message + '）'; }
  };
}
// 送った内容はこのスマホにだけ残す（入力用は他の人の入力・結果は読めない）
function remember(rec) { try { const a = JSON.parse(localStorage.getItem(KEY.sent) || '[]'); a.unshift(rec); localStorage.setItem(KEY.sent, JSON.stringify(a.slice(0, 30))); } catch { } }
const sentAll = () => { try { return JSON.parse(localStorage.getItem(KEY.sent) || '[]'); } catch { return []; } };
function sentList(max = 30) {
  const a = sentAll().slice(0, max); if (!a.length) return '';
  return `<h3>このスマホから送った内容</h3>${a.map(r => `<div class="card sent"><div class="muted small">${dt(r.at)} ${esc(r.by || '')}</div>${fieldsHtml({ short: r.kname, site: r.site || null }, r.ym, r.fields)}</div>`).join('')}
   ${max < 30 && sentAll().length > max ? '<a href="#settings">もっと見る</a>' : ''}`;
}
function vDone() {
  const r = ui.last; if (!r) return vInput();
  return `<div class="card ok"><h2>✓ 保存しました</h2><p class="muted small">${dt(r.at)}${r.by ? ' ・ ' + esc(r.by) : ''}</p>${fieldsHtml({ short: r.kname, site: r.site || null }, r.ym, r.fields)}
   ${!isView() ? '<p class="muted small">この内容は、このスマホにだけ控えとして残ります。</p>' : ''}</div>
   <button class="primary wide" data-a="go|input/${esc(r.kid)}/${C.nextMonth(r.ym)}">同じ請書の次の月を入れる</button>
   <button class="wide" data-a="go|input">別の請書を入れる</button>`;
}

// ---- 請書一覧・月次シート ----
function vList() {
  const R = reportMonth(), sid = curSite(), all = sites().length ? siteK(sid) : activeK();
  const ks = all.filter(k => !C.isKogu(k)), kg = all.filter(C.isKogu), M = can('master'), Cl = can('claims'), L = can('labor');
  const rows = ks.map(k => { const c = C.cumThrough(S.doc, k, R); const rate = k.amount ? c.amount / k.amount : null;
    return `<tr data-a="go|sheet/${esc(k.id)}" class="click"><td class="nm"><b>${esc(kname(k))}</b><br><small>${esc(k.name)}${k.taisho === false ? '・対象外' : ''}</small></td>${M ? `<td>${yenOr(k.amount)}</td>` : ''}${Cl ? `<td>${yen(c.amount)}</td>` : ''}${M && Cl ? `<td>${k.amount ? pct(rate) : '—'}</td>` : ''}${L ? `<td>${num(c.ninku, 1)}</td>` : ''}</tr>`; }).join('');
  const cs = ks.map(k => C.cumThrough(S.doc, k, R)), amt = ks.some(k => k.amount != null) ? ks.reduce((t, k) => t + (k.amount || 0), 0) : null, cum = cs.reduce((t, c) => t + c.amount, 0);
  const tot = ks.length > 1 ? `<tr class="tot"><td class="nm">請書の合計（${ks.length}件）</td>${M ? `<td>${yenOr(amt)}</td>` : ''}${Cl ? `<td>${yen(cum)}</td>` : ''}${M && Cl ? '<td></td>' : ''}${L ? `<td>${num(cs.reduce((t, c) => t + c.ninku, 0), 1)}</td>` : ''}</tr>` : '';
  // 小口：請書金額なし。当月（報告月）の請求と、積み上がった累計
  const kc = kg.map(k => ({ k, c: C.cumThrough(S.doc, k, R), m: C.val(S.doc, k.id, R, 'amount'), n: C.keishoSeries(S.doc, k).filter(r => r.amount != null && (!R || r.ym <= R)).length }));
  const krows = kc.map(({ k, c, m, n }) => `<tr data-a="go|sheet/${esc(k.id)}" class="click"><td class="nm"><b>${esc(kname(k))}</b><br><small>${esc(k.name)}・小口（単月請求）</small></td>${Cl ? `<td>${yen(m)}</td><td>${yen(c.amount)}</td><td>${n}か月</td>` : ''}${L ? `<td>${k.hasNinku !== false ? num(c.ninku, 1) : '—'}</td>` : ''}</tr>`).join('');
  const kcum = kc.reduce((t, x) => t + x.c.amount, 0);
  const ktot = kg.length > 1 ? `<tr class="tot"><td class="nm">小口の合計</td>${Cl ? `<td>${yen(kc.reduce((t, x) => t + (x.m || 0), 0))}</td><td>${yen(kcum)}</td><td></td>` : ''}${L ? '<td></td>' : ''}</tr>` : '';
  return `${sitebar(sid)}<h2>請書一覧</h2><p class="muted small">累計は ${C.ymSlash(R || '')} 分まで（報告月はサマリーで変えられます）。行を押すと月ごとの表。</p>
   <div class="grid-wrap"><table class="grid dk"><thead><tr><th class="nm">請書</th>${M ? '<th>請書金額</th>' : ''}${Cl ? '<th>累計請求</th>' : ''}${M && Cl ? '<th>消化率</th>' : ''}${L ? '<th>累計人工</th>' : ''}</tr></thead><tbody>${rows}${tot}</tbody></table></div>
   ${kg.length ? `<h3>小口（単月請求・積み上げ）</h3><p class="muted small">小口は請書金額がなく、毎月の請求がそのまま積み上がります（出来高の対象外）。</p>
   <div class="grid-wrap"><table class="grid dk kogu"><thead><tr><th class="nm">小口</th>${Cl ? `<th>当月請求<br><small>${C.ymSlash(R || '')}</small></th><th>累計請求</th><th>請求した月</th>` : ''}${L ? '<th>累計人工</th>' : ''}</tr></thead><tbody>${krows}${ktot}</tbody></table></div>` : ''}
   ${Cl && kg.length && ks.length ? `<div class="card"><div class="kv2"><span>現場の累計請求（請書＋小口） <b>${yen(cum + kcum)}</b> 円</span></div></div>` : ''}
   ${addKButton(sid)}`;
}
// 請書を足すボタン：閲覧用は直接追加、入力用は「請書追加の申請」（幹部が確認）
function addKButton(sid) {
  if (!sites().length) return isView() ? '<button class="wide" data-a="go|editk/new">＋ 請書を追加</button>' : '';
  return isView() ? `<button class="wide" data-a="go|editk/new">＋ この現場に請書を追加</button>` : `<button class="wide" data-a="go|reqnew">＋ 請書の追加を申請する（幹部が確認）</button>`;
}
function vSheet(id) {
  const k = K(id); if (!k) return vList();
  const ser = C.keishoSeries(S.doc, k), L = can('labor');
  const last = Math.max(...ser.map((r, i) => (r.amount != null || r.ninku != null || r.note ? i : -1)), -1);
  const show = localStorage.getItem(KEY.aggAll) === '1' ? ser : ser.slice(0, Math.max(last + 2, 1));
  const src = (f, ym) => { const r = S.doc.records[C.keyOf(k.id, ym)]; return r && r[f] && r[f].src === 'entry' ? ' e' : ''; };
  const kogu = C.isKogu(k), maxCum = Math.max(1, ...ser.map(r => Math.abs(r.cumAmount)));
  const bar = r => (kogu ? `<td class="barc"><span class="bar" style="width:${Math.round(Math.max(0, r.cumAmount) / maxCum * 100)}%"></span></td>` : '');
  return `${sites().length ? sitebar(C.siteOfK(S.doc, k)) : ''}<h2>${esc(kname(k))}${kogu ? ' <span class="badge">小口</span>' : ''}</h2><p class="muted small">${esc(k.name)}／${kogu ? '小口（月々の単月請求。請書金額はなく、請求が積み上がります）' : '請書金額 ' + yenOr(k.amount)}${k.start && !kogu ? '／契約 ' + esc(k.start) + '〜' + esc(k.end || '') : ''}</p>
   ${allToggle()}
   <div class="grid-wrap"><table class="grid dk"><thead><tr><th class="nm">締め月</th><th>当月請求額</th>${L ? '<th>当月人工</th>' : ''}<th>累計請求額</th>${kogu ? '<th>積み上がり</th>' : ''}${L ? '<th>累計人工</th><th class="l">備考</th>' : ''}</tr></thead><tbody>
   ${show.map(r => `<tr ${isView() ? `data-a="go|input/${esc(k.id)}/${r.ym}" class="click"` : ''}><td class="nm">${C.ymSlash(r.ym)}</td><td class="${r.amount < 0 ? 'neg' : ''}${src('amount', r.ym)}">${yen(r.amount)}</td>${L ? `<td class="${src('ninku', r.ym)}">${num(r.ninku, 3)}</td>` : ''}<td>${yen(r.cumAmount)}</td>${bar(r)}${L ? `<td>${num(r.cumNinku, 2)}</td><td class="l">${esc(r.note || '')}</td>` : ''}</tr>`).join('')}
   <tr class="tot"><td class="nm">合計</td><td>${yen(ser.reduce((s, r) => s + (r.amount || 0), 0))}</td>${L ? `<td>${num(ser.reduce((s, r) => s + (r.ninku || 0), 0), 3)}</td>` : ''}<td></td>${kogu ? '<td></td>' : ''}${L ? '<td></td><td></td>' : ''}</tr></tbody></table></div>
   ${isView() ? `<p class="muted small">行を押すとその月を直せます。水色＝入力用から届いた値。</p><button class="wide" data-a="go|editk/${esc(k.id)}">${kogu ? 'この小口（名前・種別・期間）を直す' : 'この請書（名前・金額・期間・種別）を直す'}</button>` : ''}`;
}
const allToggle = () => { const on = localStorage.getItem(KEY.aggAll) === '1'; return `<button class="toggle ${on ? 'on' : ''}" data-a="aggall">${on ? '☑' : '☐'} 先の空の月も表示</button>`; };
H.aggall = () => { localStorage.setItem(KEY.aggAll, localStorage.getItem(KEY.aggAll) === '1' ? '0' : '1'); ui.keepScroll = true; render(); };

// ---- 出来高集計（Excel「出来高集計」）----
function vAgg() {
  const sid = curSite(), bl = C.blocks(S.doc, sid); if (!bl.length) return sitebar(sid) + '<p>この現場には出来高対象の請書がありません。</p>';
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
  return `${sitebar(sid)}<h2>出来高集計</h2><div class="tabs wrap">${bl.map(x => `<button data-a="blk|${x.id}" class="${x.id === b.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
   <p class="muted small">${multi ? esc(b.members.map(kname).join('＋')) + ' の合算' : '単独で出来高管理'}${T ? `／目標 ${yen(T)} 円/人工` : '／目標なし'}。出来高＝請求÷人工（人工0の月は空欄）。</p>
   ${allToggle()}<div class="grid-wrap"><table class="grid dk"><thead>${head}</thead><tbody>${rows.map(tr).join('')}${tot}</tbody></table></div>
   <button class="wide" data-a="csv|month">⬇ 月次CSV</button>`;
}
H.blk = id => { ui.blk = id; ui.keepScroll = true; render(); };

// ---- 会議サマリー ----
function dataMonths() { const s = new Set(); for (const [key, r] of Object.entries(S.doc.records)) if ((r.amount && r.amount.v != null) || (r.ninku && r.ninku.v != null)) s.add(key.split('|')[1]); return [...s].sort(); }
function reportMonth() { const ms = dataMonths(), saved = localStorage.getItem(KEY.rm); return saved && ms.includes(saved) ? saved : C.latestDataMonth(S.doc); }
function vSum() {
  const R = reportMonth(), sid = sites().length ? curSite() : null, sm = C.summary(S.doc, R, sid), ms = dataMonths();
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
      ${b.target ? `<div><small>目標との差${b.type === 'group' && b.g && b.g.common || b.type === 'single' && b.members[0].common ? '（共通単価）' : ''}</small><b class="${b.diff < 0 ? 'neg' : ''}">${b.diff == null ? '—' : (b.diff > 0 ? '+' : '') + yen(b.diff)}</b><small>達成率 ${b.dekidaka == null ? '—' : pct(b.dekidaka / b.target)}</small></div><div><small>評価</small><b class="mark">${b.eval || '—'}</b><small>◎目標以上 ○9割以上 △</small></div>` : ''}</div></div>`;
  };
  const t = sm.totals;
  const totals = `<div class="card"><h3>総請求額集計</h3><table class="kv sum"><tr><th>区分</th><th>累計請求額</th><th>構成比</th></tr>
    ${t.trades.map(tr => tr.items.map(i => `<tr><th>${esc(kname(i.k))}${i.kogu ? ' <small>(小口)</small>' : i.k.taisho === false ? ' <small>(対象外)</small>' : ''}</th><td>${yen(i.cum)}</td><td>${pct(i.share)}</td></tr>`).join('') + `<tr class="tot"><th>${esc(tr.trade)} 合計</th><td>${yen(tr.sum)}</td><td>${pct(tr.share)}</td></tr>`).join('')}
    <tr class="tot"><th>総合計</th><td>${yen(t.total)}</td><td>${pct(t.share)}</td></tr></table></div>`;
  const n = S.doc.notes || {};
  const notes = can('notes') ? `<div class="card"><h3>総括コメント</h3>${isView() ? `<textarea id="comment" rows="4">${esc(n.comment || '')}</textarea><button class="wide" data-a="comment">コメントを保存</button>` : `<p>${esc(n.comment || '（なし）')}</p>`}
    ${(n.meeting || []).length ? `<h3>打ち合わせメモ（Excelから）</h3><ul>${n.meeting.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</div>` : '';
  return `${sitebar(sid)}<h2>出来高会議サマリー</h2>
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
  const cm = d.common || {};
  const master = isView() ? `<h3>共通の目標単価（全現場）</h3><div class="card"><p class="muted small">合算グループ・請書で「共通の目標単価」にしたものは、ここの単価で目標差・達成率を出します。</p>
    <label class="f">鳶（円/人工）</label><input type="text" inputmode="numeric" id="cmTobi" value="${cm['鳶'] ?? ''}">
    <label class="f">土工（円/人工）</label><input type="text" inputmode="numeric" id="cmDoko" value="${cm['土工'] ?? ''}">
    <button class="wide" data-a="saveCommon">共通の目標単価を保存</button></div>
    <h3>現場</h3>${sites().map(st => `<div class="card site" data-a="go|edits/${esc(st.id)}"><div style="flex:1"><div class="nm">${esc(st.name)}${st.done ? ' <span class="badge">竣工</span>' : ''}</div><div class="meta">請書 ${siteK(st.id).length}件${(st.roumuIds || []).length ? '／労務の現場 ' + esc(st.roumuIds.join('・')) : ''}</div></div><span class="arrow">›</span></div>`).join('')}
    <button class="wide" data-a="go|edits/new">＋ 現場を追加</button>
    <h3>請書マスタ（全現場）</h3>${activeK().concat(d.keisho.filter(k => k.active === false)).map(k => `<div class="card site" data-a="go|editk/${esc(k.id)}"><span class="no">${esc(k.no)}</span><div style="flex:1"><div class="nm">${esc(kname(k))}${k.active === false ? ' <span class="badge">使わない</span>' : ''}</div><div class="meta">${sites().length ? esc(siteName(C.siteOfK(d, k))) + '／' : ''}${esc(k.name)}／${yenOr(k.amount)}／${C.isKogu(k) ? '小口（単月請求）' : k.taisho === false ? '出来高対象外' : k.group ? esc((d.groups.find(g => g.id === k.group) || {}).name || '') + 'で合算' : '単独管理'}</div></div><span class="arrow">›</span></div>`).join('')}
    <button class="wide" data-a="go|editk/new">＋ 請書を追加</button>
    <h3>合算グループ・目標単価</h3>${d.groups.map(g => `<div class="card site" data-a="go|editg/${esc(g.id)}"><div style="flex:1"><div class="nm">${esc(g.name)}</div><div class="meta">${sites().length ? esc(siteName(C.siteOfG(d, g))) + '／' : ''}目標 ${g.common ? '共通単価' : yenOr(g.target, '目標なし') + ' 円/人工'}／${esc(C.groupMembers(d, g.id).map(kname).join('＋') || '請書なし')}</div></div><span class="arrow">›</span></div>`).join('')}
    <button class="wide" data-a="go|editg/new">＋ グループを追加</button>` : '';
  return `<h2>${isView() ? '設定' : 'その他'}</h2>${info}${csv ? `<div class="card">${csv}</div>` : ''}${master}
   ${!isView() ? sentList() + (sentAll().length ? '<button class="wide" data-a="sentClr">このスマホの控えを消す</button>' : '') : ''}
   <div class="card"><p class="muted small">このスマホに覚えた出来高の合言葉を消します（共用スマホ・機種変更のとき）。</p><button class="danger wide" data-a="lock">合言葉を忘れる</button></div>
   <p class="muted small"><a href="./">労務稼働予定へ</a></p>`;
}
H.saveCommon = () => {
  const t = $('#cmTobi').value.trim(), d = $('#cmDoko').value.trim(); const a = t === '' ? null : parseAmount(t), b = d === '' ? null : parseAmount(d);
  if (Number.isNaN(a) || Number.isNaN(b)) return alert('単価は数字で入れてください'); op({ type: 'common', patch: { '鳶': a, '土工': b } }); alert('保存しました');
};
H.whoSave = () => { localStorage.setItem(KEY.who, $('#whoS').value.trim()); alert('保存しました'); };
H.reload = async () => { try { await loadAll(); render(); } catch (e) { alert(e.message); } };
H.sentClr = () => { if (confirm('このスマホに残っている控えを消しますか？')) { localStorage.removeItem(KEY.sent); render(); } };
H.lock = () => { if (!confirm('出来高の合言葉を消しますか？次に開くとき入れ直しが必要です。')) return; localStorage.removeItem(KEY.pass); localStorage.removeItem(KEY.role); localStorage.removeItem(KEY.sent); location.hash = ''; location.reload(); };
H.csv = kind => {
  const R = reportMonth(); const text = kind === 'sum' ? C.csvSummary(S.doc, R, sites().length ? curSite() : null) : C.csvMonthly(S.doc);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = kind === 'sum' ? `出来高サマリー_${R}.csv` : `出来高_月次_${today}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
// 請書の項目（追加・直す・申請・申請の確認で共通）
function kForm(k, { admin = true } = {}) {
  const d = S.doc;
  const f = (key, label, type = 'text', extra = '') => `<label class="f">${label}</label><input type="${type}" data-k="${key}" value="${esc(k[key] ?? '')}" ${extra}>`;
  const sid = k.siteId || curSite();
  return `${sites().length ? `<label class="f">現場</label><select data-k="siteId">${sites().map(st => `<option value="${esc(st.id)}" ${st.id === sid ? 'selected' : ''}>${esc(st.name)}${st.done ? '（竣工）' : ''}</option>`).join('')}</select>` : ''}
   ${f('no', 'No.', 'number', 'inputmode="numeric"')}${f('name', '請書名称（例 鳶工事 請書①）')}${f('short', '短い名前（例 鳶1 鉄骨）')}
   <label class="f">種別</label><select data-k="kind" data-a="kindChg">${Object.entries(C.KINDS).map(([v, t]) => `<option value="${v}" ${(C.isKogu(k) ? 'kogu' : 'normal') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
   <p class="muted small kindhint">${C.isKogu(k) ? KOGU_HINT : NORMAL_HINT}</p>
   <label class="f">職種</label><select data-k="trade">${['鳶', '土工'].map(t => `<option ${k.trade === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
   ${f('kubun', '工事区分（鉄骨・仮設 など）')}
   <div class="nokogu" ${C.isKogu(k) ? 'hidden' : ''}><label class="f">請書金額（税抜・円）空欄＝未設定</label><input type="text" inputmode="numeric" data-k="amount" value="${k.amount == null ? '' : k.amount}">
   ${f('start', '契約開始（例 2026-03-02）')}${f('end', '契約終了')}</div>
   ${f('from', '入力できる最初の締め月（YYYY-MM）')}${f('to', '最後の締め月（YYYY-MM）')}
   <div class="nokogu" ${C.isKogu(k) ? 'hidden' : ''}><label class="chk"><input type="checkbox" data-k="taisho" ${k.taisho !== false ? 'checked' : ''}> 出来高の対象</label>
   ${admin ? `<label class="f">合算グループ</label><select data-k="group"><option value="">なし（単独で管理）</option>${d.groups.map(g => `<option value="${esc(g.id)}" ${k.group === g.id ? 'selected' : ''}>${esc(g.name)}${sites().length > 1 ? '（' + esc(siteName(C.siteOfG(d, g))) + '）' : ''}</option>`).join('')}</select>
   <label class="chk"><input type="checkbox" data-k="common" ${k.common ? 'checked' : ''}> 単独のとき、共通の目標単価（${esc(k.trade || '鳶')}）を使う</label>
   <label class="f">単独のときの目標単価（円/人工、空欄＝なし。上のチェックが優先）</label><input type="text" inputmode="numeric" data-k="target" value="${k.target ? k.target : ''}">` : ''}
   </div><label class="chk"><input type="checkbox" data-k="hasNinku" ${k.hasNinku !== false ? 'checked' : ''}> 人工を入れる</label>
   ${admin ? `<label class="chk"><input type="checkbox" data-k="active" ${k.active !== false ? 'checked' : ''}> 使う（外すと一覧・集計から隠す。データは消えません）</label>` : ''}
   ${f('note', '備考')}`;
}
function newK() { const d = S.doc; return { id: '', no: Math.max(0, ...d.keisho.map(x => x.no || 0)) + 1, name: '', short: '', trade: '鳶', kubun: '', amount: null, start: '', end: '', from: C.closeMonthOf(today), to: (d.settings.period || {}).to || C.nextMonth(C.closeMonthOf(today)), taisho: true, group: null, hasNinku: true, active: true, note: '', siteId: curSite() }; }
function vEditK(id) {
  if (!isView()) return vInput();
  const isNew = id === 'new', k = isNew ? newK() : K(id);
  if (!k) return vSettings();
  return `<h2>${isNew ? '請書を追加' : '請書を直す'}</h2><div class="card">${kForm(k)}
   <button class="primary wide" data-a="saveK|${esc(id)}">保存</button><button class="wide" data-a="back">やめる</button></div>`;
}
const KOGU_HINT = '小口：請書金額はありません。毎月その月の請求を入れ、累計が積み上がります（出来高の対象外）。', NORMAL_HINT = '通常：請書金額から消化していく請書です。';
H.kindChg = el => { const kg = el.value === 'kogu'; document.querySelectorAll('.nokogu').forEach(x => { x.hidden = kg; }); const h = document.querySelector('.kindhint'); if (h) h.textContent = kg ? KOGU_HINT : NORMAL_HINT; };
H.back = () => history.back();
// フォームの値 → 請書の patch（だめなら null）
function readK({ admin = true } = {}) {
  const v = {}; document.querySelectorAll('[data-k]').forEach(i => { v[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
  const amount = v.amount === '' || v.amount == null ? null : parseAmount(v.amount), target = !v.target ? null : parseAmount(v.target);
  if (Number.isNaN(amount) || Number.isNaN(target)) { alert('金額は数字で入れてください'); return null; }
  if (!/^\d{4}-\d{2}$/.test(v.from) || !/^\d{4}-\d{2}$/.test(v.to) || v.from > v.to) { alert('締め月は 2026-11 の形で、最初≦最後にしてください'); return null; }
  if (!v.name) { alert('請書名称を入れてください'); return null; }
  const patch = { no: Number(v.no) || 0, name: v.name, short: v.short || v.name, trade: v.trade, kubun: v.kubun, amount, start: v.start || null, end: v.end || null, from: v.from, to: v.to, taisho: v.taisho, hasNinku: v.hasNinku, note: v.note };
  if (v.siteId) patch.siteId = v.siteId;
  if (admin) Object.assign(patch, { group: v.group || null, target, common: !!v.common, active: v.active });
  patch.kind = v.kind === 'kogu' ? 'kogu' : 'normal';
  if (patch.kind === 'kogu') Object.assign(patch, { amount: null, start: null, end: null, taisho: false, ...(admin ? { group: null, common: false, target: null } : {}) });
  return patch;
}
H.saveK = id => {
  const patch = readK(); if (!patch) return;
  if (patch.group) { const g = S.doc.groups.find(x => x.id === patch.group); if (g && sites().length && C.siteOfG(S.doc, g) !== (patch.siteId || curSite())) return alert('合算グループは同じ現場のものを選んでください'); }
  if (patch.siteId) { ui.site = patch.siteId; localStorage.setItem(KEY.site, patch.siteId); }
  if (id === 'new') op({ type: 'keishoAdd', k: { id: 'k' + Date.now().toString(36), ...patch } }); else op({ type: 'keisho', id, patch });
  location.hash = '#list';
};
// ---- 請書追加の申請（入力用）→ 幹部が確認 ----
function vReqNew() {
  if (isView()) return vEditK('new');
  if (!sites().length) return '<p>現場がまだありません。</p>';
  return `${sitebar(curSite())}<h2>請書の追加を申請</h2><div class="card notice"><p class="small">ここで入れた請書は、<b>幹部が確認して「承認」すると</b>一覧に入ります。それまでは数字を入れられません。</p></div>
   <div class="card">${kForm(newK(), { admin: false })}
   <button class="primary wide big" data-a="sendReq">申請する</button><button class="wide" data-a="back">やめる</button></div>`;
}
H.sendReq = async el => {
  const req = readK({ admin: false }); if (!req) return;
  if (!confirm(`「${req.name}」（${siteName(req.siteId)}）の追加を申請しますか？`)) return;
  el.disabled = true;
  try {
    const q = await S.store.addRequest({ req, by: who() });
    S.requests = [...(S.requests || []), q]; ui.lastReq = q;
    try { const a = JSON.parse(localStorage.getItem(KEY.reqs) || '[]'); a.unshift({ at: q.at, name: req.name, site: siteName(req.siteId) }); localStorage.setItem(KEY.reqs, JSON.stringify(a.slice(0, 20))); } catch { }
    location.hash = '#reqdone';
  } catch (e) { el.disabled = false; alert('申請できませんでした。電波を確認してもう一度。（' + e.message + '）'); }
};
function vReqDone() {
  const q = ui.lastReq; if (!q) return vHome();
  return `<div class="card ok"><h2>✓ 申請しました</h2><p>「${esc(q.req.name)}」（${esc(siteName(q.req.siteId))}）</p><p class="muted small">幹部が確認して承認すると、請書の一覧に出ます。</p></div><button class="wide" data-a="go|home">現場の一覧へ</button>`;
}
// 閲覧用：申請を確認（直してから承認もできる）
function vReq(id) {
  if (!isView()) return vHome();
  const q = (S.requests || []).find(x => x.id === id); if (!q) return '<p>この申請はもう処理済みです。</p><button class="wide" data-a="go|home">現場へ</button>';
  const k = { ...newK(), ...q.req, group: null, active: true };
  return `<h2>請書追加の申請を確認</h2><div class="card notice"><p class="small">${dt(q.at)} ${esc(q.by || '')} からの申請です。必要なら直してから「承認して追加」。</p></div>
   <div class="card">${kForm(k)}
   <button class="primary wide" data-a="reqOk|${esc(id)}">承認して追加</button><button class="danger wide" data-a="reqNg|${esc(id)}">却下する（追加しない）</button><button class="wide" data-a="go|home">あとで</button></div>`;
}
H.reqOk = id => {
  const q = S.requests.find(x => x.id === id); const patch = readK(); if (!q || !patch) return;
  const kid = 'k' + Date.now().toString(36);
  S.requests = S.requests.filter(x => x.id !== id);
  opMany([{ type: 'keishoAdd', k: { id: kid, ...patch } }, { type: 'reqDecide', id, decision: 'approved', keishoId: kid, req: q.req }]);
  location.hash = '#home';
};
H.reqNg = id => {
  const q = S.requests.find(x => x.id === id); if (!q || !confirm('この申請を却下しますか？（請書は追加しません）')) return;
  S.requests = S.requests.filter(x => x.id !== id);
  op({ type: 'reqDecide', id, decision: 'rejected', req: q.req }); location.hash = '#home';
};
// ---- 現場（閲覧用だけ：追加・名前・竣工・労務の現場とのつながり）----
function vEditS(id) {
  if (!isView()) return vHome();
  const isNew = id === 'new', st = isNew ? { name: '', done: false, roumuIds: [] } : C.siteById(S.doc, id); if (!st) return vHome();
  return `<h2>${isNew ? '現場を追加' : '現場を直す'}</h2><div class="card">
   <label class="f">現場名</label><input type="text" data-s="name" value="${esc(st.name)}">
   <label class="f">労務稼働予定の現場ID（例 s004,s023。空でもよい）</label><input type="text" data-s="roumuIds" value="${esc((st.roumuIds || []).join(','))}">
   <label class="chk"><input type="checkbox" data-s="done" ${st.done ? 'checked' : ''}> 竣工（一覧から隠す。データは消えません）</label>
   <label class="f">備考</label><input type="text" data-s="note" value="${esc(st.note || '')}">
   <button class="primary wide" data-a="saveS|${esc(id)}">保存</button><button class="wide" data-a="back">やめる</button></div>`;
}
H.saveS = id => {
  const v = {}; document.querySelectorAll('[data-s]').forEach(i => { v[i.dataset.s] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
  if (!v.name) return alert('現場名を入れてください');
  const patch = { name: v.name, done: v.done, note: v.note, roumuIds: v.roumuIds.split(/[,、\s]+/).filter(Boolean) };
  if (id === 'new') { const sid = 's' + Date.now().toString(36); op({ type: 'siteAdd', s: { id: sid, ...patch } }); ui.site = sid; localStorage.setItem(KEY.site, sid); }
  else op({ type: 'site', id, patch });
  location.hash = '#home';
};
function vEditG(id) {
  if (!isView()) return vInput();
  const isNew = id === 'new', g = isNew ? { name: '', target: null, method: '', note: '', common: true, siteId: curSite() } : S.doc.groups.find(x => x.id === id); if (!g) return vSettings();
  const gs = C.siteOfG(S.doc, g);
  return `<h2>${isNew ? 'グループを追加' : 'グループを直す'}</h2><div class="card">
   ${sites().length ? `<label class="f">現場</label><select data-k="siteId">${sites().map(st => `<option value="${esc(st.id)}" ${st.id === gs ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select>` : ''}
   <label class="f">名前</label><input type="text" data-k="name" value="${esc(g.name)}">
   <label class="chk"><input type="checkbox" data-k="common" ${g.common ? 'checked' : ''}> 共通の目標単価（設定の鳶・土工）を使う</label>
   <label class="f">個別の目標単価（円/人工。共通を使うときは無視）</label><input type="text" inputmode="numeric" data-k="target" value="${g.target ?? ''}">
   <label class="f">算出方法</label><input type="text" data-k="method" value="${esc(g.method || '')}">
   <label class="f">備考</label><input type="text" data-k="note" value="${esc(g.note || '')}">
   <p class="muted small">どの請書を合算するかは、請書の画面の「合算グループ」で選びます。</p>
   <button class="primary wide" data-a="saveG|${esc(id)}">保存</button><button class="wide" data-a="go|settings">やめる</button></div>`;
}
H.saveG = id => {
  const v = {}; document.querySelectorAll('[data-k]').forEach(i => { v[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
  const target = v.target === '' ? null : parseAmount(v.target); if (Number.isNaN(target)) return alert('目標は数字で入れてください'); if (!v.name) return alert('名前を入れてください');
  const patch = { name: v.name, target, method: v.method, note: v.note, common: !!v.common, ...(v.siteId ? { siteId: v.siteId } : {}) };
  if (id === 'new') op({ type: 'groupAdd', g: { id: 'g' + Date.now().toString(36), ...patch } }); else op({ type: 'group', id, patch });
  location.hash = '#settings';
};

// ---------- 体験モード（架空の請書・架空の数字。保存されません）----------
async function startDemo(role, scope) {
  const V = await generateRoleKey(), I = await generateRoleKey();
  const pubs = { view: V.pub, input: I.pub }, be = new MemoryBackend();
  const vstore = new DekidakaStore({ backend: be, role: 'view', priv: await importPriv(V.priv), pubs, scope });
  await vstore.save(demoDoc(), null);
  const istore = new DekidakaStore({ backend: be, role: 'input', priv: await importPriv(I.priv), pubs, scope });
  // 体験：番頭さんからの「請書追加の申請」を1件（架空）
  await istore.addRequest({ req: { name: 'デモ請書（申請・架空）', short: 'デモ鳶F', trade: '鳶', kubun: '追加', amount: 1234567, start: '2026-11-01', end: '2027-03-31', from: '2026-11', to: '2027-03', taisho: true, hasNinku: true, note: '体験用', siteId: 'ds1' }, by: '番頭（体験）', at: '2026-11-01T00:00:00.000Z' });
  const store = role === 'view' ? vstore : istore;
  await open(store, role, scope, true);
}
function demoDoc() {
  const at = '2026-01-01T00:00:00.000Z', by = '体験';
  const K = (id, no, short, trade, amount, group, taisho = true, hasNinku = true, siteId = 'ds1') => ({ id, no, name: `デモ請書${'ABCDEFGH'[no - 1]}（架空）`, short, trade, kubun: '架空', from: '2026-04', to: '2027-03', hasNinku, active: true, amount, start: '2026-04-01', end: '2027-03-31', taisho, group, note: '体験用の架空データ', siteId });
  const keisho = [K('d1', 1, 'デモ鳶A', '鳶', 12345678, 'gd-t'), K('d2', 2, 'デモ鳶B', '鳶', null, 'gd-t'), K('d3', 3, 'デモ鳶C', '鳶', 2222222, null), K('d4', 4, 'デモ土工A', '土工', 9876543, 'gd-d'), K('d5', 5, 'デモ土工B', '土工', 1111111, 'gd-d'), { ...K('d6', 6, 'デモ小口', '土工', null, null, false, false), kubun: '小口', kind: 'kogu', start: null, end: null },
    K('d7', 7, 'デモ鳶D', '鳶', 5555555, 'gd-t2', true, true, 'ds2'), K('d8', 8, 'デモ鳶E', '鳶', 3333333, null, true, true, 'ds3')];
  const records = {}, put = (id, ym, a, n, note) => { records[`${id}|${ym}`] = { amount: { v: a, at, by }, ...(n != null ? { ninku: { v: n, at, by } } : {}), ...(note ? { note: { v: note, at, by } } : {}) }; };
  ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((ym, i) => { put('d1', ym, 1111111 + i * 111111, 22 + i, i === 0 ? '架空' : ''); put('d2', ym, 333333, 11); put('d4', ym, 777777 - i * 11111, 22); if (i % 2) put('d5', ym, 123456, 3); put('d6', ym, 111111, null); if (i > 2) put('d7', ym, 444444, 12 + i); });
  put('d3', '2026-07', 999999, 33); put('d8', '2026-05', 222222, 7);
  const sites = [{ id: 'ds1', name: 'デモ現場A（架空）', roumuIds: [], done: false }, { id: 'ds2', name: 'デモ現場B（架空）', roumuIds: [], done: false }, { id: 'ds3', name: 'デモ現場C（架空・竣工）', roumuIds: [], done: true }];
  return { schema: C.SCHEMA, merged: [], updatedAt: at, updatedBy: by, settings: { cycleDay: 21, cycle: '毎月21日～翌月20日締め（体験）', period: { from: '2026-04', to: '2027-03' }, sites }, keisho,
    groups: [{ id: 'gd-t', name: 'デモ鳶（A＋B）', target: 33333, common: true, siteId: 'ds1' }, { id: 'gd-d', name: 'デモ土工（A＋B）', target: 22222, common: true, siteId: 'ds1' }, { id: 'gd-t2', name: 'デモ鳶D', target: 33333, common: true, siteId: 'ds2' }],
    common: { '鳶': 33333, '土工': 22222 }, requests: [], records, notes: { comment: '体験用のコメント（架空）', meeting: [] } };
}

boot().catch(e => fatal('エラー：' + e.message));
