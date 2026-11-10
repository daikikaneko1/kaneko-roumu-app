// 出来高管理の計算・データ形式（画面なし。ブラウザ / Node 共通）
// Excel「出来高管理システム」の式をそのまま再現する（出来高集計・出来高会議サマリー）。
export const SCHEMA = 'kaneko-dekidaka/1';
export const ROLES = { view: '閲覧用', input: '入力用' };
// 入力用が読める範囲（config.js の dekidaka.inputScope）
//  0: 入力だけ（過去の入力・結果は読めない）
//  1: 請書金額・累計請求・消化率まで
//  2: すべて（人工・出来高 円/人工・目標差・達成率・会議サマリー）
export const SCOPES = { 0: '入力だけ', 1: '請書金額・累計請求・消化率', 2: 'すべて（出来高・目標差・達成率・会議サマリー）' };
// データの区分 → 入力用が読めるようになる範囲（この値以上の inputScope で入力用にも暗号化する）
export const DATASETS = { names: 0, master: 1, claims: 1, labor: 2, targets: 2, notes: 2 };
export const recipientRoles = (ds, scope) => ['view', ...(Number(scope) >= DATASETS[ds] ? ['input'] : [])];
export const readableDatasets = (role, scope) => Object.keys(DATASETS).filter(ds => recipientRoles(ds, scope).includes(role));
export const FIELDS = { amount: 'claims', ninku: 'labor', note: 'labor' };

const NAME_KEYS = ['id', 'no', 'name', 'short', 'trade', 'kubun', 'from', 'to', 'hasNinku', 'active'];
const MASTER_KEYS = ['id', 'sheet', 'amount', 'start', 'end', 'taisho', 'group', 'target', 'targetNote', 'note'];
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

// ---------- 状態ファイルを区分に分ける / 戻す ----------
export function splitState(doc) {
  const rec = doc.records || {}, claims = {}, labor = {};
  for (const [k, r] of Object.entries(rec)) {
    if (r.amount) claims[k] = { amount: r.amount };
    if (r.ninku || r.note) labor[k] = pick(r, ['ninku', 'note']);
  }
  return {
    names: { settings: doc.settings || {}, keisho: (doc.keisho || []).map(k => pick(k, NAME_KEYS)) },
    master: { keisho: (doc.keisho || []).map(k => pick(k, MASTER_KEYS)) },
    claims: { records: claims },
    labor: { records: labor },
    targets: { groups: doc.groups || [] },
    notes: { notes: doc.notes || {} },
  };
}
export function joinState(meta, parts) {
  const doc = { schema: meta.schema || SCHEMA, merged: meta.merged || [], updatedAt: meta.updatedAt, updatedBy: meta.updatedBy, settings: {}, keisho: [], groups: [], records: {}, notes: {}, readable: Object.keys(parts) };
  if (parts.names) { doc.settings = parts.names.settings || {}; doc.keisho = parts.names.keisho.map(k => ({ ...k })); }
  if (parts.master) for (const m of parts.master.keisho) { const k = doc.keisho.find(x => x.id === m.id); if (k) Object.assign(k, m); else doc.keisho.push({ ...m }); }
  for (const ds of ['claims', 'labor']) if (parts[ds]) for (const [key, r] of Object.entries(parts[ds].records)) doc.records[key] = { ...(doc.records[key] || {}), ...r };
  if (parts.targets) doc.groups = parts.targets.groups;
  if (parts.notes) doc.notes = parts.notes.notes;
  return doc;
}
export const canRead = (doc, ds) => !doc.readable || doc.readable.includes(ds);

