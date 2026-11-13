// 労務稼働予定（山積み）アプリ — データ計算ロジック（ブラウザ / Node 共通・副作用なし）
export const TRADES = { doko: '土工', tobi: '鳶工' };
export const CATEGORIES = ['新築', '改修'];
export const KUBUN = ['入', '現', '指', '計', '営', '応', '竣'];
// 社内の工事部（元請の「部」とは別）。既定は 新築→一部、改修→二部
export const DIVISIONS = { '1': '工事一部', '2': '工事二部' };
export const divisionOf = s => (s.division === '1' || s.division === '2' ? s.division : (s.category === '改修' ? '2' : '1'));
export const GROUPS = [
  { key: 'tobi1', trade: 'tobi', division: '1', label: '鳶工 一部', color: '#1f5fa8' },
  { key: 'tobi2', trade: 'tobi', division: '2', label: '鳶工 二部', color: '#4fb3a9' },
  { key: 'doko1', trade: 'doko', division: '1', label: '土工 一部', color: '#c0392b' },
  { key: 'doko2', trade: 'doko', division: '2', label: '土工 二部', color: '#f39c34' },
];
export const groupKey = s => s.trade + divisionOf(s);
// 区分(division)が無い現場に既定値を入れる（入れた件数を返す）
export function migrateDivision(doc) { let n = 0; for (const s of doc.sites) if (s.division !== '1' && s.division !== '2') { s.division = divisionOf(s); n++; } return n; }
export const SCHEMA = 'kaneko-roumu/1.1';
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
// 1.0 → 1.1：単価（settings.unitPrice）を空で追加。既存データは何も消さない（変えた所の数を返す）
export function migrateDoc(doc) {
  let n = 0; doc.settings = doc.settings || {};
  if (!doc.settings.unitPrice || typeof doc.settings.unitPrice !== 'object') { doc.settings.unitPrice = { doko: null, tobi: null }; n++; }
  for (const t of Object.keys(TRADES)) if (!(t in doc.settings.unitPrice)) { doc.settings.unitPrice[t] = null; n++; }
  if (doc.schema !== SCHEMA) { doc.schema = SCHEMA; n++; }
  return n;
}
export const SAT_MODES = { none: '土曜は稼働（4週4閉所）', sat24: '第2・第4土曜は休み（4週6閉所）', all: '土曜は全部休み（4週8閉所）' };

let HOLIDAYS = {};
export function setHolidays(h) { HOLIDAYS = { ...(h.official || {}), ...(h.provisional || {}) }; }
export function holidayName(date) { return HOLIDAYS[date] || null; }

