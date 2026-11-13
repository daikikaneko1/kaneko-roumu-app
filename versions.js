// 山積みの「版」（毎月1日に残す写し）— 版の名前・比較（差分）・工期のずれ・推移グラフ用の計算
// ブラウザ / Node 共通・副作用なし（GitHub の読み書きは store.js / app.js）
import * as L from './logic.js';

export const VERSION_DIR = 'data/versions';
export const VERSION_SCHEMA = 'kaneko-roumu-version/1';
export const CURRENT = 'now'; // 「現在（いまのデータ）」を表すキー
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isYm = s => YM_RE.test(String(s || ''));
export const versionPath = ym => { if (!isYm(ym)) throw new Error('bad version ' + ym); return `${VERSION_DIR}/${ym}.json`; };
// ファイル名 → 版（YYYY-MM）。版のファイルでなければ null
export function versionFromName(name) { const m = /^(\d{4}-\d{2})\.json$/.exec(String(name || '')); return m && isYm(m[1]) ? m[1] : null; }
// ディレクトリ一覧（GitHub contents API の配列）→ 版の一覧（古い順）
export function versionsFromListing(items) { return [...new Set((items || []).filter(x => !x.type || x.type === 'file').map(x => versionFromName(x.name)).filter(Boolean))].sort(); }
export function versionLabel(k) { if (k === CURRENT) return '現在'; const { y, m } = L.parseYm(k); return `${y}年${m}月版`; }

// ---- 日本時間の月・月の境目 ----
const jst = d => new Date(new Date(d).getTime() + 9 * 3600e3);
export const jstYm = (d = new Date()) => jst(d).toISOString().slice(0, 7);
export const jstDate = (d = new Date()) => jst(d).toISOString().slice(0, 10);
// 定期実行（UTC の cron）で動いた時刻 → 保存する版。日本時間の1日（遅れたとき用に2日も）だけ版を返す。それ以外は null
// 例：UTC 2026-11-30 15:05 → 日本時間 12/1 0:05 → '2026-12'。UTC 2026-12-30 15:05（日本時間 12/31）→ null
export function scheduledVersionYm(d) { const j = jst(d), day = j.getUTCDate(); return day === 1 || day === 2 ? j.toISOString().slice(0, 7) : null; }
// 版を作るべきか：その月の版がまだ無いときだけ（上書きしない）
export const needsVersion = (list, ym) => isYm(ym) && !(list || []).includes(ym);

// 版のファイルの中身（roumu.json の写し＋メタデータ）
export function makeVersion(doc, ym, { savedAt = new Date().toISOString(), savedBy = '', source = {} } = {}) {
  if (!isYm(ym)) throw new Error('bad version ' + ym);
  return { schema: VERSION_SCHEMA, version: ym, savedAt, savedBy, source: { path: 'data/roumu.json', ...source }, data: structuredClone(doc) };
}