// ---------- 入力（エントリ）を反映 ----------
// 1件 = { id, at, by, key:'請書id|YYYY-MM', fields:{ amount?, ninku?, note? } }。項目ごとに新しい方が勝つ。null は「消す」。
export function applyFields(doc, key, fields, at, by, src) {
  const r = doc.records[key] || (doc.records[key] = {});
  for (const [f, v] of Object.entries(fields)) {
    if (!(f in FIELDS)) continue;
    const cur = r[f];
    if (cur && cur.at && at && cur.at > at) continue; // 古い入力は上書きしない
    r[f] = { v: v === '' ? null : v, at, by: by || '', ...(src ? { src } : {}) };
  }
}
export function applyOps(base, ops) {
  const doc = structuredClone(base);
  doc.merged = doc.merged || []; doc.records = doc.records || {};
  for (const o of ops) {
    if (o.type === 'set') applyFields(doc, o.key, o.fields, o.when || o.at, o.by);
    else if (o.type === 'merge') for (const e of o.entries) { if (doc.merged.includes(e.id)) continue; applyFields(doc, e.key, e.fields, e.at, e.by, 'entry'); doc.merged.push(e.id); }
    else if (o.type === 'keisho') { const k = doc.keisho.find(x => x.id === o.id); if (k) Object.assign(k, o.patch); }
    else if (o.type === 'keishoAdd') { if (!doc.keisho.some(x => x.id === o.k.id)) doc.keisho.push(o.k); }
    else if (o.type === 'group') { const g = doc.groups.find(x => x.id === o.id); if (g) Object.assign(g, o.patch); }
    else if (o.type === 'groupAdd') { if (!doc.groups.some(x => x.id === o.g.id)) doc.groups.push(o.g); }
    else if (o.type === 'notes') doc.notes = { ...(doc.notes || {}), ...o.patch };
    else if (o.type === 'settings') doc.settings = { ...(doc.settings || {}), ...o.patch };
    // 'rekey' は中身を変えない（保存し直して暗号化をやり直すだけ）
  }
  return doc;
}
// まだ取り込んでいない入力を、保存せずに見える状態へ重ねる（入力用の画面・閲覧用の読み込み直後）
export function overlayEntries(doc, entries) { return applyOps(doc, [{ type: 'merge', entries: [...entries].sort((a, b) => (a.at < b.at ? -1 : 1)) }]); }