const pad = n => String(n).padStart(2, '0');
export const ymStr = (y, m) => `${y}-${pad(m)}`;
export const dateStr = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export function parseYm(ym) { const [y, m] = ym.split('-').map(Number); return { y, m }; }
export function daysInMonth(ym) { const { y, m } = parseYm(ym); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function fyMonths(fy) { const a = []; for (let i = 0; i < 12; i++) { const m = 4 + i; a.push(m <= 12 ? ymStr(fy, m) : ymStr(fy + 1, m - 12)); } return a; }
export function fyOf(ym) { const { y, m } = parseYm(ym); return m >= 4 ? y : y - 1; }
export function allMonths(doc) { const s = doc.settings; let a = []; for (let i = 0; i < s.years; i++) a = a.concat(fyMonths(s.firstFY + i)); return a; }
export function monthLabel(ym) { return `${parseYm(ym).m}月`; }
export function addMonths(ym, n) {
  const { y, m } = parseYm(ym);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = ((t % 12) + 12) % 12;
  return ymStr(ny, nm + 1);
}

// 日付（YYYY-MM-DD）。未設定なら日本時間の今日。テストは setToday() で固定できる
let TODAY = null;
export function setToday(d) { TODAY = d || null; }
export function todayStr() { return TODAY || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
export function todayYm() { return todayStr().slice(0, 7); }
// 一時的に「今日」を変えて計算する（版＝その月の1日時点の見え方で数字を出すため）
export function withToday(d, fn) { const prev = TODAY; TODAY = d || prev; try { return fn(); } finally { TODAY = prev; } }

// 日別の開始月（既定＝日別を始めた年度の4月）。settings.dailyFrom があればそれを使う
export function dailyFrom(doc) {
  if (doc.settings.dailyFrom) return doc.settings.dailyFrom;
  return fyMonths(doc.settings.dailyFY ?? doc.settings.firstFY)[0];
}
// 日別の終わり＝今月から11か月先（今月末までで12か月）、5カ年の最終月で打切り
export function dailyHorizon(doc, nowYm = todayYm()) {
  const horizon = addMonths(nowYm, 11);
  const all = allMonths(doc);
  const last = all.length ? all[all.length - 1] : horizon;
  return horizon < last ? horizon : last;
}
export function dailyMonths(doc, nowYm = todayYm()) {
  const from = dailyFrom(doc), to = dailyHorizon(doc, nowYm);
  return allMonths(doc).filter(ym => ym >= from && ym <= to);
}
export function fyHasDaily(doc, fy, nowYm = todayYm()) {
  return fyMonths(fy).some(ym => inWindow(doc, ym, nowYm));
}
export function dow(date) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function datesOfMonth(ym) { const { y, m } = parseYm(ym); const n = daysInMonth(ym); const a = []; for (let d = 1; d <= n; d++) a.push(dateStr(y, m, d)); return a; }
export const round2 = v => Math.round(v * 100) / 100;
export const fmt1 = v => (v ? (Math.round(v * 10) / 10).toFixed(1) : '');

// ---- 会社カレンダー ----
export function companyDay(doc, date) {
  const cal = doc.calendar || {};
  if (cal.workdays && cal.workdays[date]) return { work: true, reason: '出勤日(会社指定)' };
  if (cal.closures && cal.closures[date]) return { work: false, reason: cal.closures[date], kind: 'closure' };
  const h = holidayName(date);
  if (h) return { work: false, reason: h, kind: 'holiday' };
  const w = dow(date);
  if (w === 0) return { work: false, reason: '日曜', kind: 'sun' };
  if (w === 6) {
    const mode = doc.settings.saturday || 'none';
    const nth = Math.ceil(Number(date.slice(8)) / 7);
    if (mode === 'all' || (mode === 'sat24' && (nth === 2 || nth === 4))) return { work: false, reason: '土曜閉所', kind: 'sat' };
  }
  return { work: true, reason: '' };
}
export function siteDay(doc, site, date) {
  const o = site && site.dayOverrides && site.dayOverrides[date];
  if (o === 'work') return { work: true, reason: '現場出勤', override: true };
  if (o === 'off') return { work: false, reason: '現場休み', override: true, kind: 'site' };
  const c = companyDay(doc, date), w = site && site.week && site.week[dow(date)];
  // 現場の曜日設定（例 水曜定休・日曜稼働）。祝日・会社休業日は日ごとの「出勤」でだけ変えられる
  if (w === 'off' && c.work) return { work: false, reason: `定休(${WEEKDAYS[dow(date)]})`, kind: 'week', week: true };
  if (w === 'work' && !c.work && (c.kind === 'sun' || c.kind === 'sat')) return { work: true, reason: `${WEEKDAYS[dow(date)]}曜稼働`, week: true };
  return c;
}
export function workingDates(doc, site, ym) { return datesOfMonth(ym).filter(d => siteDay(doc, site, d).work); }
export function workingDays(doc, site, ym) { return workingDates(doc, site, ym).length; }
// 現場の曜日設定：{ '0': 'work', '3': 'off' } の形（無い曜日は会社カレンダーどおり）
export function cleanWeek(w) { const o = {}; for (const [k, v] of Object.entries(w || {})) if (/^[0-6]$/.test(k) && (v === 'work' || v === 'off')) o[k] = v; return Object.keys(o).length ? o : null; }

// ---- 日別ウィンドウ（開始月〜今月から12か月先まで。年をまたいでも YYYY-MM で区別） ----
export function inWindow(doc, ym, nowYm = todayYm()) {
  return ym >= dailyFrom(doc) && ym <= dailyHorizon(doc, nowYm);
}

// 月の値：ウィンドウ内は日別が正（平均＝人工÷稼働日）、外は月の値そのもの
// 日別配列。まだ日に展開していなくても、ウィンドウ内で月の値があれば表示用に割り振る（保存はしない）
export function dailyOf(doc, site, ym) {
  const arr = (site.daily && site.daily[ym]) || [];
  if (arr.some(v => v) || (site.editedMonths && site.editedMonths[ym])) return arr;
  const v = (site.monthly && site.monthly[ym]) || 0;
  if (v && inWindow(doc, ym)) return spreadMonth(doc, site, ym, v);
  return arr;
}
export function monthInfo(doc, site, ym) {
  if (inWindow(doc, ym)) {
    const stored = (site.daily && site.daily[ym]) || [];
    const hasDaily = stored.some(v => v) || !!(site.editedMonths && site.editedMonths[ym]);
    // まだ日別が無い月は、既存の月の値をそのまま使う（割り振りで数字が変わらないようにする）
    if (!hasDaily) {
      const value = (site.monthly && site.monthly[ym]) || 0;
      const wd = workingDays(doc, site, ym);
      return { daily: true, ninku: value * wd, wd, calWd: wd, offWork: 0, value, edited: false, unspread: !!value };
    }
    const arr = stored;
    const ninku = arr.reduce((a, b) => a + (Number(b) || 0), 0);
    // 稼働日数＝この現場の稼働日（会社カレンダー＋現場の曜日・日ごとの設定）＋休みの日に人数が入っている日
    let calWd = 0, offWork = 0;
    datesOfMonth(ym).forEach((d, i) => { if (siteDay(doc, site, d).work) calWd++; else if (Number(arr[i]) > 0) offWork++; });
    const wd = calWd + offWork;
    return { daily: true, ninku, wd, calWd, offWork, value: wd ? ninku / wd : 0, edited: !!(site.editedMonths && site.editedMonths[ym]) };
  }
  const value = (site.monthly && site.monthly[ym]) || 0;
  const wd = workingDays(doc, site, ym);
  return { daily: false, value, wd, ninku: value * wd, edited: false };
}

// 月の値を稼働日に整数で配る（合計人工＝round(値×稼働日)、端数は最大剰余法で均等に散らす）
export function spreadInts(value, n) {
  if (n <= 0) return [];
  const total = Math.max(0, Math.round(value * n));
  const base = Math.floor(total / n), r = total - base * n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(base + (Math.floor((i + 1) * r / n) > Math.floor(i * r / n) ? 1 : 0));
  return out;
}
export function spreadMonth(doc, site, ym, value) {
  const dates = datesOfMonth(ym);
  const wds = dates.filter(d => siteDay(doc, site, d).work);
  const ints = spreadInts(value, wds.length);
  const arr = new Array(dates.length).fill(0);
  wds.forEach((d, i) => { arr[Number(d.slice(8)) - 1] = ints[i]; });
  return arr;
}

// ---- 操作（op）: すべてここを通す。保存競合時はリモートの最新に同じ op を再適用する ----
export function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
const SITE_FIELDS = ['trade', 'category', 'division', 'kubun', 'prevKubun', 'name', 'bu', 'shocho', 'shokucho', 'kessai', 'start', 'end', 'months', 'note', 'order', 'week', 'unitPrice'];
// 単価（円/人工）：正の数だけ有効。それ以外（空・0・文字）は「未設定」= null
export function cleanPrice(v) { if (v === '' || v == null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; }
function cleanArr(arr) { return arr.some(v => v) ? arr : undefined; }
// 日の入力の前に、月の値を日に展開しておく（ゼロ埋めして月の値を消してしまわないため）
export function ensureSiteDaily(doc, site, ym) {
  if (!inWindow(doc, ym)) return false;
  site.daily = site.daily || {};
  if ((site.daily[ym] || []).some(v => v) || (site.editedMonths && site.editedMonths[ym] && site.daily[ym])) return false;
  const v = (site.monthly && site.monthly[ym]) || 0;
  if (!v) return false;
  const c = cleanArr(spreadMonth(doc, site, ym, v));
  if (c) { site.daily[ym] = c; return true; }
  return false;
}

export function applyOp(doc, op) {
  const site = op.id ? doc.sites.find(s => s.id === op.id) : null;
  const touch = s => { s.updatedAt = op.at || s.updatedAt; };
  switch (op.t) {
    case 'site': {
      let s = doc.sites.find(x => x.id === op.site.id);
      if (!s) { s = { id: op.site.id, monthly: {}, daily: {}, dayOverrides: {}, editedMonths: {} }; doc.sites.push(s); }
      for (const k of SITE_FIELDS) if (k in op.site) s[k] = op.site[k];
      if ('week' in op.site) { const w = cleanWeek(op.site.week); if (w) s.week = w; else delete s.week; }
      if ('unitPrice' in op.site) { const p = cleanPrice(op.site.unitPrice); if (p) s.unitPrice = p; else delete s.unitPrice; }
      touch(s); break;
    }
    case 'delSite': doc.sites = doc.sites.filter(s => s.id !== op.id); break;
    case 'day': case 'days': {
      if (!site) break;
      const dates = op.t === 'day' ? [op.date] : op.dates;
      site.daily = site.daily || {}; site.editedMonths = site.editedMonths || {};
      for (const d of dates) {
        const ym = d.slice(0, 7);
        if (!inWindow(doc, ym)) continue;
        ensureSiteDaily(doc, site, ym);
        const arr = (site.daily[ym] || new Array(daysInMonth(ym)).fill(0)).slice();
        arr[Number(d.slice(8)) - 1] = Math.max(0, Math.round(Number(op.v) || 0));
        const c = cleanArr(arr); if (c) site.daily[ym] = c; else delete site.daily[ym];
        site.editedMonths[ym] = true;
        site.monthly = site.monthly || {};
        const mi = monthInfo(doc, site, ym); site.monthly[ym] = round2(mi.value);
      }
      touch(site); break;
    }
    case 'month': {
      if (!site) break;
      const v = Math.max(0, round2(Number(op.v) || 0));
      site.monthly = site.monthly || {};
      if (inWindow(doc, op.ym)) {
        site.daily = site.daily || {}; site.editedMonths = site.editedMonths || {};
        const c = cleanArr(spreadMonth(doc, site, op.ym, v));
        if (c) site.daily[op.ym] = c; else delete site.daily[op.ym];
        delete site.editedMonths[op.ym];
        site.monthly[op.ym] = round2(monthInfo(doc, site, op.ym).value);
      } else {
        if (v) site.monthly[op.ym] = v; else delete site.monthly[op.ym];
      }
      touch(site); break;
    }
    case 'siteDay': {
      if (!site) break;
      site.dayOverrides = site.dayOverrides || {};
      if (op.mode) site.dayOverrides[op.date] = op.mode; else delete site.dayOverrides[op.date];
      touch(site); break;
    }
    case 'closure': { doc.calendar.closures = doc.calendar.closures || {}; if (op.name) doc.calendar.closures[op.date] = op.name; else delete doc.calendar.closures[op.date]; break; }
    case 'companyWork': { doc.calendar.workdays = doc.calendar.workdays || {}; if (op.on) doc.calendar.workdays[op.date] = true; else delete doc.calendar.workdays[op.date]; break; }
    case 'settings': { Object.assign(doc.settings, op.patch); break; }
    case 'price': { if (!TRADES[op.trade]) break; doc.settings.unitPrice = { doko: null, tobi: null, ...(doc.settings.unitPrice || {}) }; doc.settings.unitPrice[op.trade] = cleanPrice(op.v); break; }
    case 'roll': rollWindow(doc, op.fy); break;
    default: break;
  }
  return doc;
}
export function applyOps(doc, ops) { const d = structuredClone(doc); for (const op of ops) applyOp(d, op); return d; }

// 互換：指定年度の月の値を日に展開する。過去の日別は消さない・固定しない（日別の開始を前にずらすときだけ dailyFY を更新）
export function rollWindow(doc, fy) {
  const old = doc.settings.dailyFY;
  if (fy < old) doc.settings.dailyFY = fy;
  for (const s of doc.sites) {
    s.monthly = s.monthly || {}; s.daily = s.daily || {};
    for (const ym of fyMonths(fy)) {
      const has = s.daily[ym] && s.daily[ym].some(v => v);
      if (!has && s.monthly[ym]) { const c = cleanArr(spreadMonth(doc, s, ym, s.monthly[ym])); if (c) s.daily[ym] = c; }
    }
  }
  return doc;
}

// ---- 竣工（区分＝竣）の表示切替：工期の終わりでは判断しない ----
export const DONE = '竣';
export const isDone = s => s.kubun === DONE;
// opt.groups（例 ['tobi1','doko2']）を渡すとそのグループだけ
export const shown = (s, opt = {}) => (!!opt.includeDone || !isDone(s)) && (!opt.groups || opt.groups.includes(groupKey(s)));
// 竣工にする／竣工を解除（元の区分に戻す。不明なら「現」）。月・日の人数は消さない
export function doneOp(s) { return { t: 'site', site: { id: s.id, kubun: DONE, prevKubun: s.kubun && s.kubun !== DONE ? s.kubun : (s.prevKubun || '') } }; }
export function undoneOp(s) { return { t: 'site', site: { id: s.id, kubun: s.prevKubun && s.prevKubun !== DONE ? s.prevKubun : '現', prevKubun: '' } }; }

// ---- 集計（opt.includeDone=true で竣工も含める。既定は除外） ----
export function monthTotals(doc, ym, opt = {}) {
  const r = {};
  const { m } = parseYm(ym);
  const fixed = (doc.settings.fixedDays && doc.settings.fixedDays[m]) || 22;
  const z = () => ({ sales: 0, unpriced: 0 });
  for (const t of Object.keys(TRADES)) r[t] = { 新築: 0, 改修: 0, 合計: 0, ninku: 0, ...z() };
  r.groups = {}; for (const g of GROUPS) r.groups[g.key] = { value: 0, ninku: 0, ...z() };
  for (const s of doc.sites) {
    if (!shown(s, opt)) continue;
    const mi = monthInfo(doc, s, ym);
    const t = r[s.trade]; if (!t) continue;
    t[s.category === '改修' ? '改修' : '新築'] += mi.value; t.合計 += mi.value; t.ninku += mi.ninku;
    const g = r.groups[groupKey(s)]; if (g) { g.value += mi.value; g.ninku += mi.ninku; }
    // 売上見込み＝人工（稼働予測と同じ方式）×単価。単価が無い現場の人工は unpriced に積む
    const est = doc.settings.estimateMode === 'fixed' ? mi.value * fixed : mi.ninku, p = priceOf(doc, s);
    for (const x of [t, g]) if (x) { if (p) x.sales += est * p; else x.unpriced += est; }
  }
  for (const t of Object.keys(TRADES)) {
    r[t].estCalendar = r[t].ninku;
    r[t].estFixed = r[t].合計 * fixed;
    r[t].est = doc.settings.estimateMode === 'fixed' ? r[t].estFixed : r[t].estCalendar;
    r[t].target = (doc.settings.targets && doc.settings.targets[t]) || 0;
  }
  for (const g of GROUPS) { const x = r.groups[g.key]; x.estCalendar = x.ninku; x.estFixed = x.value * fixed; x.est = doc.settings.estimateMode === 'fixed' ? x.estFixed : x.estCalendar; }
  r.companyWd = workingDays(doc, null, ym); r.fixedDays = fixed;
  return r;
}
// ---- 単価・売上見込み ----
// 現場の単価（現場ごとの上書き → 設定の職種単価）。未設定なら null
export function priceOf(doc, s) { return cleanPrice(s.unitPrice) || cleanPrice(doc.settings.unitPrice && doc.settings.unitPrice[s.trade]); }
export const estName = doc => (doc.settings.estimateMode === 'fixed' ? '×22日方式' : 'カレンダー方式');
// 1現場の期間の 人工（稼働予測と同じ方式）と売上見込み
export function siteSales(doc, s, months) {
  let ninku = 0; for (const ym of months) { const mi = monthInfo(doc, s, ym); ninku += doc.settings.estimateMode === 'fixed' ? mi.value * ((doc.settings.fixedDays && doc.settings.fixedDays[parseYm(ym).m]) || 22) : mi.ninku; }
  const price = priceOf(doc, s);
  return { ninku, price, sales: price ? ninku * price : null, own: !!cleanPrice(s.unitPrice) };
}
export const yen = v => Math.round(v).toLocaleString('ja-JP');
export const man = v => (Math.round(v / 1e4)).toLocaleString('ja-JP'); // 万円（四捨五入）
// 通期（startFY から years 年分）の月一覧
export function periodMonths(startFY, years) { let a = []; for (let i = 0; i < years; i++) a = a.concat(fyMonths(startFY + i)); return a; }
// 選んだグループの月別山積み（積み上げ用）と合計
export function groupSeries(doc, months, groups, opt = {}) {
  const tots = months.map(ym => monthTotals(doc, ym, opt));
  const series = GROUPS.filter(g => groups.includes(g.key)).map(g => ({ ...g, values: tots.map(t => t.groups[g.key].value), est: tots.map(t => t.groups[g.key].est), estFixed: tots.map(t => t.groups[g.key].estFixed), estCalendar: tots.map(t => t.groups[g.key].estCalendar), sales: tots.map(t => t.groups[g.key].sales), unpriced: tots.map(t => t.groups[g.key].unpriced) }));
  const sum = k => months.map((_, i) => series.reduce((a, s) => a + s[k][i], 0));
  const tot = a => a.reduce((x, y) => x + y, 0);
  for (const s of series) { s.salesTotal = tot(s.sales); s.unpricedTotal = tot(s.unpriced); }
  const sales = sum('sales'), unpriced = sum('unpriced');
  return { months, series, total: sum('values'), est: sum('est'), estFixed: sum('estFixed'), estCalendar: sum('estCalendar'), sales, unpriced, salesTotal: tot(sales), unpricedTotal: tot(unpriced), companyWd: tots.map(t => t.companyWd), fixedDays: tots.map(t => t.fixedDays) };
}
export function dayTotals(doc, date, opt = {}) {
  const ym = date.slice(0, 7), i = Number(date.slice(8)) - 1;
  const r = { doko: 0, tobi: 0 };
  if (!inWindow(doc, ym)) return r;
  for (const s of doc.sites) {
    if (!shown(s, opt)) continue;
    const a = dailyOf(doc, s, ym);
    if (a && r[s.trade] !== undefined) r[s.trade] += Number(a[i]) || 0;
  }
  return r;
}

// ---- CSV（Excel で開けるよう BOM 付き UTF-8） ----
const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// ---- 現場の並び：開始が早い順（職種・新築/改修のまとまりの中で）。開始が無い現場は最後、同じなら今までの順（order） ----
const ERAS = { R: 2018, '令和': 2018, H: 1988, '平成': 1988, S: 1925, '昭和': 1925 };
// 工期（始）の文字 → 'YYYY-MM'。読めなければ null。例：R08.06 / R8.6 / 令和8年6月 / 2026/06 / 2026-06-15
export function parseStartYm(v) {
  let t = String(v ?? '').trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[．。／－ー―‐・]/g, '.').replace(/元(?=\s*年)/, '1');
  if (!t) return null;
  let y, m, x;
  if ((x = /^(R|H|S|令和|平成|昭和)\s*(\d{1,2})\s*[.\-/年]\s*(\d{1,2})/i.exec(t))) { y = ERAS[x[1].length === 1 ? x[1].toUpperCase() : x[1]] + Number(x[2]); m = Number(x[3]); }
  else if ((x = /^(\d{4})\s*[.\-/年]\s*(\d{1,2})/.exec(t))) { y = Number(x[1]); m = Number(x[2]); }
  else return null;
  return m >= 1 && m <= 12 && y >= 1900 && y <= 2200 ? `${y}-${String(m).padStart(2, '0')}` : null;
}
// 人数（月 または 日）が入っている最初の月。無ければ null
export function firstHeadcountYm(s) {
  const yms = [...Object.entries(s.monthly || {}).filter(([, v]) => Number(v) > 0).map(([ym]) => ym), ...Object.entries(s.daily || {}).filter(([, a]) => Array.isArray(a) && a.some(v => Number(v) > 0)).map(([ym]) => ym)].filter(ym => /^\d{4}-\d{2}$/.test(ym));
  return yms.length ? yms.sort()[0] : null;
}
// 並びに使う開始：工期（始）が読めればそれ、無ければ人数が入った最初の月
export function siteStartYm(s) { return parseStartYm(s.start) || firstHeadcountYm(s); }
// x は { trade, category, startYm, order }（startYm＝null は最後）
export function compareSites(a, b) {
  return (a.trade === b.trade ? 0 : a.trade === 'doko' ? -1 : 1) || (a.category === b.category ? 0 : a.category === '新築' ? -1 : 1)
    || (a.startYm === b.startYm ? 0 : !a.startYm ? 1 : !b.startYm ? -1 : a.startYm < b.startYm ? -1 : 1) || (a.order ?? 0) - (b.order ?? 0);
}
export function sortedSites(doc, trade, opt = {}) {
  return doc.sites.filter(s => (!trade || s.trade === trade) && shown(s, opt))
    .map(s => ({ s, k: { trade: s.trade, category: s.category, startYm: siteStartYm(s), order: s.order } }))
    .sort((a, b) => compareSites(a.k, b.k)).map(x => x.s);
}
export function monthlyCsv(doc, opt = {}) {
  const months = allMonths(doc);
  const head = ['職種', '新築/改修', '工事部', '区分', '工事名', '部', '所長', '職長', '決裁者', '工期(始)', '工期(終)', '月数', ...months.map(ym => ym.replace('-', '/')), `5カ年人工(${estName(doc)})`, '単価(円/人工)', '売上見込み(円)'];
  const rows = [head];
  const UN = '単価未設定';
  for (const s of sortedSites(doc, null, opt)) { const ss = siteSales(doc, s, months); rows.push([TRADES[s.trade], s.category, DIVISIONS[divisionOf(s)], s.kubun, s.name, s.bu, s.shocho, s.shokucho, s.kessai ?? '', s.start, s.end, s.months ?? '', ...months.map(ym => { const v = monthInfo(doc, s, ym).value; return v ? round2(v) : ''; }), Math.round(ss.ninku), ss.price || UN, ss.price ? Math.round(ss.sales) : (ss.ninku ? UN : 0)]); }
  const tots = months.map(ym => monthTotals(doc, ym, opt));
  const salesCell = x => (x.unpriced > 0 && !x.sales ? UN : Math.round(x.sales));
  for (const t of Object.keys(TRADES)) {
    for (const k of ['新築', '改修', '合計']) rows.push([TRADES[t], '', '', '', `${TRADES[t]}${k === '合計' ? '合計' : k + '計'}`, '', '', '', '', '', '', '', ...tots.map(x => round2(x[t][k]))]);
    rows.push([TRADES[t], '', '', '', `月間稼働予測（${doc.settings.estimateMode === 'fixed' ? '×22日固定' : 'カレンダー稼働日'}）`, '', '', '', '', '', '', '', ...tots.map(x => Math.round(x[t].est))]);
    if (!opt.groups || opt.groups.some(k => k.startsWith(t))) rows.push([TRADES[t], '', '', '', `${TRADES[t]}売上見込み（円・単価${cleanPrice(doc.settings.unitPrice?.[t]) ? cleanPrice(doc.settings.unitPrice[t]) + '円' : '未設定'}）`, '', '', '', '', '', '', '', ...tots.map(x => salesCell(x[t]))]);
  }
  for (const g of GROUPS) if (!opt.groups || opt.groups.includes(g.key)) rows.push([TRADES[g.trade], '', DIVISIONS[g.division], '', `${g.label} 計`, '', '', '', '', '', '', '', ...tots.map(x => round2(x.groups[g.key].value))]);
  for (const g of GROUPS) if (!opt.groups || opt.groups.includes(g.key)) rows.push([TRADES[g.trade], '', DIVISIONS[g.division], '', `${g.label} 売上見込み（円）`, '', '', '', '', '', '', '', ...tots.map(x => salesCell(x.groups[g.key]))]);
  // 人数の選択合計は職種ごと（土工と鳶工は山積みが別なので足さない）
  if (opt.groups) for (const t of Object.keys(TRADES)) { const gs = GROUPS.filter(g => g.trade === t && opt.groups.includes(g.key)); if (gs.length) rows.push([TRADES[t], '', '', '', `選択合計（${gs.map(g => g.label).join('・')}）`, '', '', '', '', '', '', '', ...tots.map(x => round2(gs.reduce((a, g) => a + x.groups[g.key].value, 0)))]); }
  // 売上見込みの選択合計も職種ごと（土工と鳶工は足さない）
  if (opt.groups) for (const t of Object.keys(TRADES)) { const gs = GROUPS.filter(g => g.trade === t && opt.groups.includes(g.key)); if (gs.length) rows.push([TRADES[t], '', '', '', `${TRADES[t]} 選択合計 売上見込み（円）`, '', '', '', '', '', '', '', ...tots.map(x => salesCell(gs.reduce((a, g) => ({ sales: a.sales + x.groups[g.key].sales, unpriced: a.unpriced + x.groups[g.key].unpriced }), { sales: 0, unpriced: 0 })))]); }
  rows.push(['', '', '', '', '会社の稼働日数', '', '', '', '', '', '', '', ...tots.map(x => x.companyWd)]);
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
export function dailyCsv(doc, opt = {}) {
  let dates = [];
  for (const ym of dailyMonths(doc)) dates = dates.concat(datesOfMonth(ym));
  const rows = [['職種', '新築/改修', '工事部', '区分', '工事名', ...dates.map(d => d.replace(/-/g, '/'))]];
  rows.push(['', '', '', '', '会社カレンダー', ...dates.map(d => (companyDay(doc, d).work ? '' : '休'))]);
  for (const s of sortedSites(doc, null, opt)) {
    rows.push([TRADES[s.trade], s.category, DIVISIONS[divisionOf(s)], s.kubun, s.name, ...dates.map(d => { const a = dailyOf(doc, s, d.slice(0, 7)); const v = a ? a[Number(d.slice(8)) - 1] : 0; return v || ''; })]);
  }
  for (const t of Object.keys(TRADES)) rows.push([TRADES[t], '', '', '', `${TRADES[t]}合計`, ...dates.map(d => dayTotals(doc, d, opt)[t] || '')]);
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