// ---- 版の数字（現場×月）：版はその月の1日時点の見え方で計算（日別の窓もその月から12か月先） ----
const asOfOf = k => (k === CURRENT ? null : k + '-01');
// doc を「asOf の日」に見たときの 現場ごとの 月の値（人/日）と人工
export function siteMatrix(doc, key = CURRENT) {
  return L.withToday(asOfOf(key), () => {
    const months = L.allMonths(doc);
    const sites = L.sortedSites(doc, null, { includeDone: true }).map(s => {
      const values = {}, ninku = {};
      for (const ym of months) { const mi = L.monthInfo(doc, s, ym); if (mi.value) values[ym] = mi.value; if (mi.ninku) ninku[ym] = mi.ninku; }
      return { id: s.id, name: s.name, trade: s.trade, category: s.category, kubun: s.kubun, done: L.isDone(s), values, ninku };
    });
    return { key, months, sites };
  });
}
export const normName = n => String(n || '').normalize('NFKC').replace(/\s+/g, '').trim();
// 表示の行：土工・鳶工はその職種の現場（id でつなぐ）。合計は同じ工事名の土工＋鳶工を1行にまとめる
export function rowsOf(mat, mode) {
  if (mode !== 'all') return mat.sites.filter(s => s.trade === mode).map(s => ({ key: s.id, name: s.name, trades: [s.trade], done: s.done, kubun: s.kubun, values: s.values, ninku: s.ninku }));
  const m = new Map();
  for (const s of mat.sites) {
    const k = normName(s.name); let r = m.get(k);
    if (!r) { r = { key: 'n:' + k, name: s.name, trades: [], done: true, kubun: s.kubun, values: {}, ninku: {} }; m.set(k, r); }
    if (!r.trades.includes(s.trade)) r.trades.push(s.trade);
    r.done = r.done && s.done;
    for (const [ym, v] of Object.entries(s.values)) r.values[ym] = (r.values[ym] || 0) + v;
    for (const [ym, v] of Object.entries(s.ninku)) r.ninku[ym] = (r.ninku[ym] || 0) + v;
  }
  return [...m.values()];
}
const EPS = 0.05; // 0.1人/日 未満の違いは「変わらない」
export const roundD = v => Math.round(v * 10) / 10;
// 差の表示：+3 / −2 / +0.5（マイナスは全角でなく「−」U+2212）
export function fmtDiff(d) { const r = roundD(d); if (Math.abs(r) < EPS) return ''; const a = Math.abs(r), t = Number.isInteger(a) ? String(a) : a.toFixed(1); return (r > 0 ? '+' : '−') + t; }
const monthsBetween = (a, b) => { const x = L.parseYm(a), y = L.parseYm(b); return (y.y - x.y) * 12 + (y.m - x.m); };
export function ymJP(ym) { const { y, m } = L.parseYm(ym); return `${y}年${m}月`; }
function pairLabel(a, b) { const x = L.parseYm(a), y = L.parseYm(b); return x.y === y.y ? `${x.y}年${x.m}月→${y.m}月` : `${x.y}年${x.m}月→${y.y}年${y.m}月`; }
// 人数がある最初と最後の月
export function span(values, months) { const on = months.filter(ym => (values[ym] || 0) > 0.005); return on.length ? { start: on[0], end: on[on.length - 1] } : null; }
// 工期のずれ（人数 > 0 の最初の月・最後の月で判断）
export function scheduleShift(aVals, bVals, months) {
  const a = aVals ? span(aVals, months) : null, b = bVals ? span(bVals, months) : null;
  const r = { a, b, start: 0, end: 0, texts: [] };
  if (!a && !b) return r;
  if (!a) { r.texts.push(`人数が入った（${ymJP(b.start)}〜${ymJP(b.end)}）`); r.kind = 'new'; return r; }
  if (!b) { r.texts.push('人数が0になった'); r.kind = 'gone'; return r; }
  r.start = monthsBetween(a.start, b.start); r.end = monthsBetween(a.end, b.end);
  if (r.start) r.texts.push(`開始 ${pairLabel(a.start, b.start)}（${Math.abs(r.start)}か月${r.start > 0 ? '遅れ' : '前倒し'}）`);
  if (r.end) r.texts.push(`終了 ${pairLabel(a.end, b.end)}（${Math.abs(r.end)}か月${r.end > 0 ? '延長' : '前倒し'}）`);
  return r;
}
// 2つの版の比較（月ごと）。A＝前、B＝後。cells の d＝B−A（人/日）
export function diffMonthly(matA, matB, mode) {
  const months = [...new Set([...matA.months, ...matB.months])].sort();
  const ra = rowsOf(matA, mode), rb = rowsOf(matB, mode);
  const ma = new Map(ra.map(r => [r.key, r])), keys = [...rb.map(r => r.key), ...ra.filter(r => !rb.some(x => x.key === r.key)).map(r => r.key)];
  const mb = new Map(rb.map(r => [r.key, r]));
  const rows = keys.map(k => {
    const a = ma.get(k), b = mb.get(k), ref = b || a;
    const cells = months.map(ym => { const av = a ? a.values[ym] || 0 : 0, bv = b ? b.values[ym] || 0 : 0, d = roundD(bv - av); return { ym, a: av, b: bv, d: Math.abs(d) < EPS ? 0 : d }; });
    const nA = a ? Object.values(a.ninku).reduce((x, y) => x + y, 0) : 0, nB = b ? Object.values(b.ninku).reduce((x, y) => x + y, 0) : 0;
    const status = !a ? 'added' : !b ? 'removed' : '';
    const shift = a && b ? scheduleShift(a.values, b.values, months) : { start: 0, end: 0, texts: [] }; // 新規・削除はバッジで示す
    const nChanged = cells.filter(c => c.d).length;
    return { key: k, name: ref.name, trades: ref.trades, done: ref.done, kubun: ref.kubun, status, shift, cells, nChanged, ninkuA: nA, ninkuB: nB, changed: !!(status || nChanged || shift.start || shift.end) };
  });
  const totals = months.map((ym, i) => { const a = rows.reduce((x, r) => x + r.cells[i].a, 0), b = rows.reduce((x, r) => x + r.cells[i].b, 0), d = roundD(b - a); return { ym, a, b, d: Math.abs(d) < EPS ? 0 : d }; });
  const ninkuA = rows.reduce((x, r) => x + r.ninkuA, 0), ninkuB = rows.reduce((x, r) => x + r.ninkuB, 0);
  return { months, rows, totals, ninkuA, ninkuB, counts: { changed: rows.filter(r => r.changed).length, unchanged: rows.filter(r => !r.changed).length, added: rows.filter(r => r.status === 'added').length, removed: rows.filter(r => r.status === 'removed').length, shifted: rows.filter(r => r.shift.start || r.shift.end).length } };
}
// 年度ごとの変わったマスの数（年度タブの印）
export function changesByFY(diff) { const o = {}; for (const r of diff.rows) for (const c of r.cells) if (c.d) { const fy = L.fyOf(c.ym); o[fy] = (o[fy] || 0) + 1; } return o; }

