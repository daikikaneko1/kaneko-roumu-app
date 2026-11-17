// パトロール履歴：カレンダーの予定 → 現場ごとの回数（ブラウザ / Node 共通・副作用なし）
// ルール：パトロール・巡回・PT か現場名を含む予定。団体パトロール・会社行事は数えない。グレー（colorId 8）は行っていない。
// 当てはまりがはっきりしないもの（現場が2つ以上・似ているだけ・パトロールか分からない）は数えずに「要確認」へ。勝手に決めない
export const SCHEMA = 'kaneko-patrol/1';
export const PATROL_RE = /パトロール|巡回|(?<![A-Za-zＡ-Ｚａ-ｚ])(PT|ＰＴ)(?![A-Za-zＡ-Ｚａ-ｚ])/;
export const GROUP_RE = /協力会|支部|分科会|帯同|合同パトロール|役員パトロール|役員PT|安全協議会|協同組合/;
export const EVENT_RE = /ゴルフ|⛳|コンペ|大会|懇親|総会|例会|忘年会|新年会|暑気払い|慰安旅行|研修|カップ|CUP|表彰|納会/i;
export const UNSURE_RE = /謝罪|式|組立|見学|キックオフ|監督署|打ち合わせ|打合せ|調査|お祝い|祝い|挨拶|会食|ご飯|面接|立会|MTG|会議/;
export const GREY = '8'; // Google カレンダーの「グラファイト」
export const REASONS = { grey: 'グレー（行っていない）', group: '団体のパトロール', event: '会社・団体の行事', manual: '手で外した', dup: '同じ日の2件目', rule: '除外ルール' };
export const CATEGORIES = ['新築', '改修', '']; // '' ＝区分未確認（目標の対象にしない）
export const DEFAULT_SETTINGS = () => ({ aliases: {}, overrides: {}, special: [{ id: 'nenmatsu-2026', label: '年末特別目標', start: '2026-11-15', end: '2026-12-31', target: 3, category: '新築' }], monthlyTarget: 2, noTarget: [],
  extraSites: [], // パトロール専用の現場（山積みに無い）：{ name, category: 新築|改修|'', team, done, note }
  merge: {},      // 現場をまとめる：{ まとめられる現場キー: まとめ先キー }
  rules: [],      // 予定名のルール：{ id, patterns: [文字], action: 'exclude'|'ask', label }
  teams: {},      // 現場キー → チーム・元方など（自由記入）
});

// 文字をそろえる（全角半角・空白・かっこ）
export function norm(s) { return String(s ?? '').normalize('NFKC').replace(/[\s　]/g, '').replace(/[()（）［］\[\]【】「」]/g, '').replace(/[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u200D]/gu, ''); }
export const fyOf = date => { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); return m >= 4 ? y : y - 1; };
export const fyMonths = fy => Array.from({ length: 12 }, (_, i) => { const m = 4 + i; return m <= 12 ? `${fy}-${String(m).padStart(2, '0')}` : `${fy + 1}-${String(m - 12).padStart(2, '0')}`; });