// ---------- 月・締め ----------
export function monthsBetween(a, b) { const out = []; let [y, m] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } } return out; }
export function prevMonth(ym) { let [y, m] = ym.split('-').map(Number); if (--m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }
export function nextMonth(ym) { let [y, m] = ym.split('-').map(Number); if (++m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; }
// 締め月（21日～翌20日 → 20日が入る月の「◯月分」）
export function closeMonthOf(date, day = 21) { const ym = date.slice(0, 7); return Number(date.slice(8, 10)) >= day ? nextMonth(ym) : ym; }
export function closeLabel(ym, day = 21) {
  const [y, m] = ym.split('-').map(Number); const p = prevMonth(ym).split('-').map(Number);
  return `${y}年${m}月分（${p[1]}/${day}〜${m}/${day - 1}）`;
}
export const ymSlash = ym => ym.replace('-', '/');

// ---------- 値 ----------
export const keyOf = (id, ym) => `${id}|${ym}`;
export function val(doc, id, ym, f) { const r = doc.records[keyOf(id, ym)]; return r && r[f] ? r[f].v ?? null : null; }
const n0 = v => (typeof v === 'number' && isFinite(v) ? v : 0);
export const keishoMonths = k => monthsBetween(k.from, k.to);
// 請書の月次シート（Excel：当月請求・当月人工・累計請求・累計人工・備考）
export function keishoSeries(doc, k) {
  let ca = 0, cn = 0;
  return keishoMonths(k).map(ym => { const amount = val(doc, k.id, ym, 'amount'), ninku = val(doc, k.id, ym, 'ninku'); ca += n0(amount); cn += n0(ninku); return { ym, amount, ninku, note: val(doc, k.id, ym, 'note'), cumAmount: ca, cumNinku: cn }; });
}
export function cumThrough(doc, k, R) {
  let a = 0, n = 0; for (const ym of keishoMonths(k)) { if (R && ym > R) break; a += n0(val(doc, k.id, ym, 'amount')); n += n0(val(doc, k.id, ym, 'ninku')); }
  return { amount: a, ninku: n };
}
export function latestDataMonth(doc) {
  let best = null;
  for (const [key, r] of Object.entries(doc.records || {})) { const ym = key.split('|')[1]; if (((r.amount && r.amount.v != null) || (r.ninku && r.ninku.v != null)) && (!best || ym > best)) best = ym; }
  return best;
}
export const groupMembers = (doc, gid) => doc.keisho.filter(k => k.group === gid && k.active !== false).sort((a, b) => a.no - b.no);
export function evalMark(d, t) { if (d == null || !t) return null; return d >= t ? '◎' : d >= t * 0.9 ? '○' : '△'; }

// 出来高集計（Excel「出来高集計」の1ブロック）
//  G=合算請求 H=合算人工 I=IF(H=0,"",G/H) J=I-目標 K=I/目標 L=累計請求 M=累計人工 N=IF(M=0,"",L/M)
export function groupSeries(doc, members, target, months) {
  let L = 0, M = 0;
  const rows = months.map(ym => {
    const per = members.map(k => ({ amount: n0(val(doc, k.id, ym, 'amount')), ninku: n0(val(doc, k.id, ym, 'ninku')) }));
    const G = per.reduce((s, p) => s + p.amount, 0), H = per.reduce((s, p) => s + p.ninku, 0);
    const I = H === 0 ? null : G / H;
    L += G; M += H;
    return { ym, per, G, H, I, J: I == null || !target ? null : I - target, K: I == null || !target ? null : I / target, L, M, N: M === 0 ? null : L / M };
  });
  const tot = { per: members.map((_, i) => ({ amount: rows.reduce((s, r) => s + r.per[i].amount, 0), ninku: rows.reduce((s, r) => s + r.per[i].ninku, 0) })) };
  tot.G = rows.reduce((s, r) => s + r.G, 0); tot.H = rows.reduce((s, r) => s + r.H, 0); tot.I = tot.H === 0 ? null : tot.G / tot.H;
  return { rows, tot };
}
// 集計ブロック：合算グループ（groups）＋単独管理の請書（出来高対象でグループなし）
export function blocks(doc) {
  const out = [];
  for (const g of doc.groups || []) { const members = groupMembers(doc, g.id).filter(k => k.taisho !== false); if (members.length) out.push({ type: 'group', id: g.id, name: g.name, target: n0(g.target) || null, members, no: members[0].no, g }); }
  for (const k of doc.keisho) if (k.active !== false && k.taisho !== false && !k.group) out.push({ type: 'single', id: k.id, name: k.short || k.name, target: n0(k.target) || null, members: [k], no: k.no });
  return out.sort((a, b) => a.no - b.no);
}
// 会議サマリー（報告月 R までの累計。Excel は最終行の累計＝データのある最新月までと同じ）
export function summary(doc, R) {
  const rate = (c, a) => (a == null || a === 0 ? null : c / a);
  const item = k => { const c = cumThrough(doc, k, R); return { k, amount: k.amount ?? null, cum: c.amount, rate: rate(c.amount, k.amount ?? null), cumNinku: c.ninku }; };
  const secs = blocks(doc).map(b => {
    const members = b.members.map(item);
    const known = members.filter(m => m.amount != null);
    const sumAmount = known.length ? known.reduce((s, m) => s + m.amount, 0) : null;
    const sumCum = members.reduce((s, m) => s + m.cum, 0), cumNinku = members.reduce((s, m) => s + m.cumNinku, 0);
    const dk = cumNinku === 0 ? null : sumCum / cumNinku;
    return { ...b, items: members, sumAmount, sumCum, rate: rate(sumCum, sumAmount), cumNinku, dekidaka: dk, diff: dk == null || !b.target ? null : dk - b.target, eval: evalMark(dk, b.target) };
  });
  const all = doc.keisho.filter(k => k.active !== false).sort((a, b) => a.no - b.no).map(item);
  const trades = [...new Set(all.map(i => i.k.trade))];
  const total = all.reduce((s, i) => s + i.cum, 0);
  const share = v => (total === 0 ? 0 : v / total);
  const totals = { trades: trades.map(t => { const items = all.filter(i => i.k.trade === t); const sum = items.reduce((s, i) => s + i.cum, 0); return { trade: t, items: items.map(i => ({ ...i, share: share(i.cum) })), sum, share: share(sum) }; }), total, share: total === 0 ? 0 : 1 };
  return { R, secs, totals };
}

// ---------- CSV ----------
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = rows => '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function csvMonthly(doc) {
  const rows = [['請書No', '請書', '締め月', '当月請求額(税抜)', '当月投入人工', '累計請求額', '累計人工', '備考']];
  for (const k of [...doc.keisho].sort((a, b) => a.no - b.no)) for (const r of keishoSeries(doc, k)) rows.push([k.no, k.short || k.name, ymSlash(r.ym), r.amount, canRead(doc, 'labor') ? r.ninku : '', r.cumAmount, canRead(doc, 'labor') ? r.cumNinku : '', canRead(doc, 'labor') ? r.note : '']);
  return toCSV(rows);
}
export function csvSummary(doc, R) {
  const s = summary(doc, R), rows = [['報告月', ymSlash(R || '')], ['区分', '請書', '請書金額', '累計請求', '消化率', '累計人工', '出来高(円/人工)', '目標単価', '差異', '評価']];
  for (const b of s.secs) {
    for (const i of b.items) rows.push([b.name, i.k.short || i.k.name, i.amount, i.cum, i.rate, i.cumNinku, '', '', '', '']);
    rows.push([b.name, b.members.length > 1 ? '合算' : '', b.sumAmount, b.sumCum, b.rate, b.cumNinku, b.dekidaka, b.target, b.diff, b.eval]);
  }
  rows.push([]); rows.push(['総請求額集計', '請書', '累計請求額', '構成比']);
  for (const t of s.totals.trades) { for (const i of t.items) rows.push(['', i.k.short || i.k.name, i.cum, i.share]); rows.push(['', t.trade + ' 合計', t.sum, t.share]); }
  rows.push(['', '総合計', s.totals.total, s.totals.share]);
  return toCSV(rows);
}