// ---- 日別の比較（両方の版で日別がある月だけ） ----
export function dailyMonthsOf(doc, key) { return L.withToday(asOfOf(key), () => L.dailyMonths(doc)); }
export function commonDailyMonths(docA, keyA, docB, keyB) { const b = new Set(dailyMonthsOf(docB, keyB)); return dailyMonthsOf(docA, keyA).filter(ym => b.has(ym)); }
function dailyRows(doc, key, ym, mode) {
  return L.withToday(asOfOf(key), () => {
    const n = L.daysInMonth(ym), out = new Map();
    for (const s of L.sortedSites(doc, mode === 'all' ? null : mode, { includeDone: true })) {
      const k = mode === 'all' ? 'n:' + normName(s.name) : s.id;
      const arr = L.inWindow(doc, ym) ? L.dailyOf(doc, s, ym) : [];
      let r = out.get(k); if (!r) { r = { key: k, name: s.name, trades: [], done: L.isDone(s), days: new Array(n).fill(0) }; out.set(k, r); }
      if (!r.trades.includes(s.trade)) r.trades.push(s.trade);
      for (let i = 0; i < n; i++) r.days[i] += Number(arr[i]) || 0;
    }
    return out;
  });
}
export function diffDaily(docA, keyA, docB, keyB, ym, mode) {
  const ra = dailyRows(docA, keyA, ym, mode), rb = dailyRows(docB, keyB, ym, mode), n = L.daysInMonth(ym);
  const keys = [...rb.keys(), ...[...ra.keys()].filter(k => !rb.has(k))];
  const rows = keys.map(k => {
    const a = ra.get(k), b = rb.get(k), ref = b || a;
    const cells = Array.from({ length: n }, (_, i) => { const av = a ? a.days[i] : 0, bv = b ? b.days[i] : 0; return { day: i + 1, a: av, b: bv, d: bv - av }; });
    const sumA = cells.reduce((x, c) => x + c.a, 0), sumB = cells.reduce((x, c) => x + c.b, 0);
    return { key: k, name: ref.name, trades: ref.trades, done: ref.done, status: !a ? 'added' : !b ? 'removed' : '', cells, sumA, sumB, changed: !a || !b || cells.some(c => c.d) };
  });
  const totals = Array.from({ length: n }, (_, i) => { const a = rows.reduce((x, r) => x + r.cells[i].a, 0), b = rows.reduce((x, r) => x + r.cells[i].b, 0); return { day: i + 1, a, b, d: b - a }; });
  return { ym, rows, totals, counts: { changed: rows.filter(r => r.changed).length, unchanged: rows.filter(r => !r.changed).length } };
}

