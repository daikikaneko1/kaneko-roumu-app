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
        return { v, work: sd.work, siteOff: !sd.work && x.work, siteWork: sd.work && !x.work, reason: sd.reason, offWork: v > 0 && !sd.work, concrete: L.isConcrete(s, x.date), edit: x.win }; });
      return { id: s.id, name: s.name, kubun: s.kubun || '', start: s.start || '', end: s.end || '', division: L.divisionOf(s), done: L.isDone(s), cells };
    });
    const totals = dates.map((_, i) => sites.reduce((a, s) => a + s.cells[i].v, 0));
    const concrete = dates.map((_, i) => sites.filter(s => s.cells[i].concrete).map(s => s.name));
    return { cat, label: `${cat}${L.TRADES[trade]}`, sites, totals, concrete };
  });
  const total = dates.map((_, i) => sections.reduce((a, s) => a + s.totals[i], 0));
  const concrete = dates.map((_, i) => sections.flatMap(s => s.concrete[i])); // その日にコンクリートの現場名（人数とは別）
  return { trade, months, dates, sections, total, concrete, target: (doc.settings.targets && doc.settings.targets[trade]) || 0, max: Math.max(0, ...total) };
}

function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
// 山積みグラフ：列の幅を表と同じにして、日の位置をそろえる。角の丸い棒（職種の色）、今日＝赤線、月の初め＝区切り線、目標＝点線、
// コンクリートの日＝上の段に小さな印（人数・合計とは別）
export function yearChartSvg(m, { colW = 30, H = 130 } = {}) {
  const col = TRADE_COLOR[m.trade]; if (!col) throw new Error('trade must be doko or tobi');
  const n = m.dates.length, W = n * colW, pt = 30, pb = 4, max = niceMax(Math.max(1, m.max, m.target) * 1.1);
  const Y = v => pt + (H - pt - pb) * (1 - v / max), r = Math.min(4, colW * 0.18);
  let g = `<svg class="ychart t-${m.trade}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${L.TRADES[m.trade]}の山積み（人）">`;
  m.dates.forEach((d, i) => { if (!d.work) g += `<rect class="yoff" x="${i * colW}" y="0" width="${colW}" height="${H}" fill="#f1f3f6"/>`; });
  const step = max / 4; for (let k = 1; k <= 4; k++) g += `<line class="ygl" x1="0" x2="${W}" y1="${Y(step * k)}" y2="${Y(step * k)}" stroke="#e9edf2"/>`;
  g += `<line x1="0" x2="${W}" y1="${H - pb}" y2="${H - pb}" stroke="#cfd6df"/>`;
  m.dates.forEach((d, i) => { const v = m.total[i]; if (v <= 0) return; const x = i * colW + colW * 0.16, w = colW * 0.68, y = Y(v), h = H - pb - y;
    g += `<path class="ybar" data-date="${d.date}" data-v="${v}" fill="${col}" d="M${x},${y + h} V${y + Math.min(r, h)} Q${x},${y} ${x + Math.min(r, h)},${y} H${x + w - Math.min(r, h)} Q${x + w},${y} ${x + w},${y + Math.min(r, h)} V${y + h} Z"><title>${Number(d.ym.slice(5))}/${d.day}（${L.WEEKDAYS[d.dow]}）${v}人</title></path>`;
    if (colW >= 26) g += `<text class="yv" x="${i * colW + colW / 2}" y="${y - 3}" font-size="10" font-weight="600" text-anchor="middle" fill="#3b4656">${v}</text>`; });
  for (let k = 2; k <= 4; k += 2) m.months.forEach(ym => { const i = m.dates.findIndex(d => d.ym === ym); g += `<text class="yax" x="${i * colW + 4}" y="${Y(step * k) + 11}" font-size="9" fill="#9aa5b4">${Math.round(step * k * 10) / 10}</text>`; });
  m.dates.forEach((d, i) => { if (d.first) g += `<line class="ymon" x1="${i * colW}" x2="${i * colW}" y1="0" y2="${H}" stroke="#b8c1cc"/><text class="ymt" x="${i * colW + 5}" y="12" font-size="11" font-weight="700" fill="#4a5566">${Number(d.ym.slice(5))}月</text>`; });
  // 目標の点線：上下にドラッグで目標人数を変えられる（画面側の bindTargetDrag。data-t* が目盛りの情報）
  if (m.target) { g += `<g class="tgw" data-trade="${m.trade}" data-tmax="${max}" data-tpt="${pt}" data-tbot="${H - pb}" data-tval="${m.target}" transform="translate(0,${Y(m.target)})"><line class="ytarget" x1="0" x2="${W}" y1="0" y2="0" stroke="#4a5566" stroke-width="1.2" stroke-dasharray="5 4"/>`;
    m.months.forEach(ym => { const i = m.dates.findIndex(d => d.ym === ym); g += `<text class="ytl tgl" data-fmt="目標{v} ⇕" x="${(i + 1) * colW + 40}" y="-3" font-size="9" fill="#4a5566">目標${m.target} ⇕</text>`; });
    g += `<line class="tghit" x1="0" x2="${W}" y1="0" y2="0"><title>上下にドラッグで目標人数を変える</title></line></g>`; }
  // コンクリートの日：上の段に「灰色の板＋黄色の点」（何現場かは数字で）
  (m.concrete || []).forEach((names, i) => { if (!names.length) return; const cx = i * colW + colW / 2;
    g += `<g class="yconc" data-date="${m.dates[i].date}" data-n="${names.length}"><title>コンクリート：${names.map(x => String(x).replace(/[<&>"]/g, '')).join('、')}</title><rect x="${cx - 8}" y="16" width="16" height="10" rx="3" fill="#9aa1a9"/><circle cx="${cx + 6}" cy="17" r="3" fill="#f2a900" stroke="#fff" stroke-width="1"/>${names.length > 1 ? `<text x="${cx - 1}" y="24.5" font-size="8" font-weight="700" text-anchor="middle" fill="#fff">${names.length}</text>` : ''}</g>`; });
  const ti = m.dates.findIndex(d => d.today);
  if (ti >= 0) g += `<line class="ytoday" x1="${ti * colW + 1}" x2="${ti * colW + 1}" y1="0" y2="${H}" stroke="#e5383b" stroke-width="2"/><rect x="${ti * colW + 2}" y="${H - 18}" width="26" height="14" rx="7" fill="#e5383b"/><text x="${ti * colW + 15}" y="${H - 8}" font-size="9" font-weight="700" text-anchor="middle" fill="#fff">今日</text>`;
  return g + '</svg>';
}
