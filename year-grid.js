// 1カ年（日別山積表）：今月から6か月先まで、現場×日の表と、職種ごとの山積みグラフ（SVG だけ・金額なし）
// 数字は日別データ（5カ年の月の値とつながっている）。入力は既存の op {t:'day'} → 月の値に自動で戻る
// 土工と鳶工は足さない：表もグラフも1職種ずつ
import * as L from './logic.js';
export const TRADE_COLOR = { doko: '#D55E00', tobi: '#0072B2' };
export const AHEAD = 6; // 今月＋6か月先まで

export function yearMonths(nowYm = L.todayYm(), ahead = AHEAD) { return Array.from({ length: ahead + 1 }, (_, i) => L.addMonths(nowYm, i)); }

// 表のもと：sections＝新築・改修（開始が早い順＝L.sortedSites）、各日の合計、職種の合計
export function yearGridModel(doc, trade, opt = {}, { nowYm = L.todayYm(), ahead = AHEAD } = {}) {
  if (!L.TRADES[trade]) throw new Error('trade must be doko or tobi');
  const months = yearMonths(nowYm, ahead), today = L.todayStr();
  const dates = months.flatMap(ym => { const win = L.inWindow(doc, ym); return L.datesOfMonth(ym).map(d => { const c = L.companyDay(doc, d); return { date: d, ym, day: Number(d.slice(8)), dow: L.dow(d), work: c.work, reason: c.reason, kind: c.kind || '', today: d === today, first: d.endsWith('-01'), win }; }); });
  const list = L.sortedSites(doc, trade, opt);
  const sections = L.CATEGORIES.map(cat => {
    const sites = list.filter(s => (s.category === '改修' ? '改修' : '新築') === cat).map(s => {
      const arrs = Object.fromEntries(months.map(ym => [ym, L.inWindow(doc, ym) ? L.dailyOf(doc, s, ym) : null]));
      const cells = dates.map(x => { const a = arrs[x.ym], sd = L.siteDay(doc, s, x.date), v = a ? Number(a[x.day - 1]) || 0 : 0;
        return { v, work: sd.work, siteOff: !sd.work && x.work, siteWork: sd.work && !x.work, reason: sd.reason, offWork: v > 0 && !sd.work, edit: x.win }; });
      return { id: s.id, name: s.name, kubun: s.kubun || '', start: s.start || '', end: s.end || '', division: L.divisionOf(s), done: L.isDone(s), cells };
    });
    const totals = dates.map((_, i) => sites.reduce((a, s) => a + s.cells[i].v, 0));
    return { cat, label: `${cat}${L.TRADES[trade]}`, sites, totals };
  });
  const total = dates.map((_, i) => sections.reduce((a, s) => a + s.totals[i], 0));
  return { trade, months, dates, sections, total, target: (doc.settings.targets && doc.settings.targets[trade]) || 0, max: Math.max(0, ...total) };
}

function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
// 山積みグラフ：列の幅を表と同じにして、日の位置をそろえる。今日＝赤線、月の初め＝区切り線、目標＝点線
export function yearChartSvg(m, { colW = 30, H = 130 } = {}) {
  const col = TRADE_COLOR[m.trade]; if (!col) throw new Error('trade must be doko or tobi');
  const n = m.dates.length, W = n * colW, pt = 14, pb = 4, max = niceMax(Math.max(1, m.max, m.target) * 1.1);
  const Y = v => pt + (H - pt - pb) * (1 - v / max);
  let g = `<svg class="ychart t-${m.trade}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${L.TRADES[m.trade]}の山積み（人）">`;
  m.dates.forEach((d, i) => { if (!d.work) g += `<rect class="yoff" x="${i * colW}" y="0" width="${colW}" height="${H}" fill="#eef0f3"/>`; });
  const step = max / 4; for (let k = 1; k <= 4; k++) g += `<line x1="0" x2="${W}" y1="${Y(step * k)}" y2="${Y(step * k)}" stroke="#e3e7ee"/>`;
  m.dates.forEach((d, i) => { const v = m.total[i]; if (v > 0) g += `<rect class="ybar" data-date="${d.date}" data-v="${v}" x="${i * colW + colW * 0.15}" y="${Y(v)}" width="${colW * 0.7}" height="${H - pb - Y(v)}" fill="${col}"><title>${d.ym.slice(5).replace(/^0/, '')}/${d.day}（${L.WEEKDAYS[d.dow]}）${v}人</title></rect>`;
    if (v > 0 && colW >= 26) g += `<text x="${i * colW + colW / 2}" y="${Y(v) - 2}" font-size="10" text-anchor="middle" fill="#333">${v}</text>`; });
  m.dates.forEach((d, i) => { if (d.first) g += `<line class="ymon" x1="${i * colW}" x2="${i * colW}" y1="0" y2="${H}" stroke="#888"/><text x="${i * colW + 3}" y="11" font-size="11" font-weight="700" fill="#555">${Number(d.ym.slice(5))}月</text>`; });
  for (let k = 1; k <= 4; k++) if (Y(step * k) > 24) m.months.forEach(ym => { const i = m.dates.findIndex(d => d.ym === ym); g += `<text x="${i * colW + 3}" y="${Y(step * k) - 2}" font-size="9" fill="#999">${Math.round(step * k * 10) / 10}</text>`; });
  if (m.target) g += `<line class="ytarget" x1="0" x2="${W}" y1="${Y(m.target)}" y2="${Y(m.target)}" stroke="#333" stroke-dasharray="6 4"/>`;
  const ti = m.dates.findIndex(d => d.today); if (ti >= 0) g += `<line class="ytoday" x1="${ti * colW + 1}" x2="${ti * colW + 1}" y1="0" y2="${H}" stroke="#d00" stroke-width="2"/>`;
  return g + '</svg>';
}
