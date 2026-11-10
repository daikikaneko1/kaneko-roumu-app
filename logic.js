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
  return companyDay(doc, date);
}
export function workingDates(doc, site, ym) { return datesOfMonth(ym).filter(d => siteDay(doc, site, d).work); }
export function workingDays(doc, site, ym) { return workingDates(doc, site, ym).length; }

// ---- 1カ年(日別)ウィンドウ ----
export function inWindow(doc, ym) { return fyOf(ym) === doc.settings.dailyFY; }

// 月の値：ウィンドウ内は日別が正（平均＝人工÷稼働日）、外は月の値そのもの
export function monthInfo(doc, site, ym) {
  if (inWindow(doc, ym)) {
    const arr = (site.daily && site.daily[ym]) || [];
    const ninku = arr.reduce((a, b) => a + (Number(b) || 0), 0);
    const wd = workingDays(doc, site, ym);
    return { daily: true, ninku, wd, value: wd ? ninku / wd : 0, edited: !!(site.editedMonths && site.editedMonths[ym]) };
  }
  const value = (site.monthly && site.monthly[ym]) || 0;
  const wd = workingDays(doc, null, ym);
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
const SITE_FIELDS = ['trade', 'category', 'division', 'kubun', 'prevKubun', 'name', 'bu', 'shocho', 'shokucho', 'start', 'end', 'months', 'note', 'order'];
function cleanArr(arr) { return arr.some(v => v) ? arr : undefined; }

export function applyOp(doc, op) {
  const site = op.id ? doc.sites.find(s => s.id === op.id) : null;
  const touch = s => { s.updatedAt = op.at || s.updatedAt; };
  switch (op.t) {
    case 'site': {
      let s = doc.sites.find(x => x.id === op.site.id);
      if (!s) { s = { id: op.site.id, monthly: {}, daily: {}, dayOverrides: {}, editedMonths: {} }; doc.sites.push(s); }
      for (const k of SITE_FIELDS) if (k in op.site) s[k] = op.site[k];
      touch(s); break;
    }
    case 'delSite': doc.sites = doc.sites.filter(s => s.id !== op.id); break;
    case 'day': case 'days': {
      if (!site) break;
      const dates = op.t === 'day' ? [op.date] : op.dates;
      site.daily = site.daily || {}; site.editedMonths = site.editedMonths || {};
      for (const d of dates) {
        const ym = d.slice(0, 7);
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
    case 'roll': rollWindow(doc, op.fy); break;
    default: break;
  }
  return doc;
}
export function applyOps(doc, ops) { const d = structuredClone(doc); for (const op of ops) applyOp(d, op); return d; }

// 1カ年ウィンドウを新しい年度へ：出ていく年度は月平均を月の値として固定、入ってくる年度は月の値を日に展開
export function rollWindow(doc, fy) {
  const old = doc.settings.dailyFY;
  if (fy === old) return doc;
  for (const s of doc.sites) {
    s.monthly = s.monthly || {}; s.daily = s.daily || {};
    for (const ym of fyMonths(old)) { const v = round2(monthInfo(doc, s, ym).value); if (v) s.monthly[ym] = v; else delete s.monthly[ym]; }
  }
  doc.settings.dailyFY = fy;
  for (const s of doc.sites) {
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
  for (const t of Object.keys(TRADES)) r[t] = { 新築: 0, 改修: 0, 合計: 0, ninku: 0 };
  r.groups = {}; for (const g of GROUPS) r.groups[g.key] = { value: 0, ninku: 0 };
  for (const s of doc.sites) {
    if (!shown(s, opt)) continue;
    const mi = monthInfo(doc, s, ym);
    const t = r[s.trade]; if (!t) continue;
    t[s.category === '改修' ? '改修' : '新築'] += mi.value; t.合計 += mi.value; t.ninku += mi.ninku;
    const g = r.groups[groupKey(s)]; if (g) { g.value += mi.value; g.ninku += mi.ninku; }
  }
  const { m } = parseYm(ym);
  const fixed = (doc.settings.fixedDays && doc.settings.fixedDays[m]) || 22;
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
// 通期（startFY から years 年分）の月一覧
export function periodMonths(startFY, years) { let a = []; for (let i = 0; i < years; i++) a = a.concat(fyMonths(startFY + i)); return a; }
// 選んだグループの月別山積み（積み上げ用）と合計
export function groupSeries(doc, months, groups, opt = {}) {
  const tots = months.map(ym => monthTotals(doc, ym, opt));
  const series = GROUPS.filter(g => groups.includes(g.key)).map(g => ({ ...g, values: tots.map(t => t.groups[g.key].value), est: tots.map(t => t.groups[g.key].est), estFixed: tots.map(t => t.groups[g.key].estFixed), estCalendar: tots.map(t => t.groups[g.key].estCalendar) }));
  const sum = k => months.map((_, i) => series.reduce((a, s) => a + s[k][i], 0));
  return { months, series, total: sum('values'), est: sum('est'), estFixed: sum('estFixed'), estCalendar: sum('estCalendar'), companyWd: tots.map(t => t.companyWd), fixedDays: tots.map(t => t.fixedDays) };
}
export function dayTotals(doc, date, opt = {}) {
  const ym = date.slice(0, 7), i = Number(date.slice(8)) - 1;
  const r = { doko: 0, tobi: 0 };
  if (!inWindow(doc, ym)) return r;
  for (const s of doc.sites) { if (!shown(s, opt)) continue; const a = s.daily && s.daily[ym]; if (a && r[s.trade] !== undefined) r[s.trade] += Number(a[i]) || 0; }
  return r;
}

// ---- CSV（Excel で開けるよう BOM 付き UTF-8） ----
const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function sortedSites(doc, trade, opt = {}) {
  return doc.sites.filter(s => (!trade || s.trade === trade) && shown(s, opt))
    .sort((a, b) => (a.trade === b.trade ? 0 : a.trade === 'doko' ? -1 : 1) || (a.category === b.category ? 0 : a.category === '新築' ? -1 : 1) || (a.order ?? 0) - (b.order ?? 0));
}
export function monthlyCsv(doc, opt = {}) {
  const months = allMonths(doc);
  const head = ['職種', '新築/改修', '工事部', '区分', '工事名', '部', '所長', '職長', '工期(始)', '工期(終)', '月数', ...months.map(ym => ym.replace('-', '/'))];
  const rows = [head];
  for (const s of sortedSites(doc, null, opt)) rows.push([TRADES[s.trade], s.category, DIVISIONS[divisionOf(s)], s.kubun, s.name, s.bu, s.shocho, s.shokucho, s.start, s.end, s.months ?? '', ...months.map(ym => { const v = monthInfo(doc, s, ym).value; return v ? round2(v) : ''; })]);
  const tots = months.map(ym => monthTotals(doc, ym, opt));
  for (const t of Object.keys(TRADES)) {
    for (const k of ['新築', '改修', '合計']) rows.push([TRADES[t], '', '', '', `${TRADES[t]}${k === '合計' ? '合計' : k + '計'}`, '', '', '', '', '', '', ...tots.map(x => round2(x[t][k]))]);
    rows.push([TRADES[t], '', '', '', `月間稼働予測（${doc.settings.estimateMode === 'fixed' ? '×22日固定' : 'カレンダー稼働日'}）`, '', '', '', '', '', '', ...tots.map(x => Math.round(x[t].est))]);
  }
  for (const g of GROUPS) if (!opt.groups || opt.groups.includes(g.key)) rows.push([TRADES[g.trade], '', DIVISIONS[g.division], '', `${g.label} 計`, '', '', '', '', '', '', ...tots.map(x => round2(x.groups[g.key].value))]);
  if (opt.groups) rows.push(['', '', '', '', `選択合計（${opt.groups.map(k => GROUPS.find(g => g.key === k)?.label).join('・')}）`, '', '', '', '', '', '', ...tots.map(x => round2(GROUPS.reduce((a, g) => a + (opt.groups.includes(g.key) ? x.groups[g.key].value : 0), 0)))]);
  rows.push(['', '', '', '', '会社の稼働日数', '', '', '', '', '', '', ...tots.map(x => x.companyWd)]);
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
export function dailyCsv(doc, opt = {}) {
  const fy = doc.settings.dailyFY; let dates = [];
  for (const ym of fyMonths(fy)) dates = dates.concat(datesOfMonth(ym));
  const rows = [['職種', '新築/改修', '工事部', '区分', '工事名', ...dates.map(d => d.slice(5).replace('-', '/'))]];
  rows.push(['', '', '', '', '会社カレンダー', ...dates.map(d => (companyDay(doc, d).work ? '' : '休'))]);
  for (const s of sortedSites(doc, null, opt)) {
    rows.push([TRADES[s.trade], s.category, DIVISIONS[divisionOf(s)], s.kubun, s.name, ...dates.map(d => { const a = s.daily && s.daily[d.slice(0, 7)]; const v = a ? a[Number(d.slice(8)) - 1] : 0; return v || ''; })]);
  }
  for (const t of Object.keys(TRADES)) rows.push([TRADES[t], '', '', '', `${TRADES[t]}合計`, ...dates.map(d => dayTotals(doc, d, opt)[t] || '')]);
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
