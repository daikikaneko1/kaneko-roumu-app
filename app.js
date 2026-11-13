import * as L from './logic.js';
import { decryptSecret } from './crypto.js';
import { GitHubStore, GitHubVersions, MemoryStore, MemoryVersions, Sync } from './store.js';
import * as V from './versions.js';
import { overlaySvg, totalsSvg, legendHtml, TRADE_COLORS } from './ver-charts.js';
import CONFIG from './config.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = { pass: 'roumu.pass', pending: 'roumu.pending', who: 'roumu.who', showDone: 'roumu.showDone', groups: 'roumu.sumGroups', period: 'roumu.sumPeriod', pstart: 'roumu.sumStart', verOk: 'roumu.versionChecked', verTrade: 'roumu.verTrade' };
const OPT = () => ({ includeDone: localStorage.getItem(KEY.showDone) === '1' });
const WD = ['日', '月', '火', '水', '木', '金', '土'];
let sync = null, saveTimer = null;
const ui = { trade: 'doko', fy: null, sumMode: 'month', sumFY: null, sumYm: null, gridFY: null, calYm: null, sel: null, range: false, multi: false, ms: [], mFrom: null, mTo: null, r1: null, r2: null };

// ---------- 起動 ----------
async function boot() {
  L.setHolidays(await (await fetch('holidays.json')).json());
  const params = new URLSearchParams(location.search);
  const td = params.get('today');
  if (td && /^\d{4}-\d{2}-\d{2}$/.test(td)) L.setToday(td);
  if (location.hash.startsWith('#k=')) { // URL の # 以降に合言葉（サーバーには送られない）
    localStorage.setItem(KEY.pass, decodeURIComponent(location.hash.slice(3)));
    history.replaceState(null, '', location.pathname + location.search + '#list');
  }
  if (params.get('demo') === '1') { // 体験モード（ブラウザ内だけ、保存されない）
    const r = await fetch('demo-data.json'); if (!r.ok) return fatal('体験用データがありません');
    const demoDoc = await r.json(); vs.src = new MemoryVersions(V.demoVersions(demoDoc, L.todayYm()));
    return start(new MemoryStore(demoDoc), true);
  }
  if (!CONFIG.encToken) return fatal('まだ準備中です（データの鍵が設定されていません）。管理者に連絡してください。');
  const pass = localStorage.getItem(KEY.pass);
  if (!pass) return loginScreen();
  const token = await decryptSecret(CONFIG.encToken, pass);
  if (!token) { localStorage.removeItem(KEY.pass); return loginScreen('合言葉が違うか、変更されました。もう一度入れてください。'); }
  vs.src = new GitHubVersions({ ...CONFIG, token });
  start(new GitHubStore({ ...CONFIG, token }));
}
function fatal(msg) { $('#main').innerHTML = `<div class="card login"><h2>労務稼働予定</h2><p>${esc(msg)}</p></div>`; }
function loginScreen(err = '') {
  $('#nav').hidden = true;
  $('#main').innerHTML = `<div class="card login"><h2>合言葉を入れてください</h2>
    <p class="muted">一度入れると、この端末では次から入れなくて大丈夫です。</p>
    ${err ? `<p style="color:#c62828">${esc(err)}</p>` : ''}
    <input id="pass" type="password" autocomplete="current-password" placeholder="合言葉">
    <button class="primary wide" id="go">開く</button><p id="msg" class="muted"></p></div>`;
  const go = async () => {
    const p = $('#pass').value.trim(); if (!p) return;
    $('#msg').textContent = '確認中…';
    const token = await decryptSecret(CONFIG.encToken, p);
    if (!token) { $('#msg').textContent = '合言葉が違います'; return; }
    localStorage.setItem(KEY.pass, p); vs.src = new GitHubVersions({ ...CONFIG, token }); start(new GitHubStore({ ...CONFIG, token }));
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
  autoVersion(structuredClone(sync.base), sync.sha); // 今月の版が無ければ、読み込んだまま（直す前）のデータで作る
  try { const p = JSON.parse(localStorage.getItem(KEY.pending) || '[]'); if (!demo && p.length) { sync.pending = p; scheduleSave(); } } catch { }
  const s = sync.doc.settings;
  const ym0 = L.todayYm(), all0 = L.allMonths(sync.doc), dm0 = L.dailyMonths(sync.doc);
  ui.fy = ui.sumFY = ui.gridFY = L.fyOf(all0.includes(ym0) ? ym0 : (s.dailyFY || s.firstFY));
  ui.calYm = all0.includes(ym0) ? ym0 : all0[0];
  ui.sumYm = dm0.includes(ym0) ? ym0 : (dm0[0] || all0[0]);
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
  const f = { list: vList, site: () => vSite(a), edit: () => vEdit(a), day: () => vDay(a, b), grid: vGrid, sum: vSum, ver: vVer, cal: vCal, settings: vSettings }[r] || vList;
  const y = window.scrollY; const html = f();
  if (html != null) { $('#main').innerHTML = html; bind(); }
  if (ui.keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  ui.keepScroll = false;
  showStatus();
}
const handlers = {};
function bind() { ['#mfrom', '#mto'].forEach(k => { const el = $(k); if (el) el.onchange = () => { keepMv(); readPeriod(); ui.keepScroll = true; render(); }; });
  $('#main').querySelectorAll('[data-ch]').forEach(el => { el.onchange = () => { ui.keepScroll = true; handlers[el.dataset.ch] && handlers[el.dataset.ch](el.value); }; });
  $('#main').querySelectorAll('[data-a]').forEach(el => { el.onclick = e => { e.stopPropagation(); const [n, ...args] = el.dataset.a.split('|'); ui.keepScroll = true; handlers[n] && handlers[n](...args, el); }; });
  const enter = (sel, fn) => { const el = $(sel); if (el) el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }; };
  enter('#who', () => handlers.who());
  enter('#rv', () => { const b = document.querySelector('[data-a^="rfill|"]'); if (b) b.click(); });
  enter('#mv', () => { const b = document.querySelector('[data-a^="mfill|"]'); if (b) b.click(); });
}
const tradeTabs = () => `<div class="tabs ${ui.trade}">${Object.entries(L.TRADES).map(([k, v]) => `<button data-a="trade|${k}" class="${ui.trade === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
const fyTabs = (cur, act) => `<div class="tabs">${Array.from({ length: D().settings.years }, (_, i) => D().settings.firstFY + i).map(fy => `<button data-a="${act}|${fy}" class="${cur === fy ? 'on' : ''}">${fy}年度${L.fyHasDaily(D(), fy) ? '<br><small>日別</small>' : ''}</button>`).join('')}</div>`;
handlers.trade = t => { ui.trade = t; render(); };
// 「竣工も表示」切替（このスマホに記憶）。竣工＝区分が「竣」の現場だけ（工期では判断しない）
function doneToggle(trade) {
  const on = OPT().includeDone, n = D().sites.filter(s => L.isDone(s) && (!trade || s.trade === trade)).length;
  return `<button class="wide toggle ${on ? 'on' : ''}" data-a="showdone" aria-pressed="${on}">${on ? '☑' : '☐'} 竣工も表示 <small>${on ? `（竣工${n}件を表示・合計に含む）` : `（竣工${n}件を非表示中）`}</small></button>`;
}
handlers.showdone = () => { localStorage.setItem(KEY.showDone, OPT().includeDone ? '0' : '1'); render(); };
const doneBadge = s => (L.isDone(s) ? ' <span class="badge done">竣工</span>' : '');
const divBadge = s => ` <span class="badge div d${L.divisionOf(s)}">${L.divisionOf(s) === '2' ? '二部' : '一部'}</span>`;
handlers.doneSet = id => { const s = site(id); if (!s || !confirm(`「${s.name}」を竣工にしますか？\n（一覧・集計から隠れます。人数のデータは消えません）`)) return; draft = null; op(L.doneOp(s)); };
handlers.doneUnset = id => { const s = site(id); if (!s) return; const back = s.prevKubun && s.prevKubun !== L.DONE ? s.prevKubun : '現';
  if (!confirm(`「${s.name}」の竣工を解除して、区分を「${back}」に戻しますか？`)) return; draft = null; op(L.undoneOp(s)); };
handlers.go = h => { ui.keepScroll = false; if (location.hash === '#' + h) render(); else location.hash = h; };
const curYm = () => L.todayYm();
const today = () => L.todayStr();
const ymJP = ym => { const { y, m } = L.parseYm(ym); return `${y}年${m}月`; };

// ---------- 現場一覧 ----------
function vList() {
  const doc = D(); const ym = curYm();
  let h = `<h2>現場一覧</h2>${tradeTabs()}${doneToggle(ui.trade)}<p class="muted small sort-note">並び：開始が早い順（工期（始）。空なら人数が入った最初の月。どちらも無い現場は最後）</p>`;
  for (const cat of L.CATEGORIES) {
    const list = L.sortedSites(doc, ui.trade, OPT()).filter(s => s.category === cat);
    h += `<h3>${cat}（${list.length}件）</h3><div class="sitelist">`;
    for (const s of list) {
      const mi = L.monthInfo(doc, s, ym);
      h += `<div class="card site" data-a="go|site/${s.id}"><span class="kb ${esc(s.kubun)}">${esc(s.kubun || '－')}</span>
        <div><div class="nm">${esc(s.name)}${divBadge(s)}${doneBadge(s)}</div><div class="meta">部:${esc(s.bu || '－')}　所長:${esc(s.shocho || '－')}　職長:${esc(s.shokucho || '－')}${s.kessai ? `　決裁者:${esc(s.kessai)}` : ''}<br>工期:${esc(s.start || '')}${s.start || s.end ? '～' : '－'}${esc(s.end || '')}${s.months ? `（${s.months}ヶ月）` : ''}</div></div>
        <div class="now">${L.parseYm(ym).m}月<b>${L.fmt1(mi.value) || '0'}</b>人/日</div></div>`;
    }
    h += '</div>';
  }
  h += `<button class="primary wide" data-a="go|edit/new">＋ 現場を追加（${L.TRADES[ui.trade]}）</button>`;
  return h;
}

// ---------- 現場ごとの月別入力 ----------
function vSite(id) {
  const doc = D(), s = site(id); if (!s) return `<p>現場が見つかりません</p><button data-a="go|list">一覧へ</button>`;
  ui.trade = s.trade;
  let h = `<button data-a="go|list">‹ 一覧</button>
    <div class="card"><div class="site"><span class="kb ${esc(s.kubun)}">${esc(s.kubun || '－')}</span><div><div class="nm">${esc(s.name)}${divBadge(s)}${doneBadge(s)}</div>
    <div class="meta">${L.TRADES[s.trade]}・${esc(s.category)}・${L.DIVISIONS[L.divisionOf(s)]}　部:${esc(s.bu || '－')}　所長:${esc(s.shocho || '－')}　職長:${esc(s.shokucho || '－')}　決裁者:${esc(s.kessai || '－')}<br>工期:${esc(s.start || '')}～${esc(s.end || '')}${s.months ? `（${s.months}ヶ月）` : ''}${s.note ? `<br>${esc(s.note)}` : ''}</div></div></div>
    <button class="wide" data-a="go|edit/${s.id}">✏️ 現場の情報を直す</button>
    ${L.isDone(s) ? `<p class="muted small">この現場は竣工です（一覧・集計では「竣工も表示」をオンにしたときだけ出ます）。</p><button class="wide" data-a="doneUnset|${s.id}">↩ 竣工を解除</button>` : `<button class="wide" data-a="doneSet|${s.id}">🏁 竣工にする</button>`}</div>
    <h3>月別の人数（1日あたり平均）</h3>${fyTabs(ui.fy, 'fy')}<div class="monthrows">`;
  let fyN = 0;
  for (const ym of L.fyMonths(ui.fy)) {
    const mi = L.monthInfo(doc, s, ym); fyN += mi.ninku;
    h += `<div class="row"><div class="lbl">${L.parseYm(ym).m}月</div>
      <div class="info">${mi.daily ? `人工 ${mi.ninku}・稼働 ${mi.wd}日 ${mi.edited ? '<span class="badge">日別で手入力</span>' : ''}<br><a href="#day/${s.id}/${ym}">日別 ›</a>` : `<span class="muted">月の値</span>`}</div>
      <div class="stepper"><button data-a="mstep|${s.id}|${ym}|-1">−</button><div class="val" data-a="medit|${s.id}|${ym}">${L.fmt1(mi.value) || '0'}</div><button data-a="mstep|${s.id}|${ym}|1">＋</button></div></div>`;
  }
  h += '</div>';
  if (L.fyHasDaily(doc, ui.fy)) h += `<p class="muted">${ui.fy}年度の合計人工：${fyN}人工。日別の月は日別が元データです。月の数字を変えると、その月の稼働日に整数で割り振り直します。</p>`;
  h += siteSalesCard(doc, s);
  return h;
}
handlers.fy = fy => { ui.fy = Number(fy); render(); };
// 現場の売上見込み（人工×単価）。単価が無ければ 0円 ではなく設定を促す
function siteSalesCard(doc, s) {
  const fyS = L.siteSales(doc, s, L.fyMonths(ui.fy)), all = L.siteSales(doc, s, L.allMonths(doc));
  const y = doc.settings.firstFY, last = y + doc.settings.years - 1;
  let h = `<h3>売上見込み</h3><div class="card sales">`;
  if (!all.price) return h + `<p class="warn">💴 ${L.TRADES[s.trade]}の単価（円/人工）がまだ入っていません。単価を入れると売上見込みが出ます。</p><button class="wide" data-a="go|settings">⚙️ 設定で単価を入れる</button><button class="wide" data-a="go|edit/${s.id}">この現場だけの単価を入れる</button></div>`;
  h += `<div class="flex"><div><small class="muted">${ui.fy}年度</small><b class="yen">${L.yen(fyS.sales)}円</b><small class="muted">${L.yen(fyS.ninku)}人工</small></div>
    <div><small class="muted">5カ年（${y}～${last}年度）</small><b class="yen">${L.yen(all.sales)}円</b><small class="muted">${L.yen(all.ninku)}人工</small></div></div>
    <p class="muted small">単価 ${L.yen(all.price)}円/人工（${all.own ? 'この現場だけの単価' : '設定の' + L.TRADES[s.trade] + '単価'}）× 人工（${L.estName(doc)}・集計の稼働予測と同じ）</p></div>`;
  return h;
}
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
  if (!draft || draft._for !== id) { const s = isNew ? { trade: ui.trade, category: '新築', kubun: '入' } : site(id); if (!s) return '<p>現場が見つかりません</p>'; draft = { ...s, _for: id }; draft.division = L.divisionOf(draft); }
  const d = draft, tx = (k, lbl, ph = '') => `<label class="f">${lbl}</label><input type="text" data-k="${k}" value="${esc(d[k] ?? '')}" placeholder="${ph}">`;
  const chips = (k, opts, labels) => `<div class="chips">${opts.map((o, i) => `<button data-a="dset|${k}|${o}" class="${d[k] === o ? 'on' : ''}">${labels ? labels[i] : o}</button>`).join('')}</div>`;
  return `<button data-a="go|${isNew ? 'list' : 'site/' + id}">‹ 戻る</button><h2>${isNew ? '現場を追加' : '現場の情報'}</h2>
   <label class="f">職種</label>${chips('trade', Object.keys(L.TRADES), Object.values(L.TRADES))}
   <label class="f">新築／改修</label>${chips('category', L.CATEGORIES)}
   <label class="f">工事部（社内）</label><div class="chips big2">${['1', '2'].map(k => `<button data-a="dset|division|${k}" class="${d.division === k ? 'on' : ''}">${L.DIVISIONS[k]}</button>`).join('')}</div>
   <label class="f">区分</label>${chips('kubun', L.KUBUN)}
   <p class="muted small">入=入場中 現=施工中 指=指名 計=計画 営=営業中（Excelと同じ記号）</p>
   ${tx('name', '工事名（必須）')}${tx('bu', '部', '例：1、特、RN')}${tx('shocho', '所長', '名前（空でもよい）')}${tx('kessai', '決裁者', '名前（空でもよい）')}${tx('shokucho', '職長')}
   <div class="flex"><div>${tx('start', '工期（始）', 'R08.06')}</div><div>${tx('end', '工期（終）', 'R10.12')}</div></div>
   <label class="f">月数</label><input type="number" inputmode="decimal" data-k="months" value="${esc(d.months ?? '')}">
   ${tx('note', 'メモ')}
   <label class="f">この現場の曜日（定休日・日曜稼働など）</label>
   <p class="muted small" style="margin:0 0 4px">タップで「通常（会社カレンダーどおり）→ 休み → 出勤」と切り替え。例：水曜定休なら 水＝休み、日曜も動くなら 日＝出勤。祝日・会社の休みはそのまま（日別画面で1日ずつ出勤にできます）。</p>
   <div class="week">${L.WEEKDAYS.map((w, i) => { const v = (d.week || {})[i]; return `<button data-a="wk|${i}" class="${v || ''}"><b>${w}</b><small>${v === 'off' ? '休み' : v === 'work' ? '出勤' : '通常'}</small></button>`; }).join('')}</div>
   <label class="f">この現場だけの単価（円/人工）</label>
   <input type="number" inputmode="numeric" data-k="unitPrice" value="${esc(d.unitPrice ?? '')}" placeholder="${L.cleanPrice(D().settings.unitPrice?.[d.trade]) ? `空なら設定の単価 ${L.yen(L.cleanPrice(D().settings.unitPrice[d.trade]))}円` : '空なら設定の単価（いまは未設定）'}">
   <button class="primary wide" data-a="dsave">保存する</button>
   ${isNew ? '' : (L.isDone(site(id) || {}) ? `<button class="wide" data-a="doneUnset|${id}">↩ 竣工を解除</button>` : `<button class="wide" data-a="doneSet|${id}">🏁 竣工にする</button>`)}
   ${isNew ? '' : '<button class="danger wide" data-a="ddel">この現場を削除</button>'}`;
}
function readDraft() { document.querySelectorAll('[data-k]').forEach(i => { draft[i.dataset.k] = i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value.trim(); }); }
handlers.wk = i => { readDraft(); const w = { ...(draft.week || {}) }; w[i] = !w[i] ? 'off' : w[i] === 'off' ? 'work' : undefined; if (!w[i]) delete w[i]; draft.week = w; render(); };
handlers.dset = (k, v) => { readDraft(); draft[k] = v; if (k === 'division') draft._divSet = true; if (k === 'category' && draft._for === 'new' && !draft._divSet) draft.division = v === '改修' ? '2' : '1'; render(); };
handlers.dsave = () => {
  readDraft(); if (!draft.name) { alert('工事名を入れてください'); return; }
  const isNew = draft._for === 'new'; const id = isNew ? L.newId() : draft.id;
  const f = {}; for (const k of ['trade', 'category', 'division', 'kubun', 'name', 'bu', 'shocho', 'shokucho', 'kessai', 'start', 'end', 'months', 'note']) f[k] = draft[k] ?? '';
  f.week = L.cleanWeek(draft.week); f.unitPrice = L.cleanPrice(draft.unitPrice);
  if (draft.unitPrice != null && draft.unitPrice !== '' && !f.unitPrice) { alert('単価は 1円以上の数字で入れてください（空なら設定の単価を使います）'); return; }
  if (isNew) f.order = Math.max(0, ...D().sites.map(s => s.order ?? 0)) + 1;
  const orig = isNew ? null : site(id);
  if (f.kubun === L.DONE && (!orig || orig.kubun !== L.DONE)) f.prevKubun = orig ? orig.kubun : '';
  if (f.kubun !== L.DONE && orig && orig.kubun === L.DONE) f.prevKubun = '';
  draft = null; sync.push({ t: 'site', site: { id, ...f } }); scheduleSave(); location.hash = `site/${id}`;
};
handlers.ddel = () => { /* 削除 */ if (!confirm(`「${draft.name}」を削除しますか？\n（月・日の人数も消えます）`)) return; const id = draft.id; draft = null; sync.push({ t: 'delSite', id }); scheduleSave(); location.hash = 'list'; };

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
  return `<div class="flex"><button data-a="${act}|${months[i - 1] || ''}" ${i <= 0 ? 'disabled' : ''}>◀ 前の月</button><b class="center" style="font-size:18px;white-space:nowrap">${ymJP(ym)}</b><button data-a="${act}|${months[i + 1] || ''}" ${i >= months.length - 1 ? 'disabled' : ''}>次の月 ▶</button></div>`;
}
function vDay(id, ym) {
  const doc = D(), s = site(id); if (!s) return '<p>現場が見つかりません</p>';
  const months = L.dailyMonths(doc);
  if (!months.includes(ym)) ym = months.includes(curYm()) ? curYm() : months[0];
  const sView = (() => { const a = L.dailyOf(doc, s, ym); return a && a.length ? { ...s, daily: { ...(s.daily || {}), [ym]: a } } : s; })();
  const arr = (sView.daily && sView.daily[ym]) || []; const mi = L.monthInfo(doc, sView, ym); const dates = L.datesOfMonth(ym), last = dates.length;
  if (ui.dayKey !== id + ym) { ui.dayKey = id + ym; ui.sel = null; ui.r1 = ui.r2 = null; ui.ms = []; ui.mFrom = 1; ui.mTo = last; }
  const inR = d => ui.r1 && ui.r2 && d >= (ui.r1 < ui.r2 ? ui.r1 : ui.r2) && d <= (ui.r1 < ui.r2 ? ui.r2 : ui.r1);
  const mode = ui.multi ? 2 : ui.range ? 1 : 0;
  let h = `<button data-a="go|site/${id}">‹ ${esc(s.name)}</button>
   <h2>日別入力 <small class="muted">${L.TRADES[s.trade]}</small></h2>${monthNav(ym, 'dmon|' + id, months)}
   <p>この月：<b>${mi.ninku}</b>人工 ／ 稼働 <b>${mi.wd}</b>日${mi.offWork ? `<small>（うち休みの日に出勤 ${mi.offWork}日）</small>` : ''} ／ 平均 <b>${L.fmt1(mi.value) || '0'}</b>人/日 ${mi.edited ? '<span class="badge">手入力あり</span>' : ''}</p>
   <div class="tabs"><button data-a="rmode|0" class="${mode === 0 ? 'on' : ''}">1日ずつ</button><button data-a="rmode|1" class="${mode === 1 ? 'on' : ''}">期間でまとめて</button><button data-a="rmode|2" class="${mode === 2 ? 'on' : ''}">複数えらぶ</button></div><div class="daylayout"><div class="daycal">`;
  h += calCells(ym, d => {
    const sd = L.siteDay(doc, s, d), v = arr[Number(d.slice(8)) - 1] || 0;
    const cls = ['d', sd.work ? '' : 'off', !sd.work && v ? 'offwork' : '', ui.sel === d && mode === 0 ? 'sel' : '', mode === 1 && inR(d) ? 'inr' : '', mode === 2 && ui.ms.includes(d) ? 'msel' : '', sd.override || sd.week ? 'ovr' : ''].join(' ');
    return `<div class="${cls}" data-a="dtap|${d}"><span class="n">${Number(d.slice(8))}</span><span class="v">${v || ''}</span><span class="r">${sd.work ? (sd.week ? esc(sd.reason) : '') : esc(sd.reason)}</span></div>`;
  });
  h += `<div class="legend"><span><i style="background:var(--off)"></i>休み（日曜・祝日・会社/現場の休み）</span><span><i style="background:#ffe0b2;border:1px solid #e69500"></i>休みの日に出勤</span>${mode === 2 ? '<span><i style="background:#cfe3ff;outline:2px solid var(--blue)"></i>選んだ日</span>' : ''}</div></div>`;
  if (mode === 0 && ui.sel) {
    const sd = L.siteDay(doc, s, ui.sel), v = arr[Number(ui.sel.slice(8)) - 1] || 0;
    h += `<div class="panel"><div class="center"><b>${Number(ui.sel.slice(5, 7))}月${Number(ui.sel.slice(8))}日（${WD[L.dow(ui.sel)]}）</b> ${sd.work ? '' : `<span class="muted">休み：${esc(sd.reason)}</span><br><small class="muted">休みの日でも入れられます（入れた日は稼働日に数えます）</small>`}</div>
      <div class="big flex" style="justify-content:center"><button data-a="dstep|${id}|-1" style="flex:none;width:72px;height:60px;font-size:28px">−</button><b style="flex:none;font-size:32px;min-width:60px;text-align:center">${v}</b><button data-a="dstep|${id}|1" style="flex:none;width:72px;height:60px;font-size:28px">＋</button><span style="flex:none">人</span></div>
      <button class="wide" data-a="doff|${id}">${sd.work ? 'この日はこの現場を休みにする' : 'この日はこの現場を出勤にする'}</button>
      ${sd.override ? `<button class="wide" data-a="dreset|${id}">会社カレンダーどおりに戻す</button>` : ''}</div>`;
  } else if (mode === 1) {
    const a = ui.r1 && ui.r2 ? [ui.r1, ui.r2].sort() : null;
    const inP = a ? dates.filter(d => d >= a[0] && d <= a[1]) : [], wds = inP.filter(d => L.siteDay(doc, s, d).work);
    h += `<div class="panel">${!ui.r1 ? '始まりの日をタップ' : !ui.r2 ? '終わりの日をタップ' : `<b>${Number(a[0].slice(8))}日～${Number(a[1].slice(8))}日</b>（稼働日 ${wds.length}日・休み ${inP.length - wds.length}日）
      <button class="wide toggle ${ui.rOff ? 'on' : ''}" data-a="roff">${ui.rOff ? '☑' : '☐'} 休みの日にも入れる</button>
      <div class="big flex" style="justify-content:center"><button data-a="rstep|-1" style="flex:none;width:64px">−</button><input id="rv" type="number" inputmode="numeric" value="${ui.rv ?? 3}" style="flex:none;width:90px;text-align:center;font-size:24px"><button data-a="rstep|1" style="flex:none;width:64px">＋</button><span style="flex:none">人</span></div>
      <button class="primary wide" data-a="rfill|${id}">この期間${ui.rOff ? '（休みの日も）' : 'の稼働日'}を <span id="rvl">${ui.rv ?? 3}</span>人にする</button><button class="wide" data-a="rclear">選び直す</button>`}</div>`;
  } else if (mode === 2) {
    const n = ui.ms.length, nOff = ui.ms.filter(d => !L.siteDay(doc, s, d).work).length;
    const opts = sel => dates.map((d, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${i + 1}日（${WD[L.dow(d)]}）</option>`).join('');
    const inP = dates.filter((d, i) => i + 1 >= ui.mFrom && i + 1 <= ui.mTo);
    h += `<div class="panel multi"><p class="muted small" style="margin:0">日にちをタップで 選ぶ／外す。曜日ボタンで 期間の中のその曜日をまとめて選べます。</p>
      <div class="flex prd"><select id="mfrom" aria-label="期間の始まり">${opts(ui.mFrom)}</select><span style="flex:none">～</span><select id="mto" aria-label="期間の終わり">${opts(ui.mTo)}</select></div>
      <div class="wkpick">${WD.map((w, i) => { const ds = inP.filter(d => L.dow(d) === i), on = ds.length && ds.every(d => ui.ms.includes(d)); return `<button data-a="mwd|${i}" class="${on ? 'on' : ''} ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}" aria-pressed="${!!on}">${w}</button>`; }).join('')}</div>
      <div class="flex qk"><button data-a="mq|alt">隔日</button><button data-a="mq|work">稼働日</button><button data-a="mq|all">全日</button><button data-a="mq|none">全部外す</button></div>
      <p style="margin:6px 0"><b>選択中 ${n}日</b>${nOff ? `（うち休みの日 ${nOff}日）` : ''}${n ? `：<small>${ui.ms.slice().sort().map(d => Number(d.slice(8))).join('・')}日</small>` : ''}</p>
      ${n ? `<div class="applybar"><div class="big flex" style="justify-content:center"><button data-a="mstepv|-1" style="flex:none;width:64px">−</button><input id="mv" type="number" inputmode="numeric" value="${ui.mv ?? 3}" style="flex:none;width:90px;text-align:center;font-size:24px"><button data-a="mstepv|1" style="flex:none;width:64px">＋</button><span style="flex:none">人</span></div>
      <button class="primary wide" data-a="mfill|${id}">選んだ ${n}日を <span id="mvl">${ui.mv ?? 3}</span>人にする</button></div>` : ''}</div>`;
  } else h += '<p class="muted center">日にちをタップすると人数を変えられます（日曜・祝日など休みの日も入れられます）</p>';
  h += '</div>';
  return h;
}
handlers.dmon = (id, ym) => { if (ym) { ui.sel = null; location.hash = `day/${id}/${ym}`; } };
handlers.rmode = v => { ui.range = v === '1'; ui.multi = v === '2'; ui.r1 = ui.r2 = ui.sel = null; render(); };
handlers.dtap = d => {
  if (ui.multi) { ui.ms = ui.ms.includes(d) ? ui.ms.filter(x => x !== d) : [...ui.ms, d]; }
  else if (ui.range) { if (!ui.r1 || ui.r2) { ui.r1 = d; ui.r2 = null; } else ui.r2 = d; } else ui.sel = d;
  render();
};
const dayVal = (s, d) => ((s.daily && s.daily[d.slice(0, 7)]) || [])[Number(d.slice(8)) - 1] || 0;
handlers.dstep = (id, k) => {
  const s = site(id), d = ui.sel, arr = L.dailyOf(D(), s, d.slice(0, 7));
  const v = Math.max(0, (arr[Number(d.slice(8)) - 1] || 0) + Number(k));
  op({ t: 'day', id, date: d, v });
};
handlers.doff = id => { const s = site(id); const sd = L.siteDay(D(), s, ui.sel); const comp = L.siteDay(D(), { ...s, dayOverrides: {} }, ui.sel).work;
  const want = sd.work ? 'off' : 'work'; op({ t: 'siteDay', id, date: ui.sel, mode: (want === 'work') === comp ? null : want }); };
handlers.dreset = id => op({ t: 'siteDay', id, date: ui.sel, mode: null });
handlers.rstep = k => { const i = $('#rv'); ui.rv = Math.max(0, (Number(i.value) || 0) + Number(k)); i.value = ui.rv; $('#rvl').textContent = ui.rv; };
handlers.rclear = () => { ui.r1 = ui.r2 = null; render(); };
handlers.roff = () => { ui.rOff = !ui.rOff; render(); };
handlers.rfill = id => { const v = Math.max(0, Math.round(Number($('#rv').value) || 0)); ui.rv = v; const doc = D(), s = site(id); const [a, b] = [ui.r1, ui.r2].sort();
  const dates = L.datesOfMonth(a.slice(0, 7)).filter(d => d >= a && d <= b && (ui.rOff || L.siteDay(doc, s, d).work));
  if (!dates.length) { alert('期間に稼働日がありません（休みの日にも入れるなら「休みの日にも入れる」をオン）'); return; } op({ t: 'days', id, dates, v }); ui.r1 = ui.r2 = null; render(); };
// ---- 複数えらぶ（月水金・隔日など） ----
function readPeriod() { const f = $('#mfrom'), t = $('#mto'); if (f && t) { ui.mFrom = Number(f.value); ui.mTo = Number(t.value); if (ui.mFrom > ui.mTo) [ui.mFrom, ui.mTo] = [ui.mTo, ui.mFrom]; } }
function periodDates() { readPeriod(); const ym = ui.dayKey.slice(-7); return L.datesOfMonth(ym).filter((d, i) => i + 1 >= ui.mFrom && i + 1 <= ui.mTo); }
const keepMv = () => { const i = $('#mv'); if (i) ui.mv = Math.max(0, Math.round(Number(i.value) || 0)); };
handlers.mwd = w => { keepMv(); const ds = periodDates().filter(d => L.dow(d) === Number(w)); const on = ds.length && ds.every(d => ui.ms.includes(d));
  ui.ms = on ? ui.ms.filter(d => !ds.includes(d)) : [...new Set([...ui.ms, ...ds])]; render(); };
handlers.mq = k => { keepMv(); const ds = periodDates(), id = location.hash.split('/')[1], s = site(decodeURIComponent(id));
  if (k === 'none') ui.ms = [];
  else { const add = k === 'alt' ? ds.filter((d, i) => i % 2 === 0) : k === 'work' ? ds.filter(d => L.siteDay(D(), s, d).work) : ds; ui.ms = [...new Set([...ui.ms.filter(d => !ds.includes(d)), ...add])]; }
  render(); };
handlers.mstepv = k => { const i = $('#mv'); ui.mv = Math.max(0, (Number(i.value) || 0) + Number(k)); i.value = ui.mv; $('#mvl').textContent = ui.mv; };
handlers.mfill = id => { keepMv(); const v = ui.mv ?? 3; if (!ui.ms.length) return; op({ t: 'days', id, dates: ui.ms.slice().sort(), v }); ui.ms = []; render(); };

// ---------- 5カ年 ----------
function vGrid() {
  const doc = D(), months = L.fyMonths(ui.gridFY), nDaily = months.filter(ym => L.inWindow(doc, ym)).length;
  const sites = L.sortedSites(doc, ui.trade, OPT()); const tots = months.map(ym => L.monthTotals(doc, ym, OPT())[ui.trade]);
  let h = `<h2>5カ年山積表 <small class="muted">人/日</small></h2>${tradeTabs()}${doneToggle(ui.trade)}${fyTabs(ui.gridFY, 'gfy')}
   <p class="muted small">${nDaily ? '青い列は日別データから計算した月平均です（数字をタップで変更→日に割り振り）。日別でない月は月の値です。' : 'マスをタップすると数字を変えられます。'}</p>
   <div class="grid-wrap"><table class="grid"><thead><tr><th class="nm">工事名</th>${months.map(ym => `<th>${L.parseYm(ym).m}月</th>`).join('')}</tr></thead><tbody>`;
  for (const cat of L.CATEGORIES) {
    for (const s of sites.filter(x => x.category === cat)) {
      h += `<tr><td class="nm" data-a="go|site/${s.id}"><span class="kb ${esc(s.kubun)}" style="min-width:24px;height:24px;font-size:12px">${esc(s.kubun || '－')}</span> ${esc(s.name)}${L.isDone(s) ? '（竣工）' : ''}</td>`;
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
function chartAvail() {
  const main = $('#main');
  if (!main) return Math.max(340, document.documentElement.clientWidth - 24);
  const cs = getComputedStyle(main);
  return Math.max(340, Math.round(main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
}
function barChart(labels, series, { target, unit = '', w = chartAvail() } = {}) {
  const H = window.innerWidth >= 900 ? 300 : 240, pl = 40, pr = 8, pt = 18, pb = 28, n = labels.length;
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
// ---- 集計：グループ選択（鳶工/土工 × 一部/二部）と期間（1年/3カ年/5カ年） ----
const ALLG = L.GROUPS.map(g => g.key);
function selGroups() { try { const a = JSON.parse(localStorage.getItem(KEY.groups) || 'null'); if (Array.isArray(a)) return ALLG.filter(k => a.includes(k)); } catch { } return ALLG.slice(); }
const OPTG = () => ({ ...OPT(), groups: selGroups() });
function sumPeriod() { const p = localStorage.getItem(KEY.period); return ['1', '3', '5'].includes(p) ? p : '5'; }
function stackedChart(months, data, { targets = [] } = {}) {
  const n = months.length, avail = chartAvail();
  const pl = 34, pr = 10, pt = 26, pb = 34, H = window.innerWidth >= 900 ? 380 : 300;
  const bw = n <= 12 ? (avail - pl - pr) / n : 26, W = Math.max(avail, pl + pr + bw * n);
  const max = Math.max(1, ...data.total, ...targets.map(t => t.value)) * 1.15;
  const Y = v => pt + (H - pt - pb) * (1 - v / max);
  const mag = Math.pow(10, Math.floor(Math.log10(max))), step = max / mag > 5 ? mag : max / mag > 2 ? mag / 2 : mag / 5;
  let g = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" style="width:${W}px;max-width:none">`;
  for (let v = 0; v <= max; v += step) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e7ee"/><text x="${pl - 4}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#777">${Math.round(v * 10) / 10}</text>`;
  months.forEach((ym, i) => {
    const x = pl + i * bw;
    if (ym.endsWith('-04')) { g += `<line x1="${x}" x2="${x}" y1="${pt - 18}" y2="${H - pb + 4}" stroke="#555" stroke-dasharray="${i ? '4 3' : '0'}"/><text x="${x + 3}" y="${pt - 8}" font-size="12" font-weight="700" fill="#333">${L.fyOf(ym)}年度</text>`; }
    let y0 = H - pb;
    for (const s of data.series) { const v = s.values[i] || 0, hh = (H - pt - pb) * v / max; if (hh > 0) g += `<rect x="${x + bw * 0.12}" y="${y0 - hh}" width="${bw * 0.76}" height="${hh}" fill="${s.color}"><title>${s.label} ${ym} ${L.fmt1(v)}</title></rect>`; y0 -= hh; }
    g += `<text x="${x + bw / 2}" y="${H - pb + 14}" font-size="11" text-anchor="middle" fill="#444">${L.parseYm(ym).m}</text>`;
  });
  const pts = data.total.map((v, i) => `${pl + i * bw + bw / 2},${Y(v)}`).join(' ');
  g += `<polyline points="${pts}" fill="none" stroke="#222" stroke-width="1.6"/>`;
  data.total.forEach((v, i) => { const x = pl + i * bw + bw / 2; g += `<circle cx="${x}" cy="${Y(v)}" r="2.5" fill="#222"/>`; if (v) g += `<text x="${x}" y="${Y(v) - 5}" font-size="10" text-anchor="middle" fill="#222">${n <= 12 ? L.fmt1(v) : Math.round(v)}</text>`; });
  for (const t of targets) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(t.value)}" y2="${Y(t.value)}" stroke="#c62828" stroke-width="1.4" stroke-dasharray="7 4"/><text x="${pl + 4}" y="${Y(t.value) - 4}" font-size="11" fill="#c62828">${t.label}</text>`;
  g += `<text x="${pl}" y="${H - 6}" font-size="11" fill="#777">月（人/日・1日あたり平均）</text>`;
  return `<div class="chart-scroll">${g}</svg></div>`;
}
function groupPicker() {
  const sel = selGroups();
  return `<div class="gpick">${L.GROUPS.map(g => `<button data-a="gtog|${g.key}" class="${sel.includes(g.key) ? 'on' : ''}" aria-pressed="${sel.includes(g.key)}"><i style="background:${g.color}"></i>${sel.includes(g.key) ? '☑' : '☐'} ${g.label}</button>`).join('')}
   <button data-a="gall" class="${sel.length === ALLG.length ? 'on' : ''}">全部</button></div>`;
}
handlers.gtog = k => { let a = selGroups(); a = a.includes(k) ? a.filter(x => x !== k) : [...a, k]; localStorage.setItem(KEY.groups, JSON.stringify(a)); render(); };
handlers.gall = () => { localStorage.setItem(KEY.groups, JSON.stringify(selGroups().length === ALLG.length ? [] : ALLG)); render(); };
handlers.period = p => { localStorage.setItem(KEY.period, p); render(); };
handlers.pstart = fy => { localStorage.setItem(KEY.pstart, fy); render(); };
function vSum() {
  const doc = D(); const s = doc.settings, sel = selGroups();
  let h = `<h2>集計</h2><div class="tabs"><button data-a="smode|month" class="${ui.sumMode === 'month' ? 'on' : ''}">月ごと（通期）</button><button data-a="smode|day" class="${ui.sumMode === 'day' ? 'on' : ''}">日ごと</button></div>
    <p class="muted small" style="margin:4px 0">見たい組をチェック（この端末に記憶）</p>${groupPicker()}${doneToggle()}`;
  if (!sel.length) return h + '<p class="card center">上のチェックを1つ以上オンにしてください</p>';
  if (ui.sumMode === 'month') {
    const per = sumPeriod(), years = Number(per), last = s.firstFY + s.years - 1;
    let start = per === '5' ? s.firstFY : per === '1' ? ui.sumFY : Number(localStorage.getItem(KEY.pstart) || s.firstFY);
    start = Math.min(Math.max(start, s.firstFY), last - years + 1);
    const months = L.periodMonths(start, years), data = L.groupSeries(doc, months, sel, OPTG());
    // 土工と鳶工は山積みが別（それぞれの必要人数の目安）なので、合計・稼働予測・目標・余力は職種ごとに出す（両方を足した数は出さない）
    const trades = Object.keys(L.TRADES).filter(t => data.series.some(x => x.trade === t));
    h += `<div class="tabs">${[['1', '1年'], ['3', '3カ年'], ['5', '5カ年']].map(([k, v]) => `<button data-a="period|${k}" class="${per === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
    if (per === '1') h += fyTabs(ui.sumFY, 'sfy');
    if (per === '3') h += `<div class="tabs">${Array.from({ length: s.years - 2 }, (_, i) => s.firstFY + i).map(fy => `<button data-a="pstart|${fy}" class="${start === fy ? 'on' : ''}">${fy}～${fy + 2}年度</button>`).join('')}</div>`;
    if (trades.length > 1) h += '<p class="muted small" style="margin:4px 0">土工と鳶工は別々に出しています（足し合わせません）。</p>';
    const hd = months.map(ym => `<th class="${ym.endsWith('-04') ? 'fyb' : ''}">${years > 1 ? `${String(L.parseYm(ym).y).slice(2)}/` : ''}${L.parseYm(ym).m}月</th>`).join('');
    const row = (lb, arr, f = v => L.fmt1(v) || 0, cls = '') => `<tr class="${cls}"><td class="nm">${lb}</td>${arr.map((v, i) => `<td class="${months[i].endsWith('-04') ? 'fyb' : ''}">${f(v)}</td>`).join('')}</tr>`;
    const R = Math.round;
    trades.forEach((t, ti) => {
      const td = trades.length > 1 ? L.groupSeries(doc, months, sel.filter(k => k.startsWith(t)), OPTG()) : data;
      const tv = s.targets?.[t] || 0, targets = tv ? [{ value: tv, label: `${L.TRADES[t]}目標 ${tv}人` }] : [];
      const tot = trades.length > 1 ? `${L.TRADES[t]}の合計` : '選択の合計';
      h += `<h3 class="trade-h ${t}">${L.TRADES[t]}の山積み ${start}年度${years > 1 ? `～${start + years - 1}年度` : ''}（${td.series.map(x => x.label).join('・')}）</h3>
        <div class="legend">${td.series.map(x => `<span><i style="background:${x.color}"></i>${x.label}</span>`).join('')}<span><i style="background:#222;height:3px;vertical-align:4px"></i>${tot}</span>${targets.length ? `<span style="color:#c62828">--- 目標</span>` : ''}</div>
        ${stackedChart(months, td, { targets })}${years > 1 ? '<p class="muted small">← 横にスクロールできます。縦の点線が年度の区切り（4月）。</p>' : ''}`;
      if (ti === 0) h += `<div class="tabs"><button data-a="est|calendar" class="${s.estimateMode !== 'fixed' ? 'on' : ''}">稼働予測：カレンダー</button><button data-a="est|fixed" class="${s.estimateMode === 'fixed' ? 'on' : ''}">稼働予測：×22日（Excel方式）</button></div>`;
      h += `<div class="grid-wrap" style="margin-top:10px"><table class="grid"><thead><tr><th class="nm">${trades.length > 1 ? L.TRADES[t] + '（人/日）' : '項目（人/日）'}</th>${hd}</tr></thead><tbody>
        ${td.series.map(x => row(`<i class="sw" style="background:${x.color}"></i>${x.label}`, x.values)).join('')}
        ${row(tot, td.total, undefined, 'tot')}
        ${row(`月間稼働予測（${s.estimateMode === 'fixed' ? '×22日' : 'カレンダー'}）`, td.est, R, 'tot')}
        ${row('（比較）×22日', td.estFixed, R)}${row('（比較）カレンダー', td.estCalendar, R)}
        ${row('会社の稼働日数', td.companyWd, v => v)}${targets.length ? row(`余力（目標${targets[0].value}人−合計）`, td.total.map(v => targets[0].value - v), v => `<span style="color:${v < 0 ? '#c62828' : 'inherit'}">${L.fmt1(v) || 0}</span>`) : ''}
        </tbody></table></div>`;
    });
    h += `<p class="muted small">月間稼働予測：カレンダー＝日別の人工（日別でない年度は 平均×その現場の稼働日）。×22日＝Excelと同じく 合計×22。</p>`;
    h += salesSection(doc, data, months, years, start);
  } else {
    const months = L.dailyMonths(doc); if (!months.length) return h + '<p class="card">日別で見られる月がありません</p>';
    if (!months.includes(ui.sumYm)) ui.sumYm = months.includes(curYm()) ? curYm() : months[0];
    const dates = L.datesOfMonth(ui.sumYm), dt = dates.map(d => L.dayTotals(doc, d, OPTG()));
    const trades = Object.keys(L.TRADES).filter(t => sel.some(k => k.startsWith(t)));
    h += monthNav(ui.sumYm, 'symon', months);
    for (const t of trades) h += `<h3>${L.TRADES[t]}（人）${sel.filter(k => k.startsWith(t)).length === 1 ? '・' + L.GROUPS.find(g => sel.includes(g.key) && g.trade === t).label.split(' ')[1] : ''}</h3>` + barChart(dates.map(d => Number(d.slice(8))), [{ values: dt.map(x => x[t]), color: `var(--${t})` }], { target: s.targets?.[t], unit: '人' });
    h += `<div class="grid-wrap" style="margin-top:10px"><table class="grid"><thead><tr><th class="nm">日</th>${trades.map(t => `<th>${L.TRADES[t]}</th>`).join('')}</tr></thead><tbody>
      ${dates.map((d, i) => { const cd = L.companyDay(doc, d); return `<tr><td class="nm">${Number(d.slice(8))}日（${WD[L.dow(d)]}）${cd.work ? '' : `<small style="color:#c62828"> ${esc(cd.reason)}</small>`}</td>${trades.map(t => `<td>${dt[i][t] || ''}</td>`).join('')}</tr>`; }).join('')}
      <tr class="tot"><td class="nm">人工合計</td>${trades.map(t => `<td>${dt.reduce((a, x) => a + x[t], 0)}</td>`).join('')}</tr></tbody></table></div>${trades.length > 1 ? '<p class="muted small">土工と鳶工は別々に出しています（足し合わせません）。</p>' : ''}`;
  }
  h += `<button class="wide" data-a="go|ver">🗂️ 版の比較（月ごとに残した山積みの変化を見る）</button>`;
  h += `<h3>事務所用（Excelで開けます・チェックした組だけ）</h3><button class="wide" data-a="csv|month">⬇ 5カ年 月別CSV</button><button class="wide" data-a="csv|day">⬇ 日別CSV</button>`;
  return h;
}
// ---- 売上見込み（人工×単価）：選んだ組・期間どおり。土工と鳶工は別々に出す（足し合わせない。一部＋二部は同じ職種なので合計してよい） ----
function salesSection(doc, data, months, years, start) {
  const up = doc.settings.unitPrice || {}, sel = data.series.map(x => x.key);
  const trades = Object.keys(L.TRADES).filter(t => data.series.some(x => x.trade === t));
  const per = `${start}年度${years > 1 ? `～${start + years - 1}年度` : ''}`;
  const hd = months.map(ym => `<th class="${ym.endsWith('-04') ? 'fyb' : ''}">${years > 1 ? `${String(L.parseYm(ym).y).slice(2)}/` : ''}${L.parseYm(ym).m}月</th>`).join('');
  const row = (lb, arr, un, cls = '') => `<tr class="${cls}"><td class="nm">${lb}</td>${arr.map((v, i) => `<td class="${months[i].endsWith('-04') ? 'fyb' : ''}">${!v && un && un[i] > 0 ? '<small class="warn">未設定</small>' : L.man(v)}</td>`).join('')}</tr>`;
  let h = `<h3>売上見込み ${per}</h3>${trades.length > 1 ? '<p class="muted small" style="margin:0 0 4px">土工と鳶工は別々に出しています（足し合わせません）。</p>' : ''}`;
  for (const t of trades) {
    const td = trades.length > 1 ? L.groupSeries(doc, months, sel.filter(k => k.startsWith(t)), OPTG()) : data;
    const price = L.cleanPrice(up[t]), col = `var(--${t})`;
    h += `<div class="card sales trade-sales ${t}" data-trade="${t}" style="border-left:6px solid ${col}"><h4 style="margin:0 0 4px;color:${col}">${L.TRADES[t]}の売上見込み</h4>`;
    if (td.salesTotal <= 0 && td.unpricedTotal > 0) { h += `<p class="warn">💴 ${L.TRADES[t]}の単価（円/人工）が未設定です。単価を入れると売上見込みが出ます。</p><button class="primary wide" data-a="go|settings">⚙️ 設定で単価を入れる</button></div>`; continue; }
    const fyTot = []; for (let i = 0; i < years; i++) { const ms = L.fyMonths(start + i); fyTot.push([start + i, months.reduce((a, ym, k) => a + (ms.includes(ym) ? td.sales[k] : 0), 0)]); }
    h += `<div class="flex"><div><small class="muted">期間の合計（${td.series.map(x => x.label).join('・')}）</small><b class="yen" style="color:${col}">${L.yen(td.salesTotal)}円</b><small class="muted">約${L.man(td.salesTotal)}万円</small></div></div>
      ${years > 1 ? `<div class="fytot">${fyTot.map(([fy, v]) => `<span>${fy}年度 <b>${L.man(v)}</b>万円</span>`).join('')}</div>` : ''}
      <p class="muted small" style="margin:4px 0 0">人工（稼働予測：${L.estName(doc)}）× ${L.TRADES[t]}単価 ${price ? L.yen(price) + '円' : '未設定'}${doc.sites.some(x => x.trade === t && L.cleanPrice(x.unitPrice)) ? '（現場ごとの単価がある現場はそちらを優先）' : ''}</p>
      ${td.unpricedTotal > 0 ? `<p class="warn small">単価が無いため含んでいない人工：${L.yen(td.unpricedTotal)}人工</p>` : ''}
      ${!price && td.unpricedTotal > 0 ? `<button class="wide" data-a="go|settings">⚙️ 設定で${L.TRADES[t]}の単価を入れる</button>` : ''}</div>
      <div class="grid-wrap"><table class="grid"><thead><tr><th class="nm">${L.TRADES[t]} 売上見込み（万円）</th>${hd}</tr></thead><tbody>
      ${td.series.map(x => row(`<i class="sw" style="background:${x.color}"></i>${x.label}`, x.sales, x.unpriced)).join('')}
      ${row(trades.length > 1 ? `${L.TRADES[t]}の合計` : '選択の合計', td.sales, td.unpriced, 'tot')}</tbody></table></div>`;
  }
  return h;
}
handlers.smode = m => { ui.sumMode = m; render(); };
handlers.sfy = fy => { ui.sumFY = Number(fy); render(); };
handlers.symon = ym => { if (ym) { ui.sumYm = ym; render(); } };
handlers.est = m => op({ t: 'settings', patch: { estimateMode: m } });
handlers.csv = kind => {
  const doc = D(); const o = OPTG(); const text = kind === 'month' ? L.monthlyCsv(doc, o) : L.dailyCsv(doc, o);
  const tag = o.groups.length === ALLG.length ? '' : '_' + o.groups.map(k => L.GROUPS.find(g => g.key === k).label.replace(' ', '')).join('_');
  const name = kind === 'month' ? `労務稼働予定_5カ年${tag}_${today()}.csv` : `労務稼働予定_日別_${L.dailyFrom(doc).replace('-', '')}-${L.dailyHorizon(doc).replace('-', '')}${tag}_${today()}.csv`;
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
   <h3>日別で入れる期間</h3>
   <p>今は <b>${ymJP(L.dailyFrom(doc))}</b>から、<b>今月（${ymJP(curYm())}）の12か月先（${ymJP(L.dailyHorizon(doc))}）</b>まで日別で入れられます。前の月も、日別だった月はそのまま見られて直せます。</p>
   <p class="muted small">5カ年の先のほう（${ymJP(L.addMonths(L.dailyHorizon(doc), 1))}以降）は月の値だけです。月が近づくと自動で日別に切り替わります（月の値は変わりません。日別画面を開いて数字を直したとき、稼働日に整数で割り振られます）。</p>
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
  const up = doc.settings.unitPrice || {};
  const priceCard = `<div class="card"><h3 style="margin-top:0">単価（売上見込み用・円/人工）</h3>
   ${Object.entries(L.TRADES).map(([t, n]) => { const p = L.cleanPrice(up[t]); return `<div class="row"><div class="lbl">${n}</div><div class="info">${p ? `<b style="font-size:20px;color:#222">${L.yen(p)}</b> 円/人工` : '<span class="warn">未設定</span>'}</div><button data-a="price|${t}">${p ? '変える' : '入れる'}</button>${p ? `<button data-a="priceClr|${t}">消す</button>` : ''}</div>`; }).join('')}
   <p class="muted small">売上見込み＝人工×単価。集計・現場の画面・CSVに出ます。現場ごとに違う単価は、その現場の「現場の情報を直す」で入れられます。</p></div>`;
  return `<h2>設定</h2><div class="setgrid">${priceCard}<div class="card"><label class="f">あなたの名前（保存の記録に残ります）</label><input type="text" id="who" value="${esc(localStorage.getItem(KEY.who) || '')}"><button class="wide" data-a="who">名前を保存</button></div>
   <div class="card"><p>最終更新：${esc(doc.updatedAt ? new Date(doc.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '－')} ${esc(doc.updatedBy || '')}</p>
   <button class="wide" data-a="reload">最新を読み込む</button><button class="wide" data-a="savenow">今すぐ保存</button></div>
   <div class="card"><button class="wide" data-a="csv|month">⬇ 5カ年 月別CSV</button><button class="wide" data-a="csv|day">⬇ 日別CSV</button></div>
   <div class="card"><p class="muted small">この端末に覚えた合言葉を消します（共用の端末・機種変更のとき）。</p><button class="danger wide" data-a="lock">合言葉を忘れる</button></div></div>
   <p class="muted small">データ元：${esc(doc.source || '')}</p>`;
}
handlers.price = t => numberSheet({ title: `${L.TRADES[t]}の単価（円/人工）`, value: L.cleanPrice(D().settings.unitPrice?.[t]) || '', step: 1000, info: '1人工あたりの金額（税抜・税込は社内の決まりに合わせてください）', onOk: v => { if (!L.cleanPrice(v)) { alert('1円以上の数字を入れてください'); return; } op({ t: 'price', trade: t, v }); } });
handlers.priceClr = t => { if (confirm(`${L.TRADES[t]}の単価を消しますか？（売上見込みが出なくなります）`)) op({ t: 'price', trade: t, v: null }); };
handlers.who = () => { localStorage.setItem(KEY.who, $('#who').value.trim()); alert('保存しました'); };
handlers.reload = async () => { if (sync.pending.length) await sync.save(localStorage.getItem(KEY.who) || '').catch(() => {}); await sync.load().catch(e => alert(e.message)); render(); };
handlers.savenow = () => sync.save(localStorage.getItem(KEY.who) || '').then(render).catch(e => alert(e.message));
handlers.lock = () => { if (!confirm('合言葉を消しますか？次に開くとき入れ直しが必要です。')) return; localStorage.removeItem(KEY.pass); location.reload(); };

// ---------- 版の比較・推移（版は見るだけ。直すのはいつもの画面＝今のデータ） ----------
const vs = { src: null, list: null, cache: {}, mats: {}, loading: new Set(), failed: new Set(), err: '' };
const vKeyLabel = k => V.versionLabel(k);
const vShort = k => { if (k === V.CURRENT) return '現在'; const { y, m } = L.parseYm(k); return `${String(y).slice(2)}年${m}月`; };
// アプリを開いたとき：今月（日本時間）の版がまだ無ければ、読み込んだままのデータ（直す前）で作る。どの端末でも同じ。あれば何もしない
async function autoVersion(base, sha) {
  if (sync.demo || new URLSearchParams(location.search).get('today')) return;
  const ym = V.jstYm();
  if (localStorage.getItem(KEY.verOk) === ym) return;
  try {
    const list = V.versionsFromListing(await vs.src.list());
    if (V.needsVersion(list, ym)) await vs.src.createIfMissing(ym, V.makeVersion(base, ym, { savedBy: '自動（アプリを開いたとき）', source: { blob: sha || '' } }));
    localStorage.setItem(KEY.verOk, ym); vs.list = null;
  } catch { /* 次に開いたときにもう一度 */ }
}
async function vLoadList() {
  if (vs.loading.has('list')) return; vs.loading.add('list');
  try { vs.list = V.versionsFromListing(await vs.src.list()); vs.err = ''; } catch (e) { vs.err = e.auth ? 'データの鍵が使えません' : '版の一覧を読めませんでした（電波の良い所でもう一度）'; }
  vs.loading.delete('list'); if (location.hash.startsWith('#ver')) render();
}
async function vLoad(keys) {
  const need = keys.filter(k => k !== V.CURRENT && !vs.cache[k] && !vs.loading.has(k) && !vs.failed.has(k)); if (!need.length) return;
  need.forEach(k => vs.loading.add(k));
  await Promise.all(need.map(async k => { try { vs.cache[k] = await vs.src.get(k); } catch { vs.failed.add(k); vs.err = `${vKeyLabel(k)}を読めませんでした（電波の良い所でもう一度）`; } vs.loading.delete(k); }));
  if (location.hash.startsWith('#ver')) { ui.keepScroll = true; render(); }
}
// 版の数字（現場×月）。現在＝今のデータ（未保存の変更も含む）
function vMat(k) {
  if (k === V.CURRENT) { const d = D(); if (vs.curDoc !== d) { vs.curDoc = d; vs.curMat = V.siteMatrix(d, V.CURRENT); } return vs.curMat; }
  if (!vs.cache[k]) return null; return vs.mats[k] || (vs.mats[k] = V.siteMatrix(vs.cache[k].data, k));
}
const vDoc = k => (k === V.CURRENT ? D() : vs.cache[k] && vs.cache[k].data);
// 土工と鳶工は山積みが別（それぞれの必要人数の目安）なので、版の比較・グラフでも足し合わせない
const VMODES = { doko: '土工', tobi: '鳶工' };
const vTrade = () => (VMODES[ui.vMode] ? ui.vMode : (ui.vMode = VMODES[localStorage.getItem(KEY.verTrade)] ? localStorage.getItem(KEY.verTrade) : 'doko'));
const VLEG = '<div class="legend vleg"><span><b class="vd up">+3</b> 増えた（青）</span><span><b class="vd dn">−2</b> 減った（赤）</span><span>空欄＝同じ</span></div>';
const vInfoBox = () => (ui.vInfo ? `<div class="card vinfo"><div>${ui.vInfo}</div><button data-a="vinfoX" aria-label="閉じる">✕</button></div>` : '');
const vModeTabs = () => `<div class="tabs vmode ${vTrade()}">${Object.entries(VMODES).map(([k, v]) => `<button data-a="vmode|${k}" class="${ui.vMode === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
function vVer() {
  if (!vs.list) { if (!vs.err) vLoadList(); return `<h2>版の比較</h2>${vs.err ? `<p class="card warn">${esc(vs.err)}</p><button class="wide" data-a="vretry">もう一度読み込む</button>` : '<p class="center muted">版を読み込み中…</p>'}`; }
  vTrade(); ui.vTab = ui.vTab || 'cmp';
  const list = vs.list, keys = [...list, V.CURRENT];
  let h = `<h2>版の比較</h2><p class="muted small" style="margin:0 0 6px">毎月1日の山積みを「版」として自動で残しています（${list.length}件）。版は見るだけです（直すのはいつもの画面）。</p>
    <div class="tabs vtab"><button data-a="vtab|cmp" class="${ui.vTab === 'cmp' ? 'on' : ''}">🔍 2つの版を比べる</button><button data-a="vtab|trend" class="${ui.vTab === 'trend' ? 'on' : ''}">📈 推移グラフ</button></div>${vModeTabs()}`;
  if (!list.length) return h + '<p class="card">まだ版がありません。毎月1日に自動で作られます。</p>';
  if (vs.failed.size) h += `<p class="card warn">${esc(vs.err)}</p><button class="wide" data-a="vretry">もう一度読み込む</button>`;
  return h + (ui.vTab === 'trend' ? vTrend(keys) : vCompare(keys));
}
function vCompare(keys) {
  if (!keys.includes(ui.vA)) ui.vA = null; if (!keys.includes(ui.vB)) ui.vB = null;
  const L2 = vs.list; if (!ui.vB) ui.vB = L2.length >= 2 ? L2[L2.length - 1] : V.CURRENT;
  if (!ui.vA) ui.vA = L2.length >= 2 ? L2[L2.length - 2] : L2[L2.length - 1];
  const opt = sel => keys.slice().reverse().map(k => `<option value="${k}" ${sel === k ? 'selected' : ''}>${k === V.CURRENT ? '現在（いまのデータ）' : vKeyLabel(k)}</option>`).join('');
  let h = `<div class="vpick"><label>前<select id="va" data-ch="vA" aria-label="前の版">${opt(ui.vA)}</select></label><span class="arrow">→</span><label>後<select id="vb" data-ch="vB" aria-label="後の版">${opt(ui.vB)}</select></label></div>`;
  const mA = vMat(ui.vA), mB = vMat(ui.vB);
  if (!mA || !mB) { vLoad([ui.vA, ui.vB]); return h + '<p class="center muted">版を読み込み中…</p>'; }
  if (ui.vA === ui.vB) h += '<p class="muted small">同じ版どうしなので、違いはありません。</p>';
  h += `<div class="tabs"><button data-a="vgran|month" class="${ui.vGran !== 'day' ? 'on' : ''}">月ごと（5カ年）</button><button data-a="vgran|day" class="${ui.vGran === 'day' ? 'on' : ''}">日ごと</button></div>`;
  return h + (ui.vGran === 'day' ? vCompareDay() : vCompareMonth(mA, mB));
}
function vOnlyToggle(c) { const on = ui.vOnly !== false; return `<button class="wide toggle ${on ? 'on' : ''}" data-a="vonly" aria-pressed="${on}">${on ? '☑' : '☐'} 変わった現場だけ表示 <small>（変わらない現場 ${c.unchanged}件${on ? 'を非表示' : 'も表示中'}）</small></button>`; }
function vNameCell(r, extra = '') {
  const st = r.status === 'added' ? '<span class="badge vnew">新規</span>' : r.status === 'removed' ? '<span class="badge vgone">削除</span>' : '';
  return `<td class="nm vnm">${esc(r.name)}${r.done ? ' <span class="badge done">竣工</span>' : ''} ${st}${r.shift && r.shift.texts.length ? `<div class="vshift">${r.shift.texts.map(t => `<span class="${/遅れ|延長/.test(t) ? 'late' : /前倒し/.test(t) ? 'early' : ''}">${esc(t)}</span>`).join('')}</div>` : ''}${extra}</td>`;
}
const vCell = (d, a, b, unit, dataA) => `<td class="vd ${d > 0 ? 'up' : d < 0 ? 'dn' : ''}" ${d ? `data-a="${dataA}"` : ''} title="${L.fmt1(a) || 0} → ${L.fmt1(b) || 0}${unit}">${V.fmtDiff(d)}</td>`;
function vCompareMonth(mA, mB) {
  const diff = V.diffMonthly(mA, mB, ui.vMode), c = diff.counts, byFY = V.changesByFY(diff);
  const fys = [...new Set(diff.months.map(L.fyOf))];
  if (!fys.includes(ui.vFY)) { const cur = L.fyOf(curYm()), withCh = fys.filter(fy => byFY[fy]); ui.vFY = byFY[cur] ? cur : withCh.length ? withCh[0] : fys.includes(cur) ? cur : fys[0]; }
  const months = diff.months.filter(ym => L.fyOf(ym) === ui.vFY), idx = months.map(ym => diff.months.indexOf(ym));
  const dN = diff.ninkuB - diff.ninkuA;
  let h = `<div class="card vsum"><b>${esc(vKeyLabel(ui.vA))} → ${esc(vKeyLabel(ui.vB))}</b>（${VMODES[ui.vMode]}）<div class="kv2"><span>変わった現場 <b>${c.changed}</b>件</span><span>新規 <b>${c.added}</b></span><span>削除 <b>${c.removed}</b></span><span>工期のずれ <b>${c.shifted}</b></span></div>
    <div class="kv2"><span>5カ年の人工 ${L.yen(diff.ninkuA)} → ${L.yen(diff.ninkuB)}（<b class="${dN > 0.5 ? 'tup' : dN < -0.5 ? 'tdn' : ''}">${Math.abs(dN) < 0.5 ? '±0' : (dN > 0 ? '+' : '−') + L.yen(Math.abs(dN))}</b>）</span></div>${VLEG}</div>`;
  h += vOnlyToggle(c);
  h += `<div class="tabs">${fys.map(fy => `<button data-a="vfy|${fy}" class="${ui.vFY === fy ? 'on' : ''}">${fy}年度${byFY[fy] ? `<br><small>変更${byFY[fy]}</small>` : '<br><small>－</small>'}</button>`).join('')}</div>`;
  h += '<p class="muted small" style="margin:2px 0 6px">色のついたマスをタップすると、前と後の数字が出ます（人/日）。</p>';
  const rows = diff.rows.filter(r => ui.vOnly === false || r.changed);
  h += `<div class="grid-wrap"><table class="grid vt"><thead><tr><th class="nm">工事名</th>${months.map(ym => `<th>${L.parseYm(ym).m}月</th>`).join('')}</tr></thead><tbody>`;
  if (!rows.length) h += `<tr><td class="nm vnm">変わった現場はありません</td>${months.map(() => '<td></td>').join('')}</tr>`;
  for (const r of rows) h += `<tr class="${r.status}">${vNameCell(r)}${idx.map(i => { const x = r.cells[i]; return vCell(x.d, x.a, x.b, '人/日', `vcellm|${r.key}|${x.ym}`); }).join('')}</tr>`;
  h += `<tr class="tot"><td class="nm">${VMODES[vTrade()]}合計（人/日）</td>${idx.map(i => { const x = diff.totals[i]; return vCell(x.d, x.a, x.b, '人/日', `vcellm|__tot|${x.ym}`); }).join('')}</tr></tbody></table></div>
    <p class="muted small">数字は「後−前」の 1日あたり平均の人数（人/日）。工期のずれは、人数が入っている最初の月と最後の月で見ています。</p>${vInfoBox()}`;
  ui.vDiff = diff;
  return h;
}
function vCompareDay() {
  const dA = vDoc(ui.vA), dB = vDoc(ui.vB), months = V.commonDailyMonths(dA, ui.vA, dB, ui.vB);
  if (!months.length) return '<p class="card">この2つの版に、どちらにも日別が入っている月がありません。</p>';
  if (!months.includes(ui.vDayYm)) ui.vDayYm = months.includes(curYm()) ? curYm() : months[months.length - 1];
  const diff = V.diffDaily(dA, ui.vA, dB, ui.vB, ui.vDayYm, ui.vMode), dates = L.datesOfMonth(ui.vDayYm);
  let h = monthNav(ui.vDayYm, 'vdmon', months) + `<div class="legend">${VLEG}</div>` + vOnlyToggle(diff.counts);
  h += '<p class="muted small" style="margin:2px 0 6px">色のついたマスをタップすると、前と後の人数が出ます（人）。</p>';
  const rows = diff.rows.filter(r => ui.vOnly === false || r.changed);
  h += `<div class="grid-wrap"><table class="grid vt day"><thead><tr><th class="nm">工事名</th>${dates.map(d => `<th class="${L.dow(d) === 0 ? 'sun' : L.dow(d) === 6 ? 'sat' : ''}">${Number(d.slice(8))}<br><small>${WD[L.dow(d)]}</small></th>`).join('')}<th>月計</th></tr></thead><tbody>`;
  if (!rows.length) h += `<tr><td class="nm vnm">変わった現場はありません</td>${dates.map(() => '<td></td>').join('')}<td></td></tr>`;
  for (const r of rows) h += `<tr class="${r.status}">${vNameCell(r)}${r.cells.map(x => vCell(x.d, x.a, x.b, '人', `vcelld|${r.key}|${x.day}`)).join('')}${vCell(r.sumB - r.sumA, r.sumA, r.sumB, '人工', '')}</tr>`;
  const tA = diff.totals.reduce((a, x) => a + x.a, 0), tB = diff.totals.reduce((a, x) => a + x.b, 0);
  h += `<tr class="tot"><td class="nm">${VMODES[vTrade()]}合計（人）</td>${diff.totals.map(x => vCell(x.d, x.a, x.b, '人', `vcelld|__tot|${x.day}`)).join('')}${vCell(tB - tA, tA, tB, '人工', '')}</tr></tbody></table></div>${vInfoBox()}`;
  ui.vDDiff = diff;
  return h;
}
function vTrend(keys) {
  const vers = vs.list.slice(), missing = vers.filter(k => !vs.cache[k]);
  if (missing.length) { vLoad(missing); return `<p class="center muted">版を読み込み中…（${vers.length - missing.length}/${vers.length}）</p>`; }
  let mats = vers.map(vMat);
  const cur = vMat(V.CURRENT), last = mats[mats.length - 1];
  const same = last && JSON.stringify(last.sites.map(s => [s.id, s.values])) === JSON.stringify(cur.sites.map(s => [s.id, s.values]));
  if (!same) mats = [...mats, cur];
  const T = vTrade(), TN = VMODES[T], allName = `${TN}の全現場（合計）`;
  const picks = V.sitePicks(mats, T);
  if (ui.vSite !== V.ALL && !picks.some(p => p.key === ui.vSite)) ui.vSite = V.ALL;
  ui.vSite = ui.vSite || V.ALL;
  const series = V.trendSeries(mats, T, ui.vSite);
  const months = [...new Set(mats.flatMap(m => m.months))].sort();
  const tm = V.trendMonths(series, months);
  const name = ui.vSite === V.ALL ? allName : (picks.find(p => p.key === ui.vSite) || {}).name;
  let h = `<label class="f">現場をえらぶ（${TN}）</label><select id="vsite" data-ch="vSite">${[{ key: V.ALL, name: allName }, ...picks].map(p => `<option value="${esc(p.key)}" ${p.key === ui.vSite ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  h += `<h3>① 版ごとの計画線：${esc(name)}</h3><p class="muted small" style="margin:0">${TN}だけの人数（人/日）。うすい線＝古い版、黒い太線＝${same ? '最新の版' : '現在（まだ版になっていない変更を含む）'}。線が右にずれたら工期が遅れ、上がったら人数が増えています。</p>`;
  h += tm.length ? legendHtml(series) : '';
  h += overlaySvg(series, tm, { avail: chartAvail() });
  if (52 + 22 * tm.length > chartAvail()) h += '<p class="muted small">← 横にスクロールできます。</p>';
  const shorts = mats.map(m => vShort(m.key));
  let lines;
  if (ui.vSite === V.ALL) { // 土工と鳶工は別の線（足さない）
    lines = Object.keys(VMODES).map(t => ({ label: `${VMODES[t]}（全現場）`, color: TRADE_COLORS[t], bold: t === T, values: V.trendSeries(mats, t, V.ALL).map(x => x.ninkuTotal) }));
    h += `<h3>② 版ごとの人工合計の推移：土工・鳶工（別々）</h3><p class="muted small" style="margin:0">1つの版＝1つの点。5カ年の人工（人数×稼働日）の合計を、<b style="color:${TRADE_COLORS.doko}">土工</b>と<b style="color:${TRADE_COLORS.tobi}">鳶工</b>で別々に出しています（足していません）。（ ）は前の版との差。</p>`;
    h += `<div class="legend">${lines.map(l => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('')}</div>`;
  } else {
    lines = [{ label: name, color: TRADE_COLORS[T], bold: true, values: series.map(x => (x.present ? x.ninkuTotal : null)) }];
    h += `<h3>② 版ごとの人工合計の推移：${esc(name)}（${TN}）</h3><p class="muted small" style="margin:0">1つの版＝1つの点。5カ年の人工（人数×稼働日）の合計。（ ）は前の版との差。</p>`;
  }
  h += totalsSvg(lines, shorts, { avail: chartAvail() });
  return h;
}
handlers.vinfoX = () => { ui.vInfo = ''; render(); };
handlers.vretry = () => { vs.err = ''; vs.list = null; vs.failed.clear(); render(); };
handlers.vtab = t => { ui.vTab = t; ui.vInfo = ''; render(); };
handlers.vmode = m => { if (!VMODES[m]) return; ui.vMode = m; localStorage.setItem(KEY.verTrade, m); ui.vInfo = ''; render(); };
handlers.vgran = g => { ui.vGran = g; ui.vInfo = ''; render(); };
handlers.vonly = () => { ui.vOnly = ui.vOnly === false; render(); };
handlers.vfy = fy => { ui.vFY = Number(fy); ui.vInfo = ''; render(); };
handlers.vdmon = ym => { if (ym) { ui.vDayYm = ym; ui.vInfo = ''; render(); } };
handlers.vA = k => { ui.vA = k; ui.vInfo = ''; render(); };
handlers.vB = k => { ui.vB = k; ui.vInfo = ''; render(); };
handlers.vSite = k => { ui.vSite = k; render(); };
const vInfoText = (name, when, a, b, d, unit, f) => `<b>${esc(name)}</b>・${when}：${esc(vKeyLabel(ui.vA))} <b>${f(a)}</b> → ${esc(vKeyLabel(ui.vB))} <b>${f(b)}</b> ${unit}（<b class="${d > 0 ? 'tup' : 'tdn'}">${V.fmtDiff(d)}</b>）`;
handlers.vcellm = (key, ym) => { const d = ui.vDiff; if (!d) return; const i = d.months.indexOf(ym), r = key === '__tot' ? { name: '合計', cells: d.totals } : d.rows.find(x => x.key === key); if (!r) return; const x = r.cells[i];
  ui.vInfo = vInfoText(r.name, V.ymJP(ym), x.a, x.b, x.d, '人/日', v => L.fmt1(v) || '0'); render(); };
handlers.vcelld = (key, day) => { const d = ui.vDDiff; if (!d) return; const r = key === '__tot' ? { name: '合計', cells: d.totals } : d.rows.find(x => x.key === key); if (!r) return; const x = r.cells[Number(day) - 1];
  ui.vInfo = vInfoText(r.name, `${V.ymJP(d.ym)}${day}日`, x.a, x.b, x.d, '人', v => String(v)); render(); };

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
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#nso').click(); } if (e.key === 'Escape') close(); };
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

boot().catch(e => fatal('エラー：' + e.message));
