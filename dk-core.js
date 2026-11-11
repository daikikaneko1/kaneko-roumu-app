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

const NAME_KEYS = ['id', 'no', 'name', 'short', 'trade', 'kubun', 'from', 'to', 'hasNinku', 'active', 'siteId'];
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
    master: { keisho: (doc.keisho || []).map(k => pick(k, MASTER_KEYS)), requests: doc.requests || [] },
    claims: { records: claims },
    labor: { records: labor },
    targets: { groups: doc.groups || [], common: doc.common || null },
    notes: { notes: doc.notes || {} },
  };
}
export function joinState(meta, parts) {
  const doc = { schema: meta.schema || SCHEMA, merged: meta.merged || [], updatedAt: meta.updatedAt, updatedBy: meta.updatedBy, settings: {}, keisho: [], groups: [], records: {}, notes: {}, requests: [], common: null, readable: Object.keys(parts) };
  if (parts.names) { doc.settings = parts.names.settings || {}; doc.keisho = parts.names.keisho.map(k => ({ ...k })); }
  if (parts.master) doc.requests = parts.master.requests || [];
  if (parts.master) for (const m of parts.master.keisho) { const k = doc.keisho.find(x => x.id === m.id); if (k) Object.assign(k, m); else doc.keisho.push({ ...m }); }
  for (const ds of ['claims', 'labor']) if (parts[ds]) for (const [key, r] of Object.entries(parts[ds].records)) doc.records[key] = { ...(doc.records[key] || {}), ...r };
  if (parts.targets) { doc.groups = parts.targets.groups; doc.common = parts.targets.common || null; }
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
    else if (o.type === 'merge') for (const e of o.entries) { if (e.type === 'keishoReq' || doc.merged.includes(e.id)) continue; applyFields(doc, e.key, e.fields, e.at, e.by, 'entry'); doc.merged.push(e.id); }
    else if (o.type === 'keisho') { const k = doc.keisho.find(x => x.id === o.id); if (k) Object.assign(k, o.patch); }
    else if (o.type === 'keishoAdd') { if (!doc.keisho.some(x => x.id === o.k.id)) doc.keisho.push(o.k); }
    else if (o.type === 'group') { const g = doc.groups.find(x => x.id === o.id); if (g) Object.assign(g, o.patch); }
    else if (o.type === 'groupAdd') { if (!doc.groups.some(x => x.id === o.g.id)) doc.groups.push(o.g); }
    else if (o.type === 'notes') doc.notes = { ...(doc.notes || {}), ...o.patch };
    else if (o.type === 'settings') doc.settings = { ...(doc.settings || {}), ...o.patch };
    else if (o.type === 'siteAdd') { const ss = (doc.settings.sites || []).slice(); if (!ss.some(x => x.id === o.s.id)) ss.push(o.s); doc.settings = { ...doc.settings, sites: ss }; }
    else if (o.type === 'site') doc.settings = { ...doc.settings, sites: (doc.settings.sites || []).map(x => (x.id === o.id ? { ...x, ...o.patch } : x)) };
    else if (o.type === 'common') doc.common = { ...(doc.common || {}), ...o.patch };
    // 請書追加の申請（入力用の entry）を閲覧用が承認・却下：記録を残し、取り込み済みにする（承認は keishoAdd と一緒に送る）
    else if (o.type === 'reqDecide') { if (!doc.merged.includes(o.id)) { doc.merged.push(o.id); doc.requests = [...(doc.requests || []), { id: o.id, decision: o.decision, keishoId: o.keishoId || null, at: o.when || o.at || null, by: o.by || '', req: o.req || null }]; } }
    // 'rekey' は中身を変えない（保存し直して暗号化をやり直すだけ）
  }
  return doc;
}
// まだ取り込んでいない入力を、保存せずに見える状態へ重ねる（入力用の画面・閲覧用の読み込み直後）
export function overlayEntries(doc, entries) { return applyOps(doc, [{ type: 'merge', entries: entries.filter(e => e.type !== 'keishoReq').sort((a, b) => (a.at < b.at ? -1 : 1)) }]); }

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
// ---------- 現場（settings.sites。名前だけなので入力用も読める）----------
// 1現場に請書がいくつでも。請書・合算グループの siteId が空なら最初の現場（古い画面で保存し直されても崩れない）
export const sitesOf = doc => (doc.settings && doc.settings.sites) || [];
const firstSite = doc => (sitesOf(doc)[0] || {}).id || null;
export const siteOfK = (doc, k) => k.siteId || firstSite(doc);
export const siteOfG = (doc, g) => g.siteId || firstSite(doc);
export const siteById = (doc, id) => sitesOf(doc).find(s => s.id === id) || null;
export const siteKeisho = (doc, sid, all = false) => doc.keisho.filter(k => (all || k.active !== false) && (sid == null || siteOfK(doc, k) === sid)).sort((a, b) => a.no - b.no);
// 目標単価：合算グループ・単独の請書で「共通」（common:true）なら職種ごとの共通単価（doc.common = { 鳶, 土工 }）。数字だけなら個別、空・0 は目標なし
export function effTarget(doc, x, trade) {
  if (x && x.common && doc.common && trade && doc.common[trade] != null && n0(doc.common[trade])) return n0(doc.common[trade]);
  return n0(x && x.target) || null;
}
// 集計ブロック：合算グループ（groups）＋単独管理の請書（出来高対象でグループなし）。sid で現場をしぼる
export function blocks(doc, sid = null) {
  const out = [];
  for (const g of doc.groups || []) { if (sid != null && siteOfG(doc, g) !== sid) continue; const members = groupMembers(doc, g.id).filter(k => k.taisho !== false && (sid == null || siteOfK(doc, k) === sid)); if (members.length) out.push({ type: 'group', id: g.id, name: g.name, target: effTarget(doc, g, members[0].trade), trade: members[0].trade, members, no: members[0].no, g }); }
  for (const k of doc.keisho) if (k.active !== false && k.taisho !== false && !k.group && (sid == null || siteOfK(doc, k) === sid)) out.push({ type: 'single', id: k.id, name: k.short || k.name, target: effTarget(doc, k, k.trade), trade: k.trade, members: [k], no: k.no });
  return out.sort((a, b) => a.no - b.no);
}
// 会議サマリー（報告月 R までの累計。Excel は最終行の累計＝データのある最新月までと同じ）。sid で現場をしぼる
export function summary(doc, R, sid = null) {
  const rate = (c, a) => (a == null || a === 0 ? null : c / a);
  const item = k => { const c = cumThrough(doc, k, R); return { k, amount: k.amount ?? null, cum: c.amount, rate: rate(c.amount, k.amount ?? null), cumNinku: c.ninku }; };
  const secs = blocks(doc, sid).map(b => {
    const members = b.members.map(item);
    const known = members.filter(m => m.amount != null);
    const sumAmount = known.length ? known.reduce((s, m) => s + m.amount, 0) : null;
    const sumCum = members.reduce((s, m) => s + m.cum, 0), cumNinku = members.reduce((s, m) => s + m.cumNinku, 0);
    const dk = cumNinku === 0 ? null : sumCum / cumNinku;
    return { ...b, items: members, sumAmount, sumCum, rate: rate(sumCum, sumAmount), cumNinku, dekidaka: dk, diff: dk == null || !b.target ? null : dk - b.target, achieve: dk == null || !b.target ? null : dk / b.target, eval: evalMark(dk, b.target) };
  });
  const all = siteKeisho(doc, sid).map(item);
  const trades = [...new Set(all.map(i => i.k.trade))];
  const total = all.reduce((s, i) => s + i.cum, 0);
  const share = v => (total === 0 ? 0 : v / total);
  const totals = { trades: trades.map(t => { const items = all.filter(i => i.k.trade === t); const sum = items.reduce((s, i) => s + i.cum, 0); return { trade: t, items: items.map(i => ({ ...i, share: share(i.cum) })), sum, share: share(sum) }; }), total, share: total === 0 ? 0 : 1 };
  return { R, sid, secs, totals };
}
// 現場の成績（現場カード）：累計請求（小口も含む全請書）・累計人工（出来高対象）・目標のあるブロックの出来高・目標差・達成率
export function siteResult(doc, sid, R = null) {
  const sm = summary(doc, R, sid), ks = siteKeisho(doc, sid);
  const cumNinku = ks.filter(k => k.taisho !== false).reduce((s, k) => s + cumThrough(doc, k, R).ninku, 0);
  const amount = ks.some(k => k.amount != null) ? ks.reduce((s, k) => s + n0(k.amount), 0) : null;
  return { sid, count: ks.length, amount, cum: sm.totals.total, cumNinku, secs: sm.secs, summary: sm };
}
// 会社合計：現場の合計＋職種ごとに「目標のあるブロック」を足した出来高（目標は共通単価、無ければブロックの目標）
export function companyResult(doc, sids, R = null) {
  const rs = sids.map(id => siteResult(doc, id, R));
  const cum = rs.reduce((s, r) => s + r.cum, 0), cumNinku = rs.reduce((s, r) => s + r.cumNinku, 0);
  const byTrade = {};
  for (const r of rs) for (const b of r.secs) { if (!b.target) continue; const t = byTrade[b.trade] || (byTrade[b.trade] = { trade: b.trade, cum: 0, ninku: 0, targets: new Set() }); t.cum += b.sumCum; t.ninku += b.cumNinku; t.targets.add(b.target); }
  const trades = Object.values(byTrade).map(t => { const target = doc.common && doc.common[t.trade] ? n0(doc.common[t.trade]) : t.targets.size === 1 ? [...t.targets][0] : null; const dk = t.ninku === 0 ? null : t.cum / t.ninku; return { trade: t.trade, cum: t.cum, ninku: t.ninku, dekidaka: dk, target, diff: dk == null || !target ? null : dk - target, achieve: dk == null || !target ? null : dk / target }; });
  return { sites: rs, cum, cumNinku, trades };
}