// ---- 推移グラフ用 ----
export const ALL = '__all__';
// 現場の選択肢（どの版にも出てくる現場。新しい版の名前を使う）
export function sitePicks(mats, mode) {
  const m = new Map();
  for (const mat of mats) for (const r of rowsOf(mat, mode)) m.set(r.key, r.name);
  return [...m.entries()].map(([key, name]) => ({ key, name }));
}
// 版ごとの 計画線（月→人/日）と 人工合計。key＝ALL なら全現場の合計
export function trendSeries(mats, mode, key) {
  return mats.map(mat => {
    const rows = rowsOf(mat, mode).filter(r => key === ALL || r.key === key);
    const values = {}, ninku = {};
    for (const r of rows) { for (const [ym, v] of Object.entries(r.values)) values[ym] = (values[ym] || 0) + v; for (const [ym, v] of Object.entries(r.ninku)) ninku[ym] = (ninku[ym] || 0) + v; }
    return { key: mat.key, label: versionLabel(mat.key), values, ninkuTotal: Object.values(ninku).reduce((a, b) => a + b, 0), present: rows.length > 0 };
  });
}
// グラフの月の範囲：どれかの版で人数がある最初〜最後の月（前後1か月の余白、範囲は全部の月の中）
export function trendMonths(series, months) {
  const on = months.filter(ym => series.some(s => (s.values[ym] || 0) > 0.005));
  if (!on.length) return [];
  const i0 = Math.max(0, months.indexOf(on[0]) - 1), i1 = Math.min(months.length - 1, months.indexOf(on[on.length - 1]) + 1);
  return months.slice(i0, i1 + 1);
}

// ---- 体験モード用の架空の版（デモデータから作る。本番では使わない） ----
function shiftMonthly(s, n) { const o = {}; for (const [ym, v] of Object.entries(s.monthly || {})) o[L.addMonths(ym, n)] = v; s.monthly = o; s.daily = {}; s.editedMonths = {}; }
export function demoVersions(doc, nowYm) {
  const keys = [L.addMonths(nowYm, -3), L.addMonths(nowYm, -2), L.addMonths(nowYm, -1), nowYm];
  const out = {};
  keys.forEach((ym, k) => {
    const back = keys.length - 1 - k; // 0＝最新の版
    const d = structuredClone(doc);
    const S = id => d.sites.find(s => s.id === id);
    // 最新の版と「現在」の違い：1現場だけ今月の人数が違う
    if (back === 0 && S('s005')) { const s = S('s005'); const ym2 = L.addMonths(nowYm, 2); s.monthly[ym2] = Math.max(0, (s.monthly[ym2] || 0) - 1); s.daily = {}; s.editedMonths = {}; }
    if (back > 0) {
      if (S('s001')) shiftMonthly(S('s001'), -Math.min(back, 2));       // 開始が遅れていった
      if (S('s014')) { const s = S('s014'); const ks = Object.keys(s.monthly).sort(); for (const x of ks.slice(-back * 2)) delete s.monthly[x]; s.daily = {}; s.editedMonths = {}; } // 終了が延びていった
      if (S('s008')) { const s = S('s008'); for (const x of Object.keys(s.monthly)) s.monthly[x] = Math.max(0, s.monthly[x] - back); s.daily = {}; s.editedMonths = {}; } // 人数が増えていった
      if (S('s023')) { const s = S('s023'); for (const x of Object.keys(s.monthly)) if (s.monthly[x]) s.monthly[x] = L.round2(s.monthly[x] + back); s.daily = {}; s.editedMonths = {}; } // 人数が減った
      if (S('s020')) d.sites = d.sites.filter(s => s.id !== 's020'); // 新しく入った現場
      if (back >= 1) d.sites.push({ id: 's099', trade: 'tobi', category: '新築', kubun: '営', name: 'サンプル現場99（見送り）', order: 99, monthly: Object.fromEntries([3, 4, 5, 6, 7, 8].map(i => [L.addMonths(nowYm, i), 4])), daily: {}, dayOverrides: {}, editedMonths: {} }); // なくなった現場
    }
    out[ym] = makeVersion(d, ym, { savedAt: `${ym}-01T00:05:00+09:00`, savedBy: '体験用（架空）' });
  });
  return out;
}
