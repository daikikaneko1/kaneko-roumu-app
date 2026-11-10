// Excel「出来高管理システム」から取り出した JSON（金額入り。公開リポジトリには置かない）→ 出来高の状態データ
// 取り出し方：README「出来高：Excel からの移行」。グループ分けは Excel の式から取り出したもの（derived）を使う。
import { SCHEMA, keyOf } from '../dk-core.js';
// シート名（例「鳶2₋2仮設」「土工1_躯体」）から id（tobi2-2 / doko1）と短い名前（鳶2-2 仮設）を作る
const TR = { '鳶': 'tobi', '土工': 'doko' };
const norm = sh => sh.replace(/₋/g, '-');
const idFrom = sh => { const m = norm(sh).match(/^(鳶|土工)(\d+(?:-\d+)?)/); return m ? TR[m[1]] + m[2] : 'k' + sh; };
const shortFrom = sh => norm(sh).replace(/_/, ' ').replace(/^((?:鳶|土工)\d+(?:-\d+)?)(?=[^\s\d-])/, '$1 ');
const excelDate = n => new Date(Date.UTC(1899, 11, 30) + n * 864e5).toISOString().slice(0, 10).replace(/-/g, '/');
const ymOf = s => (s ? String(s).replace(/\//g, '-').replace(/-$/, '') : null);
export function buildState(x, at = new Date().toISOString(), by = 'Excel移行') {
  const d = x.derived, idOf = idFrom;
  const groups = d.groups.map((g, i) => ({ id: 'g-' + (idFrom(g.sheets[0]).replace(/\d.*$/, '') || i), name: g.name, target: g.target, method: g.method, note: g.note, excel: g.title }));
  const gOf = {}; d.groups.forEach((g, i) => g.sheets.forEach(sh => { gOf[sh] = groups[i].id; }));
  const singleT = Object.fromEntries((d.singleTargets || []).map(t => [t.name, t]));
  const keisho = x.keisho.map(k => {
    const st = Object.values(singleT).find(t => t.name.startsWith(shortFrom(k.sheet).split(' ')[0] + ' '));
    return {
      id: idOf(k.sheet), no: k.no, name: k.name, short: k.kubun ? shortFrom(k.sheet).split(' ')[0] + ' ' + k.kubun : shortFrom(k.sheet), sheet: k.sheet, trade: k.trade, kubun: k.kubun,
      from: k.from, to: k.to, hasNinku: !!k.hasNinku, active: true,
      amount: typeof k.amount === 'number' ? k.amount : null, // 空欄は空欄のまま（未設定）
      start: k.start ?? null, end: k.end ?? null, // 「2028/2/」のような途中の日付も文字のまま残す
      taisho: k.taisho === '○', group: gOf[k.sheet] || null,
      ...(st ? { target: st.target, targetNote: `${st.method}（${st.note}）` } : {}), note: k.note ?? '',
    };
  });
  const records = {};
  for (const k of x.keisho) for (const r of k.rows) {
    const f = {};
    if (r.amount != null) f.amount = { v: r.amount, at, by, src: 'excel' };
    if (r.ninku != null) f.ninku = { v: r.ninku, at, by, src: 'excel' };
    if (r.note != null && r.note !== '') f.note = { v: String(r.note), at, by, src: 'excel' };
    if (Object.keys(f).length) records[keyOf(idOf(k.sheet), r.month)] = f;
  }
  const o = x.other || {};
  const meeting = o.meeting || {};
  return {
    schema: SCHEMA, merged: [], updatedAt: at, updatedBy: by,
    settings: { cycleDay: 21, cycle: o.cycle || '毎月21日～翌月20日締め', period: { from: ymOf(o.period && o.period[0]), to: ymOf(o.period && o.period[1]) }, excelReportMonth: ymOf(o.reportMonth) },
    keisho, groups, records,
    notes: {
      comment: '',
      meeting: [meeting.V4, typeof meeting.V6 === 'number' ? `${meeting.V6}（Excelの値そのまま。日付なら ${excelDate(meeting.V6)}）` : meeting.V6, meeting.W6, meeting.W7].filter(v => v != null && v !== '').map(String),
      excelExtras: [...(o.tobi1_I20 != null ? [`鳶1_鉄骨!I20 に「${o.tobi1_I20}」（表の外の値）`] : []), ...(o.footnotes || []).filter(Boolean)],
    },
  };
}