// ---------- CSV ----------
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = rows => '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function csvMonthly(doc) {
  const rows = [['現場', '請書No', '請書', '締め月', '当月請求額(税抜)', '当月投入人工', '累計請求額', '累計人工', '備考']];
  for (const k of [...doc.keisho].sort((a, b) => a.no - b.no)) for (const r of keishoSeries(doc, k)) rows.push([(siteById(doc, siteOfK(doc, k)) || {}).name || '', k.no, k.short || k.name, ymSlash(r.ym), r.amount, canRead(doc, 'labor') ? r.ninku : '', r.cumAmount, canRead(doc, 'labor') ? r.cumNinku : '', canRead(doc, 'labor') ? r.note : '']);
  return toCSV(rows);
}
export function csvSummary(doc, R, sid = null) {
  const s = summary(doc, R, sid), rows = [['報告月', ymSlash(R || '')], ...(sid ? [['現場', (siteById(doc, sid) || {}).name || '']] : []), ['区分', '請書', '請書金額', '累計請求', '消化率', '累計人工', '出来高(円/人工)', '目標単価', '差異', '評価']];
  for (const b of s.secs) {
    for (const i of b.items) rows.push([b.name, i.k.short || i.k.name, i.amount, i.cum, i.rate, i.cumNinku, '', '', '', '']);
    rows.push([b.name, b.members.length > 1 ? '合算' : '', b.sumAmount, b.sumCum, b.rate, b.cumNinku, b.dekidaka, b.target, b.diff, b.eval]);
  }
  rows.push([]); rows.push(['総請求額集計', '請書', '累計請求額', '構成比']);
  for (const t of s.totals.trades) { for (const i of t.items) rows.push(['', i.k.short || i.k.name, i.cum, i.share]); rows.push(['', t.trade + ' 合計', t.sum, t.share]); }
  rows.push(['', '総合計', s.totals.total, s.totals.share]);
  return toCSV(rows);
}

