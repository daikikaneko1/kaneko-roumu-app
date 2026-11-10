import * as L from './logic.js';
import { decryptSecret } from './crypto.js';
import { GitHubStore, MemoryStore, Sync } from './store.js';
import CONFIG from './config.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = { pass: 'roumu.pass', pending: 'roumu.pending', who: 'roumu.who' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
let sync = null, saveTimer = null;
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 日本時間
const ui = { trade: 'doko', fy: null, sumMode: 'month', sumFY: null, sumYm: null, gridFY: null, calYm: null, sel: null, range: false, r1: null, r2: null };

// ---------- 起動 ----------
async function boot() {
  L.setHolidays(await (await fetch('holidays.json')).json());
  const params = new URLSearchParams(location.search);
  if (location.hash.startsWith('#k=')) { // URL の # 以降に合言葉（サーバーには送られない）
    localStorage.setItem(KEY.pass, decodeURIComponent(location.hash.slice(3)));
    history.replaceState(null, '', location.pathname + location.search + '#list');
  }
  if (params.get('demo') === '1') { // 体験モード（ブラウザ内だけ、保存されない）
    const r = await fetch('demo-data.json'); if (!r.ok) return fatal('体験用データがありません');
    return start(new MemoryStore(await r.json()), true);
  }
  if (!CONFIG.encToken) return fatal('まだ準備中です（データの鍵が設定されていません）。管理者に連絡してください。');
  const pass = localStorage.getItem(KEY.pass);
  if (!pass) return loginScreen();
  const token = await decryptSecret(CONFIG.encToken, pass);
  if (!token) { localStorage.removeItem(KEY.pass); return loginScreen('合言葉が違うか、変更されました。もう一度入れてください。'); }
  start(new GitHubStore({ ...CONFIG, token }));
}
function fatal(msg) { $('#main').innerHTML = `<div class="card login"><h2>労務稼働予定</h2><p>${esc(msg)}</p></div>`; }
function loginScreen(err = '') {
  $('#nav').hidden = true;
  $('#main').innerHTML = `<div class="card login"><h2>合言葉を入れてください</h2>
    <p class="muted">一度入れると、このスマホでは次から入れなくて大丈夫です。</p>
    ${err ? `<p style="color:#c62828">${esc(err)}</p>` : ''}
    <input id="pass" type="password" autocomplete="current-password" placeholder="合言葉">
    <button class="primary wide" id="go">開く</button><p id="msg" class="muted"></p></div>`;
  const go = async () => {
    const p = $('#pass').value.trim(); if (!p) return;
    $('#msg').textContent = '確認中…';
    const token = await decryptSecret(CONFIG.encToken, p);
    if (!token) { $('#msg').textContent = '合言葉が違います'; return; }
    localStorage.setItem(KEY.pass, p); start(new GitHubStore({ ...CONFIG, token }));
  };
  $('#go').onclick = go; $('#pass').onkeydown = e => { if (e.key === 'Enter') go(); };
}
async function start(store, demo = false) {
  sync = new Sync(store, L.applyOps, { onChange: () => { showStatus(); }, persist: p => { if (!demo) localStorage.setItem(KEY.pending, JSON.stringify(p)); } });
  sync.demo = demo;
  try { await sync.load(); } catch (e) {
    if (e.auth) return fatal('データの鍵が使えません（期限切れか無効）。管理者に連絡してください。');
    return fatal('読み込みできませんでした。電波の良い所でもう一度開いてください。（' + e.message + '）');
  }
  try { const p = JSON.parse(localStorage.getItem(KEY.pending) || '[]'); if (!demo && p.length) { sync.pending = p; scheduleSave(); } } catch { }
  const s = sync.doc.settings;
  ui.fy = ui.sumFY = ui.gridFY = s.dailyFY;
  ui.calYm = ui.sumYm = L.fyMonths(s.dailyFY).includes(today.slice(0, 7)) ? today.slice(0, 7) : L.fyMonths(s.dailyFY)[0];
  $('#nav').hidden = false;
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(refresh, 60000);
  window.addEventListener('beforeunload', e => { if (sync.pending.length) { e.preventDefault(); e.returnValue = ''; } });
  if (!location.hash || location.hash === '#') location.hash = '#list'; else render();
}
async function refresh() { try { if (await sync.refresh()) { ui.keepScroll = true; render(); } } catch { } }
function showStatus() {
  const el = $('#status'); if (!sync) return; el.className = '';
  if (sync.demo) { el.textContent = '体験モード（保存されません）'; return; }
  if (sync.status === 'error') { el.className = 'err'; el.textContent = '⚠ 保存できていません'; }
  else if (sync.status === 'saving') { el.className = 'pend'; el.textContent = '保存中…'; }
  else if (sync.pending.length) { el.className = 'pend'; el.textContent = `未保存 ${sync.pending.length}件`; }
  else el.textContent = '保存済み ✓';
}
function op(o) { sync.push(o); scheduleSave(); render(); }
function scheduleSave() {
  if (sync.demo) { sync.base = sync.doc; sync.pending = []; showStatus(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { try { const before = sync.merged || 0; await sync.save(localStorage.getItem(KEY.who) || ''); if ((sync.merged || 0) > before) { ui.keepScroll = true; render(); } } catch (e) { if (e.auth) alert('保存できません：データの鍵が無効です。管理者に連絡してください。'); } }, 1200);
}
const D = () => sync.doc;
const site = id => D().sites.find(s => s.id === id);

// ---------- 画面切り替え ----------
function render() {
  if (!sync) return;
  const [r, a, b] = location.hash.slice(1).split('/').map(decodeURIComponent);
  document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('on', x.dataset.nav === ({ site: 'list', edit: 'list', day: 'list' }[r] || r)));
  const f = { list: vList, site: () => vSite(a), edit: () => vEdit(a), day: () => vDay(a, b), grid: vGrid, sum: vSum, cal: vCal, settings: vSettings }[r] || vList;
  const y = window.scrollY; const html = f();
  if (html != null) { $('#main').innerHTML = html; bind(); }
  if (ui.keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  ui.keepScroll = false;
  showStatus();
}
const handlers = {};
function bind() { $('#main').querySelectorAll('[data-a]').forEach(el => { el.onclick = e => { e.stopPropagation(); const [n, ...args] = el.dataset.a.split('|'); ui.keepScroll = true; handlers[n] && handlers[n](...args, el); }; }); }
const tradeTabs = () => `<div class="tabs ${ui.trade}">${Object.entries(L.TRADES).map(([k, v]) => `<button data-a="trade|${k}" class="${ui.trade === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
const fyTabs = (cur, act) => `<div class="tabs">${Array.from({ length: D().settings.years }, (_, i) => D().settings.firstFY + i).map(fy => `<button data-a="${act}|${fy}" class="${cur === fy ? 'on' : ''}">${fy}年度${fy === D().settings.dailyFY ? '<br><small>日別</small>' : ''}</button>`).join('')}</div>`;
handlers.trade = t => { ui.trade = t; render(); };
handlers.go = h => { ui.keepScroll = false; if (location.hash === '#' + h) render(); else location.hash = h; };
const curYm = () => today.slice(0, 7);

// ---------- 現場一覧 ----------
function vList() {
  const doc = D(); const ym = curYm();
  let h = `<h2>現場一覧</h2>${tradeTabs()}`;
  for (const cat of L.CATEGORIES) {
    const list = L.sortedSites(doc, ui.trade).filter(s => s.category === cat);
    h += `<h3>${cat}（${list.length}件）</h3>`;
    for (const s of list) {
      const mi = L.monthInfo(doc, s, ym);
      h += `<div class="card site" data-a="go|site/${s.id}"><span class="kb ${esc(s.kubun)}">${esc(s.kubun || '－')}</span>
        <div><div class="nm">${esc(s.name)}</div><div class="meta">部:${esc(s.bu || '－')}　所長:${esc(s.shocho || '－')}　職長:${esc(s.shokucho || '－')}<br>工期:${esc(s.start || '')}${s.start || s.end ? '～' : '－'}${esc(s.end || '')}${s.months ? `（${s.months}ヶ月）` : ''}</div></div>
        <div class="now">${L.parseYm(ym).m}月<b>${L.fmt1(mi.value) || '0'}</b>人/日</div></div>`;
    }
  }
  h += `<button class="primary wide" data-a="go|edit/new">＋ 現場を追加（${L.TRADES[ui.trade]}）</button>`;
  return h;
}

// ---------- 現場ごとの月別入力 ----------
function vSite(id) {
  const doc = D(), s = site(id); if (!s) return `<p>現場が見つかりません</p><button data-a="go|list">一覧へ</button>`;
  ui.trade = s.trade;
  let h = `<button data-a="go|list">‹ 一覧</button>
    <div class="card"><div class="site"><span class="kb ${esc(s.kubun)}">${esc(s.kubun || '－')}</span><div><div class="nm">${esc(s.name)}</div>
    <div class="meta">${L.TRADES[s.trade]}・${esc(s.category)}　部:${esc(s.bu || '－')}　所長:${esc(s.shocho || '－')}　職長:${esc(s.shokucho || '－')}<br>工期:${esc(s.start || '')}～${esc(s.end || '')}${s.months ? `（${s.months}ヶ月）` : ''}${s.note ? `<br>${esc(s.note)}` : ''}</div></div></div>
    <button class="wide" data-a="go|edit/${s.id}">✏️ 現場の情報を直す</button></div>
    <h3>月別の人数（1日あたり平均）</h3>${fyTabs(ui.fy, 'fy')}`;
  let fyN = 0;
  for (const ym of L.fyMonths(ui.fy)) {
    const mi = L.monthInfo(doc, s, ym); fyN += mi.ninku;
    h += `<div class="row"><div class="lbl">${L.parseYm(ym).m}月</div>
      <div class="info">${mi.daily ? `人工 ${mi.ninku}・稼働 ${mi.wd}日 ${mi.edited ? '<span class="badge">日別で手入力</span>' : ''}<br><a href="#day/${s.id}/${ym}">日別 ›</a>` : `<span class="muted">月の値</span>`}</div>
      <div class="stepper"><button data-a="mstep|${s.id}|${ym}|-1">−</button><div class="val" data-a="medit|${s.id}|${ym}">${L.fmt1(mi.value) || '0'}</div><button data-a="mstep|${s.id}|${ym}|1">＋</button></div></div>`;
  }
  if (ui.fy === doc.settings.dailyFY) h += `<p class="muted">${ui.fy}年度の合計人工：${fyN}人工。この年度は日別が元データです。月の数字を変えると、その月の稼働日に整数で割り振り直します。</p>`;
  return h;
}
handlers.fy = fy => { ui.fy = Number(fy); render(); };
function setMonth(id, ym, v) {
  const doc = D(), s = site(id); v = Math.max(0, L.round2(v));
  if (L.inWindow(doc, ym)) {
    const mi = L.monthInfo(doc, s, ym);
    if (mi.wd === 0 && v > 0) { alert('この月は稼働日がありません（カレンダーを確認してください）'); return; }
    if (mi.edited && !confirm(`${L.parseYm(ym).m}月は日別で手入力されています。\n${L.fmt1(v)}人/日（${Math.round(v * mi.wd)}人工）で上書きしますか？`)) return;
  }
  op({ t: 'month', id, ym, v });
}
handlers.mstep = (id, ym, d) => { const v = L.monthInfo(D(), site(id), ym).value; const nv = Number(d) > 0 ? Math.floor(v + 1e-9) + 1 : Math.ceil(v - 1e-9) - 1; setMonth(id, ym, nv); };
handlers.medit = (id, ym) => { const s = site(id), mi = L.monthInfo(D(), s, ym);
  numberSheet({ title: `${esc(s.name)}<br>${ym.replace('-', '年')}月（人/日）`, value: L.round2(mi.value), step: 1, decimals: true, info: mi.daily ? `稼働 ${mi.wd}日。整数で日に割り振ります。` : '', onOk: v => setMonth(id, ym, v) }); };

// ---------- 現場の追加・編集 ----------
let draft = null;
function vEdit(id) {
  const isNew = id === 'new';
  if (!draft || draft._for !== id) { const s = isNew ? { trade: ui.trade, category: '新築', kubun: '入' } : site(id); if (!s) return '<p>現場が見つかりません</p>'; draft = { ...s, _for: id }; }
  const d = draft, tx = (k, lbl, ph = '') => `<label class="f">${lbl}</label><input type="text" data-k="${k}" value="${esc(d[k] ?? '')}" placeholder="${ph}">`;
  const chips = (k, opts, labels) => `<div class="chips">${opts.map((o, i) => `<button data-a="dset|${k}|${o}" class="${d[k] === o ? 'on' : ''}">${labels ? labels[i] : o}</button>`).join('')}</div>`;
  return `<button data-a="go|${isNew ? 'list' : 'site/' + id}">‹ 戻る</button><h2>${isNew ? '現場を追加' : '現場の情報'}</h2>
   <label class="f">職種</label>${chips('trade', Object.keys(L.TRADES), Object.values(L.TRADES))}
   <label class="f">新築／改修</label>${chips('category', L.CATEGORIES)}
   <label class="f">区分</label>${chips('kubun', L.KUBUN)}
   <p class="muted small">入=入場中 現=施工中 指=指名 計=計画 営=営業中（Excelと同じ記号）</p>
   ${tx('name', '工事名（必須）')}${tx('bu', '部', '例：1、特、RN')}${tx('shocho', '所長')}${tx('shokucho', '職長')}
   <div class="flex"><div>${tx('start', '工期（始）', 'R08.06')}</div><div>${tx('end', '工期（終）', 'R10.12')}</div></div>
   <label class="f">月数</label><input type="number" inputmode="decimal" data-k="months" value="${esc(d.months ?? '')}">
   ${tx('note', 'メモ')}
   <button class="primary wide" data-a="dsave">保存する</button>
   ${isNew ? '' : '<button class="danger wide" data-a="ddel">この現場を削除</button>'}`;
}
function readDraft() { document.querySelectorAll('[data-k]').forEach(i => { draft[i.dataset.k] = i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value.trim(); }); }
handlers.dset = (k, v) => { readDraft(); draft[k] = v; render(); };
handlers.dsave = () => {
  readDraft(); if (!draft.name) { alert('工事名を入れてください'); return; }
  const isNew = draft._for === 'new'; const id = isNew ? L.newId() : draft.id;
  const f = {}; for (const k of ['trade', 'category', 'kubun', 'name', 'bu', 'shocho', 'shokucho', 'start', 'end', 'months', 'note']) f[k] = draft[k] ?? '';
  if (isNew) f.order = Math.max(0, ...D().sites.map(s => s.order ?? 0)) + 1;
  draft = null; sync.push({ t: 'site', site: { id, ...f } }); scheduleSave(); location.hash = `site/${id}`;
};
handlers.ddel = () => { if (!confirm(`「${draft.name}」を削除しますか？\n（月・日の人数も消えます）`)) return; const id = draft.id; draft = null; sync.push({ t: 'delSite', id }); scheduleSave(); location.hash = 'list'; };

// ---------- 日別入力 ----------
function calCells(ym, cell) {
  const dates = L.datesOfMonth(ym); const first = L.dow(dates[0]);
  let h = `<div class="cal">${WD.map((w, i) => `<div class="h ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}`;
  for (let i = 0; i < first; i++) h += '<div class="d empty"></div>';
  for (const d of dates) h += cell(d);
  return h + '</div>';
}
function monthNav(ym, act, months) {
  const i = months.indexOf(ym);
  return `<div class="flex"><button data-a="${act}|${months[i - 1] || ''}" ${i <= 0 ? 'disabled' : ''}>‹ 前の月</button><b class="center" style="font-size:19px">${ym.replace('-', '年')}月</b><button data-a="${act}|${months[i + 1] || ''}" ${i >= months.length - 1 ? 'disabled' : ''}>次の月 ›</button></div>`;
}
function vDay(id, ym) {
  const doc = D(), s = site(id); if (!s) return '<p>現場が見つかりません</p>';
  const months = L.fyMonths(doc.settings.dailyFY);
  if (!months.includes(ym)) ym = months.includes(curYm()) ? curYm() : months[0];
  const arr = (s.daily && s.daily[ym]) || []; const mi = L.monthInfo(doc, s, ym);
  if (ui.dayKey !== id + ym) { ui.dayKey = id + ym; ui.sel = null; ui.r1 = ui.r2 = null; }
  const inR = d => ui.r1 && ui.r2 && d >= (ui.r1 < ui.r2 ? ui.r1 : ui.r2) && d <= (ui.r1 < ui.r2 ? ui.r2 : ui.r1);
  let h = `<button data-a="go|site/${id}">‹ ${esc(s.name)}</button>
   <h2>日別入力 <small class="muted">${L.TRADES[s.trade]}</small></h2>${monthNav(ym, 'dmon|' + id, months)}
   <p>この月：<b>${mi.ninku}</b>人工 ／ 稼働 <b>${mi.wd}</b>日 ／ 平均 <b>${L.fmt1(mi.value) || '0'}</b>人/日 ${mi.edited ? '<span class="badge">手入力あり</span>' : ''}</p>
   <div class="tabs"><button data-a="rmode|0" class="${!ui.range ? 'on' : ''}">1日ずつ</button><button data-a="rmode|1" class="${ui.range ? 'on' : ''}">期間でまとめて</button></div>`;
  h += calCells(ym, d => {
    const sd = L.siteDay(doc, s, d), v = arr[Number(d.slice(8)) - 1] || 0;
    const cls = ['d', sd.work ? '' : 'off', ui.sel === d ? 'sel' : '', inR(d) ? 'inr' : '', sd.override ? 'ovr' : ''].join(' ');
    return `<div class="${cls}" data-a="dtap|${d}"><span class="n">${Number(d.slice(8))}</span><span class="v">${v || (sd.work ? '' : '')}</span><span class="r">${sd.work ? '' : esc(sd.reason)}</span></div>`;
  });
  if (!ui.range && ui.sel) {
    const sd = L.siteDay(doc, s, ui.sel), v = arr[Number(ui.sel.slice(8)) - 1] || 0;
    h += `<div class="panel"><div class="center"><b>${Number(ui.sel.slice(5, 7))}月${Number(ui.sel.slice(8))}日（${WD[L.dow(ui.sel)]}）</b> ${sd.work ? '' : `<span class="muted">休み：${esc(sd.reason)}</span>`}</div>
      <div class="big flex" style="justify-content:center"><button data-a="dstep|${id}|-1" style="flex:none;width:72px;height:60px;font-size:28px">−</button><b style="flex:none;font-size:32px;min-width:60px;text-align:center">${v}</b><button data-a="dstep|${id}|1" style="flex:none;width:72px;height:60px;font-size:28px">＋</button><span style="flex:none">人</span></div>
      <button class="wide" data-a="doff|${id}">${sd.work ? 'この日はこの現場を休みにする' : 'この日はこの現場を出勤にする'}</button>
      ${sd.override ? `<button class="wide" data-a="dreset|${id}">会社カレンダーどおりに戻す</button>` : ''}</div>`;
  } else if (ui.range) {
    const a = ui.r1 && ui.r2 ? [ui.r1, ui.r2].sort() : null;
    const wds = a ? L.datesOfMonth(ym).filter(d => d >= a[0] && d <= a[1] && L.siteDay(doc, s, d).work) : [];
    h += `<div class="panel">${!ui.r1 ? '始まりの日をタップ' : !ui.r2 ? '終わりの日をタップ' : `<b>${Number(a[0].slice(8))}日～${Number(a[1].slice(8))}日</b>（稼働日 ${wds.length}日）
      <div class="big flex" style="justify-content:center"><button data-a="rstep|-1" style="flex:none;width:64px">−</button><input id="rv" type="number" inputmode="numeric" value="${ui.rv ?? 3}" style="flex:none;width:90px;text-align:center;font-size:24px"><button data-a="rstep|1" style="flex:none;width:64px">＋</button><span style="flex:none">人</span></div>
      <button class="primary wide" data-a="rfill|${id}">この期間を <span id="rvl">${ui.rv ?? 3}</span>人にする</button><button class="wide" data-a="rclear">選び直す</button>`}</div>`;
  } else h += '<p class="muted center">日にちをタップすると人数を変えられます</p>';
  return h;
}
handlers.dmon = (id, ym) => { if (ym) { ui.sel = null; location.hash = `day/${id}/${ym}`; } };
handlers.rmode = v => { ui.range = v === '1'; ui.r1 = ui.r2 = ui.sel = null; render(); };
handlers.dtap = d => { if (ui.range) { if (!ui.r1 || ui.r2) { ui.r1 = d; ui.r2 = null; } else ui.r2 = d; } else ui.sel = d; render(); };
const dayVal = (s, d) => ((s.daily && s.daily[d.slice(0, 7)]) || [])[Number(d.slice(8)) - 1] || 0;
handlers.dstep = (id, k) => { const s = site(id); const v = Math.max(0, dayVal(s, ui.sel) + Number(k)); op({ t: 'day', id, date: ui.sel, v }); };
handlers.doff = id => { const s = site(id); const sd = L.siteDay(D(), s, ui.sel); const comp = L.companyDay(D(), ui.sel).work;
  const want = sd.work ? 'off' : 'work'; op({ t: 'siteDay', id, date: ui.sel, mode: (want === 'work') === comp ? null : want }); };
handlers.dreset = id => op({ t: 'siteDay', id, date: ui.sel, mode: null });
handlers.rstep = k => { const i = $('#rv'); ui.rv = Math.max(0, (Number(i.value) || 0) + Number(k)); i.value = ui.rv; $('#rvl').textContent = ui.rv; };
handlers.rclear = () => { ui.r1 = ui.r2 = null; render(); };
handlers.rfill = id => { const v = Math.max(0, Math.round(Number($('#rv').value) || 0)); ui.rv = v; const doc = D(), s = site(id); const [a, b] = [ui.r1, ui.r2].sort();
  const dates = L.datesOfMonth(a.slice(0, 7)).filter(d => d >= a && d <= b && L.siteDay(doc, s, d).work);
  if (!dates.length) { alert('期間に稼働日がありません'); return; } op({ t: 'days', id, dates, v }); ui.r1 = ui.r2 = null; render(); };

// ---------- 5カ年 ----------
function vGrid() {
  const doc = D(), months = L.fyMonths(ui.gridFY), daily = ui.gridFY === doc.settings.dailyFY;
  const sites = L.sortedSites(doc, ui.trade); const tots = months.map(ym => L.monthTotals(doc, ym)[ui.trade]);
  let h = `<h2>5カ年山積表 <small class="muted">人/日</small></h2>${tradeTabs()}${fyTabs(ui.gridFY, 'gfy')}
   <p class="muted small">${daily ? '青い列は日別データから計算した月平均です（数字をタップで変更→日に割り振り）。' : 'マスをタップすると数字を変えられます。'}</p>
   <div class="grid-wrap"><table class="grid"><thead><tr><th class="nm">工事名</th>${months.map(ym => `<th>${L.parseYm(ym).m}月</th>`).join('')}</tr></thead><tbody>`;
  for (const cat of L.CATEGORIES) {
    for (const s of sites.filter(x => x.category === cat)) {
      h += `<tr><td class="nm" data-a="go|site/${s.id}"><span class="kb ${esc(s.kubun)}" style="min-width:24px;height:24px;font-size:12px">${esc(s.kubun || '－')}</span> ${esc(s.name)}</td>`;
      for (const ym of months) { const mi = L.monthInfo(doc, s, ym); h += `<td class="c ${mi.daily ? 'd' : ''} ${mi.edited ? 'e' : ''}" data-a="medit|${s.id}|${ym}">${L.fmt1(mi.value)}</td>`; }
      h += '</tr>';
    }
    h += `<tr class="tot"><td class="nm">${cat}${L.TRADES[ui.trade]}計</td>${tots.map(t => `<td>${L.fmt1(t[cat]) || '0'}</td>`).join('')}</tr>`;
  }
  const mode = doc.settings.estimateMode === 'fixed' ? '×22日' : 'カレンダー';
  h += `<tr class="tot"><td class="nm">${L.TRADES[ui.trade]}合計</td>${tots.map(t => `<td>${L.fmt1(t.合計) || '0'}</td>`).join('')}</tr>
    <tr class="tot"><td class="nm">月間稼働予測（${mode}）</td>${tots.map(t => `<td>${Math.round(t.est)}</td>`).join('')}</tr>
    <tr class="tot neg"><td class="nm">余力（目標${tots[0].target}人−合計）</td>${tots.map(t => `<td class="v">${L.fmt1(t.target - t.合計) || '0'}</td>`).join('')}</tr>
    </tbody></table></div><p class="muted small">黄色＝日別で手入力した月。余力がマイナス（赤）は人が足りない月。</p>`;
  return h;
}
handlers.gfy = fy => { ui.gridFY = Number(fy); render(); };

// ---------- 集計 ----------
function barChart(labels, series, { target, unit = '', w = Math.max(340, Math.min(860, document.documentElement.clientWidth - 24)) } = {}) {
  const H = 240, pl = 40, pr = 8, pt = 18, pb = 28, n = labels.length;
  const max = Math.max(1, target || 0, ...series.flatMap(s => s.values)) * 1.12;
  const bw = (w - pl - pr) / n, gw = bw * 0.8 / series.length;
  let g = `<svg class="chart" viewBox="0 0 ${w} ${H}" role="img">`;
  const step = Math.pow(10, Math.floor(Math.log10(max))) / (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 0.5 : max / Math.pow(10, Math.floor(Math.log10(max))) > 2 ? 1 : 2);
  for (let v = 0; v <= max; v += step) { const y = pt + (H - pt - pb) * (1 - v / max); g += `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}" stroke="#e3e7ee"/><text x="${pl - 4}" y="${y + 4}" font-size="11" text-anchor="end" fill="#777">${Math.round(v * 10) / 10}</text>`; }
  labels.forEach((lb, i) => {
    series.forEach((s, k) => { const v = s.values[i] || 0, hh = (H - pt - pb) * v / max, x = pl + i * bw + bw * 0.1 + k * gw, y = H - pb - hh;
      g += `<rect x="${x}" y="${y}" width="${gw - 1}" height="${hh}" fill="${s.color}"/>`; if (v && n <= 13) g += `<text x="${x + gw / 2}" y="${y - 3}" font-size="11" text-anchor="middle">${Math.round(v * 10) / 10}</text>`; });
    if (n <= 13 || i % 2 === 0) g += `<text x="${pl + i * bw + bw / 2}" y="${H - 10}" font-size="11" text-anchor="middle" fill="#444">${lb}</text>`;
  });
  if (target) { const y = pt + (H - pt - pb) * (1 - target / max); g += `<line x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}" stroke="#333" stroke-dasharray="6 4"/><text x="${w - pr}" y="${y - 4}" font-size="11" text-anchor="end">目標${target}${unit}</text>`; }
  return g + '</svg>';
}
function vSum() {
  const doc = D(); const s = doc.settings;
  let h = `<h2>集計</h2><div class="tabs"><button data-a="smode|month" class="${ui.sumMode === 'month' ? 'on' : ''}">月ごと</button><button data-a="smode|day" class="${ui.sumMode === 'day' ? 'on' : ''}">日ごと（${s.dailyFY}年度）</button></div>`;
  if (ui.sumMode === 'month') {
    const months = L.fyMonths(ui.sumFY), tots = months.map(ym => L.monthTotals(doc, ym));
    h += fyTabs(ui.sumFY, 'sfy') + `<div class="tabs"><button data-a="est|calendar" class="${s.estimateMode !== 'fixed' ? 'on' : ''}">稼働予測：カレンダー</button><button data-a="est|fixed" class="${s.estimateMode === 'fixed' ? 'on' : ''}">稼働予測：×22日（Excel方式）</button></div>`;
    for (const t of Object.keys(L.TRADES)) {
      h += `<h3>${L.TRADES[t]}（人/日）</h3>` + barChart(months.map(L.monthLabel), [{ values: tots.map(x => x[t].合計), color: `var(--${t})` }], { target: tots[0][t].target, unit: '人' });
    }
    const row = (lb, f) => `<tr><td class="nm">${lb}</td>${tots.map(x => `<td>${f(x)}</td>`).join('')}</tr>`;
    h += `<div class="grid-wrap" style="margin-top:10px"><table class="grid"><thead><tr><th class="nm">項目</th>${months.map(ym => `<th>${L.monthLabel(ym)}</th>`).join('')}</tr></thead><tbody>
      ${row('新築土工計', x => L.fmt1(x.doko.新築) || 0)}${row('改修土工計', x => L.fmt1(x.doko.改修) || 0)}<tr class="tot">${row('土工合計', x => L.fmt1(x.doko.合計) || 0).slice(4)}
      ${row('土工 月間稼働予測', x => Math.round(x.doko.est))}
      ${row('新築鳶工計', x => L.fmt1(x.tobi.新築) || 0)}${row('改修鳶工計', x => L.fmt1(x.tobi.改修) || 0)}<tr class="tot">${row('鳶工合計', x => L.fmt1(x.tobi.合計) || 0).slice(4)}
      ${row('鳶工 月間稼働予測', x => Math.round(x.tobi.est))}
      ${row('（比較）×22日 土工', x => Math.round(x.doko.estFixed))}${row('（比較）カレンダー 土工', x => Math.round(x.doko.estCalendar))}
      ${row('（比較）×22日 鳶工', x => Math.round(x.tobi.estFixed))}${row('（比較）カレンダー 鳶工', x => Math.round(x.tobi.estCalendar))}
      ${row('会社の稼働日数', x => x.companyWd)}${row('×22方式の日数', x => x.fixedDays)}
      </tbody></table></div><p class="muted small">月間稼働予測：カレンダー＝日別の人工（日別でない年度は 平均×会社の稼働日）。×22日＝Excelと同じく 合計×22（カレンダー画面で月ごとの日数を変更可）。</p>`;
  } else {
    const months = L.fyMonths(s.dailyFY); if (!months.includes(ui.sumYm)) ui.sumYm = months[0];
    const dates = L.datesOfMonth(ui.sumYm), dt = dates.map(d => L.dayTotals(doc, d));
    h += monthNav(ui.sumYm, 'symon', months);
    for (const t of Object.keys(L.TRADES)) h += `<h3>${L.TRADES[t]}（人）</h3>` + barChart(dates.map(d => Number(d.slice(8))), [{ values: dt.map(x => x[t]), color: `var(--${t})` }], { target: s.targets?.[t], unit: '人' });
    h += `<div class="grid-wrap" style="margin-top:10px"><table class="grid"><thead><tr><th class="nm">日</th><th>土工</th><th>鳶工</th><th>合計</th></tr></thead><tbody>
      ${dates.map((d, i) => { const cd = L.companyDay(doc, d); return `<tr><td class="nm">${Number(d.slice(8))}日（${WD[L.dow(d)]}）${cd.work ? '' : `<small style="color:#c62828"> ${esc(cd.reason)}</small>`}</td><td>${dt[i].doko || ''}</td><td>${dt[i].tobi || ''}</td><td>${dt[i].doko + dt[i].tobi || ''}</td></tr>`; }).join('')}
      <tr class="tot"><td class="nm">人工合計</td><td>${dt.reduce((a, x) => a + x.doko, 0)}</td><td>${dt.reduce((a, x) => a + x.tobi, 0)}</td><td>${dt.reduce((a, x) => a + x.doko + x.tobi, 0)}</td></tr></tbody></table></div>`;
  }
  h += `<h3>事務所用（Excelで開けます）</h3><button class="wide" data-a="csv|month">⬇ 5カ年 月別CSV</button><button class="wide" data-a="csv|day">⬇ ${s.dailyFY}年度 日別CSV</button>`;
  return h;
}
handlers.smode = m => { ui.sumMode = m; render(); };
handlers.sfy = fy => { ui.sumFY = Number(fy); render(); };
handlers.symon = ym => { if (ym) { ui.sumYm = ym; render(); } };
handlers.est = m => op({ t: 'settings', patch: { estimateMode: m } });
handlers.csv = kind => {
  const doc = D(); const text = kind === 'month' ? L.monthlyCsv(doc) : L.dailyCsv(doc);
  const name = kind === 'month' ? `労務稼働予定_5カ年_${today}.csv` : `労務稼働予定_${doc.settings.dailyFY}年度_日別_${today}.csv`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

// ---------- 会社カレンダー ----------
function vCal() {
  const doc = D(), s = doc.settings; const all = L.allMonths(doc); if (!all.includes(ui.calYm)) ui.calYm = all[0];
  let h = `<h2>会社カレンダー</h2><p class="muted small">日曜・祝日・会社の休み（年末年始・GW・お盆など）が休み。日にちをタップで「休み⇔稼働」を切り替え。</p>
   ${monthNav(ui.calYm, 'cmon', all)}<p>この月の稼働日：<b id="calwd">${L.workingDays(doc, null, ui.calYm)}</b>日</p>`;
  h += calCells(ui.calYm, d => { const c = L.companyDay(doc, d); return `<div class="d ${c.work ? '' : 'off'} ${doc.calendar.workdays?.[d] || doc.calendar.closures?.[d] ? 'ovr' : ''}" data-a="ctap|${d}"><span class="n">${Number(d.slice(8))}</span><span class="v" style="font-size:14px">${c.work ? '稼働' : '休'}</span><span class="r">${esc(c.reason && !c.work ? c.reason : c.reason)}</span></div>`; });
  h += `<div class="legend"><span><i style="background:var(--off)"></i>休み</span><span><i style="border:2px dashed #e69500"></i>会社で変更した日</span></div>
   <h3>土曜日</h3><div class="chips">${Object.entries(L.SAT_MODES).map(([k, v]) => `<button data-a="sat|${k}" class="${(s.saturday || 'none') === k ? 'on' : ''}" style="flex:1 1 100%">${v}</button>`).join('')}</div>
   <h3>月ごとの稼働日数</h3>${fyTabs(ui.sumFY, 'sfy')}
   <div class="grid-wrap"><table class="grid"><thead><tr><th class="nm">項目</th>${L.fyMonths(ui.sumFY).map(ym => `<th>${L.monthLabel(ym)}</th>`).join('')}</tr></thead><tbody>
   <tr><td class="nm">カレンダーの稼働日</td>${L.fyMonths(ui.sumFY).map(ym => `<td>${L.workingDays(doc, null, ym)}</td>`).join('')}</tr>
   <tr><td class="nm">×22方式の日数（タップで変更）</td>${L.fyMonths(ui.sumFY).map(ym => { const m = L.parseYm(ym).m; return `<td class="c" data-a="fixd|${m}">${s.fixedDays?.[m] ?? 22}</td>`; }).join('')}</tr></tbody></table></div>
   <p class="muted small">Excelの入力方法メモ：月4閉所＝22日、年末年始(12月・1月)＝22、GW＝22、お盆＝20。Excelの計算式は全部の月で×22です。</p>
   <h3>日別で管理する年度（1カ年）</h3><p>今は <b>${s.dailyFY}年度</b>（${s.dailyFY}年4月～${s.dailyFY + 1}年3月）が日別です。</p>
   ${s.dailyFY + 1 < s.firstFY + s.years ? `<button class="wide" data-a="roll|${s.dailyFY + 1}">${s.dailyFY + 1}年度に進める</button>` : ''}
   <p class="muted small">進めると、${s.dailyFY}年度は月平均の数字で固定され、${s.dailyFY + 1}年度の月の数字が日に割り振られます。</p>
   <h3>目標人数（余力の計算用）</h3><div class="flex"><button data-a="tgt|doko">土工 ${s.targets?.doko ?? 0}人</button><button data-a="tgt|tobi">鳶工 ${s.targets?.tobi ?? 0}人</button></div>
   <p class="muted small">祝日：内閣府「国民の祝日」CSV（2026・2027年）。2028年以降は法律の決まりで計算した見込み（官報で確定）。</p>`;
  return h;
}
handlers.cmon = ym => { if (ym) { ui.calYm = ym; render(); } };
handlers.ctap = d => {
  const doc = D(), c = L.companyDay(doc, d);
  if (doc.calendar.workdays?.[d]) return op({ t: 'companyWork', date: d, on: false });
  if (doc.calendar.closures?.[d]) { if (confirm(`${d}「${doc.calendar.closures[d]}」の休みを取り消して稼働日にしますか？`)) op({ t: 'closure', date: d, name: null }); return; }
  if (c.work) { const n = prompt(`${d} を会社の休みにします。名前（例：年末年始、GW、お盆）`, '会社休日'); if (n !== null) op({ t: 'closure', date: d, name: n.trim() || '会社休日' }); }
  else if (confirm(`${d}（${c.reason}）を出勤日にしますか？`)) op({ t: 'companyWork', date: d, on: true });
};
handlers.sat = m => op({ t: 'settings', patch: { saturday: m } });
handlers.fixd = m => numberSheet({ title: `${m}月の×22方式の日数`, value: D().settings.fixedDays?.[m] ?? 22, step: 1, onOk: v => op({ t: 'settings', patch: { fixedDays: { ...D().settings.fixedDays, [m]: Math.round(v) } } }) });
handlers.tgt = t => numberSheet({ title: `${L.TRADES[t]}の目標人数`, value: D().settings.targets?.[t] ?? 0, step: 1, onOk: v => op({ t: 'settings', patch: { targets: { ...D().settings.targets, [t]: Math.round(v) } } }) });
handlers.roll = fy => { if (confirm(`日別の年度を ${fy}年度に進めますか？\n（${fy - 1}年度は月平均で固定されます）`)) op({ t: 'roll', fy: Number(fy) }); };

// ---------- 設定 ----------
function vSettings() {
  const doc = D();
  return `<h2>設定</h2><div class="card"><label class="f">あなたの名前（保存の記録に残ります）</label><input type="text" id="who" value="${esc(localStorage.getItem(KEY.who) || '')}"><button class="wide" data-a="who">名前を保存</button></div>
   <div class="card"><p>最終更新：${esc(doc.updatedAt ? new Date(doc.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '－')} ${esc(doc.updatedBy || '')}</p>
   <button class="wide" data-a="reload">最新を読み込む</button><button class="wide" data-a="savenow">今すぐ保存</button></div>
   <div class="card"><button class="wide" data-a="csv|month">⬇ 5カ年 月別CSV</button><button class="wide" data-a="csv|day">⬇ 日別CSV</button></div>
   <div class="card"><p class="muted small">このスマホに覚えた合言葉を消します（共用スマホ・機種変更のとき）。</p><button class="danger wide" data-a="lock">合言葉を忘れる</button></div>
   <p class="muted small">データ元：${esc(doc.source || '')}</p>`;
}
handlers.who = () => { localStorage.setItem(KEY.who, $('#who').value.trim()); alert('保存しました'); };
handlers.reload = async () => { if (sync.pending.length) await sync.save(localStorage.getItem(KEY.who) || '').catch(() => {}); await sync.load().catch(e => alert(e.message)); render(); };
handlers.savenow = () => sync.save(localStorage.getItem(KEY.who) || '').then(render).catch(e => alert(e.message));
handlers.lock = () => { if (!confirm('合言葉を消しますか？次に開くとき入れ直しが必要です。')) return; localStorage.removeItem(KEY.pass); location.reload(); };

// ---------- 数字入力シート ----------
function numberSheet({ title, value, step = 1, decimals = false, info = '', onOk }) {
  const el = $('#sheet'); el.hidden = false;
  el.innerHTML = `<div class="box"><div class="center"><b>${title}</b></div><div class="big"><button id="nsm">−</button><input id="nsv" type="number" inputmode="${decimals ? 'decimal' : 'numeric'}" step="${decimals ? '0.1' : '1'}" value="${value}"><button id="nsp">＋</button></div>
    ${info ? `<p class="muted center small">${info}</p>` : ''}<div class="flex"><button id="nsc">やめる</button><button class="primary" id="nso">決定</button></div></div>`;
  const inp = $('#nsv'); const close = () => { el.hidden = true; el.innerHTML = ''; };
  $('#nsm').onclick = () => { inp.value = L.round2(Math.max(0, (Number(inp.value) || 0) - step)); };
  $('#nsp').onclick = () => { inp.value = L.round2((Number(inp.value) || 0) + step); };
  $('#nsc').onclick = close; el.onclick = e => { if (e.target === el) close(); };
  $('#nso').onclick = () => { const v = Number(inp.value); close(); if (!isNaN(v)) { ui.keepScroll = true; onOk(v); } };
}

boot().catch(e => fatal('エラー：' + e.message));