// 山積みの現場一覧 → パトロールの現場（同じ名前の土工・鳶工はひとつに）。改修も入れる（目標の赤は新築だけ）
export function buildSites(roumu, settings = {}) {
  const m = new Map();
  for (const s of (roumu && roumu.sites) || []) {
    const key = norm(s.name); if (!key) continue;
    let x = m.get(key); if (!x) { x = { key, name: s.name, category: s.category === '改修' ? '改修' : '新築', trades: [], ids: [], done: true }; m.set(key, x); }
    if (s.category !== '改修') x.category = '新築';
    if (!x.trades.includes(s.trade)) x.trades.push(s.trade); x.ids.push(s.id);
    if (s.kubun !== '竣') x.done = false;
  }
  // パトロール専用の現場（山積みには入れない）
  for (const e of settings.extraSites || []) {
    const key = norm(e.name); if (!key || m.has(key)) continue;
    m.set(key, { key, name: e.name, category: CATEGORIES.includes(e.category) ? e.category : '', trades: [], ids: [], done: !!e.done, extra: true, note: e.note || '' });
  }
  // まとめ（例：同じ現場の土工名・鳶名が違うとき）。まとめられた名前も当てはまりに使う
  for (const [from, to] of Object.entries(settings.merge || {})) {
    const a = m.get(from), b = m.get(to); if (!a || !b || a === b) continue;
    for (const t of a.trades) if (!b.trades.includes(t)) b.trades.push(t);
    b.ids.push(...a.ids); b.done = b.done && a.done; if (a.category === '新築') b.category = '新築';
    b.alt = [...(b.alt || []), a.key, ...(a.alt || [])]; b.mergedNames = [...(b.mergedNames || []), a.name]; m.delete(from);
  }
  for (const x of m.values()) x.team = (settings.teams || {})[x.key] || (settings.extraSites || []).find(e => norm(e.name) === x.key)?.team || '';
  return [...m.values()];
}
const bigrams = s => { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; };
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
export function similarity(title, name) { const b = bigrams(title); if (b.length < 2) return 0; const n = new Set(bigrams(name)); return b.filter(x => n.has(x)).length / b.length; }
// 現場名との当てはまり：別名（いちばん長く当たった別名が優先）→ 現場名が予定に入っている → 予定名（4文字以上）が現場名に入っている
export function matchSites(ev, sites, aliases = {}) {
  const title = norm(ev.title), text = norm([ev.title, ev.location].join(' ')), hit = new Map(), ali = [];
  for (const s of sites) {
    let best = 0, bestA = '';
    for (const a of aliases[s.key] || []) { const na = norm(a); if (na.length >= 2 && text.includes(na) && na.length > best) { best = na.length; bestA = a; } }
    if (best) { ali.push({ key: s.key, how: '別名「' + bestA + '」', len: best }); continue; }
    for (const k of [s.key, ...(s.alt || [])]) {
      if (!hit.has(s.key) && text.includes(k)) hit.set(s.key, '現場名');
      if (!hit.has(s.key) && title.length >= 4 && k.includes(title)) hit.set(s.key, '現場名の一部');
    }
  }
  if (ali.length) { const L = Math.max(...ali.map(x => x.len)); return ali.filter(x => x.len === L).map(({ key, how }) => ({ key, how })); }
  return [...hit.entries()].map(([key, how]) => ({ key, how }));
}
// 予定名のルール（除外・要確認）。いちばん先に見る
export function ruleOf(ev, rules = []) {
  const t = norm(ev.title);
  return rules.find(r => (r.patterns || []).some(p => norm(p).length >= 2 && t.includes(norm(p))));
}
// 予定ひとつの判定
export function classify(ev, sites, settings = {}) {
  const ov = (settings.overrides || {})[ev.id];
  const text = [ev.title, ev.location, ev.desc].filter(Boolean).join(' ');
  if (ov && ov.status === 'count' && sites.some(s => s.key === ov.site)) return { status: 'count', site: ov.site, how: '手で割り当て', manual: true, note: ov.note || '' };
  if (ov && ov.status === 'exclude') return { status: 'exclude', reason: 'manual', manual: true, site: ov.site && sites.some(s => s.key === ov.site) ? ov.site : null, note: ov.note || '' };
  if (ov && ov.status === 'unsure') return { status: 'unsure', kind: 'ask', note: ov.note || '', options: ov.options || [], manual: true };
  const rule = ruleOf(ev, settings.rules);
  if (rule && rule.action === 'exclude') return { status: 'exclude', reason: 'rule', label: rule.label || '', rule: rule.id };
  if (rule && rule.action === 'ask') return { status: 'unsure', kind: 'ask', note: rule.label || '', options: rule.options || [], rule: rule.id };
  const matches = matchSites(ev, sites, settings.aliases), patrolLike = PATROL_RE.test(text) || matches.length > 0;
  if (!patrolLike) {
    const t = norm(ev.title); if (t.length < 3) return { status: 'ignore' };
    const cands = sites.map(s => ({ key: s.key, sim: similarity(t, s.key) })).filter(x => x.sim >= 0.5).sort((a, b) => b.sim - a.sim).slice(0, 3);
    if (cands.length && !GROUP_RE.test(text) && !EVENT_RE.test(text)) return { status: 'unsure', kind: 'similar', options: cands.map(c => c.key) };
    return { status: 'ignore' };
  }
  if (ev.colorId === GREY) return { status: 'exclude', reason: 'grey', site: matches.length === 1 ? matches[0].key : null };
  if (GROUP_RE.test(text)) return { status: 'exclude', reason: 'group', site: matches.length === 1 ? matches[0].key : null };
  if (EVENT_RE.test(text)) return { status: 'exclude', reason: 'event', site: matches.length === 1 ? matches[0].key : null };
  if (matches.length > 1) return { status: 'unsure', kind: 'ambiguous', options: matches.map(m => m.key) };
  if (matches.length === 0) return { status: 'unsure', kind: 'nosite', options: [] };
  // 予定名が現場名の一部なだけのとき、頭の3文字以上が同じ現場がほかにもあれば決めない（例：「〇〇区役所」→ 二期？三期？）
  if (matches[0].how === '現場名の一部') { const t = norm(ev.title), others = sites.filter(x => x.key !== matches[0].key && commonPrefix(t, x.key) >= 3).map(x => x.key); if (others.length) return { status: 'unsure', kind: 'ambiguous', options: [matches[0].key, ...others] }; }
  if (UNSURE_RE.test(norm(ev.title))) return { status: 'unsure', kind: 'kind', options: [matches[0].key] };
  return { status: 'count', site: matches[0].key, how: matches[0].how, colorUnknown: ev.colorId === undefined || ev.colorId === null };
}
// まとめ：同じ現場・同じ日は1回
export function analyze(events, roumu, settings = DEFAULT_SETTINGS()) {
  const sites = buildSites(roumu, settings), out = [], seen = new Set(), off = new Set(settings.noTarget || []);
  for (const x of sites) x.noTarget = off.has(x.key);
  for (const ev of [...events].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))) {
    let c = classify(ev, sites, settings);
    if (c.status === 'count') { const k = c.site + '|' + ev.date; if (seen.has(k)) c = { status: 'exclude', reason: 'dup', site: c.site }; else seen.add(k); }
    out.push({ ...ev, ...c });
  }
  return { sites, events: out };
}
export const visitsOf = (a, key) => a.events.filter(e => e.status === 'count' && e.site === key);
export function monthCounts(a, ym) { const r = {}; for (const s of a.sites) r[s.key] = 0; for (const e of a.events) if (e.status === 'count' && e.date.startsWith(ym)) r[e.site] = (r[e.site] || 0) + 1; return r; }
// 新築で、竣工でない現場だけが目標の対象（改修は数えるけど赤にしない）
// 目標の対象：新築・竣工でない・設定で「対象外」にしていない（まだ始まっていない現場など。金子さんが決める）
export const targetSite = s => s.category === '新築' && !s.done && !s.noTarget;
export function monthView(a, ym, target = 2) {
  const cnt = monthCounts(a, ym);
  const rows = a.sites.filter(s => !s.done || cnt[s.key]).map(s => ({ ...s, count: cnt[s.key] || 0, target: targetSite(s) ? target : null, short: targetSite(s) && (cnt[s.key] || 0) < target }));
  rows.sort((x, y) => (y.short - x.short) || ((x.category === '新築' ? 0 : 1) - (y.category === '新築' ? 0 : 1)) || (y.count - x.count) || x.name.localeCompare(y.name, 'ja'));
  return { ym, rows, total: rows.reduce((t, r) => t + r.count, 0), visited: rows.filter(r => r.count).length, short: rows.filter(r => r.short).length };
}
export function yearView(a, fy, target = 2, today = '9999-12-31') {
  const nowYm = today.slice(0, 7);
  const months = fyMonths(fy), per = Object.fromEntries(months.map(ym => [ym, monthCounts(a, ym)]));
  const rows = a.sites.filter(s => !s.done || months.some(ym => per[ym][s.key])).map(s => ({ ...s, cells: months.map(ym => ({ ym, n: per[ym][s.key] || 0, red: ym <= nowYm && targetSite(s) && (per[ym][s.key] || 0) < target })) }));
  rows.sort((x, y) => ((x.category === '新築' ? 0 : 1) - (y.category === '新築' ? 0 : 1)) || x.name.localeCompare(y.name, 'ja'));
  return { fy, months, rows };
}
// 特別目標（期間・回数・対象＝新築）：設定で増やせる
export const activeSpecials = (settings, today) => (settings.special || []).filter(p => p.start <= today && today <= p.end);
export function specialView(a, p, today) {
  const rows = a.sites.filter(s => (p.category ? s.category === p.category : true) && !s.done && !s.noTarget).map(s => {
    const v = visitsOf(a, s.key).filter(e => e.date >= p.start && e.date <= p.end);
    return { key: s.key, name: s.name, done: v.length, dates: v.map(e => e.date), ok: v.length >= p.target };
  });
  rows.sort((x, y) => (x.ok - y.ok) || (x.done - y.done) || x.name.localeCompare(y.name, 'ja'));
  return { ...p, rows, achieved: rows.filter(r => r.ok).length, total: rows.length, daysLeft: Math.max(0, Math.round((Date.parse(p.end) - Date.parse(today)) / 864e5)) };
}
// カレンダー（コネクタの list_events の JSON）→ 保存する形（必要な所だけ）
export function fromCalendar(items, calendarName = '') {
  return items.filter(e => e.status !== 'cancelled' && (e.eventType || 'default') === 'default' && e.start).map(e => {
    const dt = e.start.dateTime || e.start.date;
    return { id: e.id, date: dt.slice(0, 10), time: e.start.dateTime ? dt.slice(11, 16) : '', title: e.summary || '', location: e.location || '', desc: (e.description || '').slice(0, 300), colorId: e.colorId ?? null, cal: calendarName, rec: !!e.recurringEventId };
  });
}