// ---------- 現場への移行（1回だけ）：現場を1つ作り、全部の請書・合算グループをその現場に。共通の目標単価も ----------
// 金額・人工の記録（請書id|月）は変えないので、数字は1円も動かない
export function sitesMigrationOps(doc, site, common) {
  if (sitesOf(doc).length) throw new Error('現場はもうあります（移行済み）');
  const ops = [{ type: 'siteAdd', s: { roumuIds: [], done: false, ...site } }];
  for (const k of doc.keisho) ops.push({ type: 'keisho', id: k.id, patch: { siteId: site.id } });
  for (const g of doc.groups || []) {
    const tr = (groupMembers(doc, g.id)[0] || {}).trade;
    ops.push({ type: 'group', id: g.id, patch: { siteId: site.id, ...(common && tr && n0(g.target) && n0(g.target) === n0(common[tr]) ? { common: true } : {}) } });
  }
  if (common) ops.push({ type: 'common', patch: common });
  return ops;
}
// 数字の指紋（移行の前後で同じか確かめる）：全記録＋集計＋サマリー＋総請求額
export function figures(doc, R = latestDataMonth(doc)) {
  const rec = Object.entries(doc.records || {}).map(([k, r]) => [k, r.amount ? r.amount.v : null, r.ninku ? r.ninku.v : null, r.note ? r.note.v : null]).filter(x => x[1] != null || x[2] != null || x[3] != null).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const sm = summary(doc, R);
  const secs = sm.secs.map(b => ({ id: b.id, members: b.members.map(k => k.id), sumAmount: b.sumAmount, sumCum: b.sumCum, cumNinku: b.cumNinku, dekidaka: b.dekidaka, target: b.target, diff: b.diff, eval: b.eval }));
  const keisho = doc.keisho.map(k => ({ id: k.id, amount: k.amount ?? null, group: k.group || null, taisho: k.taisho, active: k.active, from: k.from, to: k.to }));
  return { R, rec, secs, total: sm.totals.total, trades: sm.totals.trades.map(t => [t.trade, t.sum]), keisho };
}
