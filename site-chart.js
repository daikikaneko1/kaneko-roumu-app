// 現場ごとの山積みグラフ（現場の画面・年度タブの上）。外部ライブラリなし：SVG だけ。人/日のみ（金額なし）
// 1現場＝1職種なので、その職種の色だけ（土工 #D55E00・鳶工 #0072B2）。職種を足すことはしない
import * as L from './logic.js';
export const TRADE_COLOR = { doko: '#D55E00', tobi: '#0072B2' };
const f1 = v => (Math.round(v * 10) / 10).toString();
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }

// グラフの数字：5カ年山積表と同じ L.monthInfo（日別がある月＝日別から計算した月平均、それ以外＝月の値）
// 年度の範囲：計画の年度のうち、人数がある最初の年度〜最後の年度（表示中の年度は必ず入れる）
export function siteMountainData(doc, s, selFY) {
  const st = doc.settings, all = Array.from({ length: st.years }, (_, i) => st.firstFY + i);
  const per = all.map(fy => ({ fy, months: L.fyMonths(fy).map(ym => { const mi = L.monthInfo(doc, s, ym); return { ym, v: mi.value || 0, daily: !!mi.daily }; }) }));
  const on = per.filter(p => p.months.some(m => m.v > 0.005)).map(p => p.fy);
  const lo = Math.min(...on, selFY), hi = Math.max(...on, selFY);
  const fys = per.filter(p => p.fy >= lo && p.fy <= hi);
  return { trade: s.trade, selFY, fys: fys.map(p => p.fy), bars: fys.flatMap(p => p.months.map(m => ({ ...m, fy: p.fy }))), empty: !on.length };
}

// SVG。bars は年度ごとに12本。表示中の年度は帯で囲み、他の年度はうすく。4月に年度の区切り線とラベル。
// 年度の範囲（帯）をタップ → data-a="fy|年度"（app.js の handlers.fy）
export function siteMountainSvg(data, { avail = 360, today = null } = {}) {
  const col = TRADE_COLOR[data.trade]; if (!col) throw new Error('trade must be doko or tobi');
  const n = data.bars.length, pl = 34, pr = 10, pt = 30, pb = 30, H = avail >= 860 ? 240 : 200;
  const bw = Math.min(48, Math.max((avail - pl - pr) / n, 14)), W = Math.round(pl + pr + bw * n);
  const max = niceMax(Math.max(1, ...data.bars.map(b => b.v)) * 1.12);
  const Y = v => pt + (H - pt - pb) * (1 - v / max), x0 = i => pl + bw * i;
  let g = `<svg class="chart smtn t-${data.trade}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="この現場の山積み（人/日）" style="width:${W}px;max-width:none">`;
  // 表示中の年度の帯（下に敷く）
  data.fys.forEach((fy, k) => { if (fy === data.selFY) g += `<rect class="fyband" data-fy="${fy}" x="${x0(k * 12)}" y="${pt - 22}" width="${bw * 12}" height="${H - pb - pt + 22}" fill="${col}" fill-opacity="0.10" stroke="${col}" stroke-opacity="0.5" rx="4"/>`; });
  for (let k = 0; k <= 4; k++) { const v = max * k / 4; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e7ee"/><text x="${pl - 4}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#777">${f1(v)}</text>`; }
  data.bars.forEach((b, i) => {
    const sel = b.fy === data.selFY, m = Number(b.ym.slice(5)), h = (H - pt - pb) * b.v / max;
    if (b.v > 0.005) g += `<rect class="mbar${sel ? ' sel' : ''}" data-ym="${b.ym}" data-v="${f1(b.v)}" x="${x0(i) + bw * 0.12}" y="${Y(b.v)}" width="${bw * 0.76}" height="${h}" fill="${col}" fill-opacity="${sel ? 1 : 0.45}"/>`;
    if (b.v > 0.005 && sel && bw >= 14) g += `<text class="bv" x="${x0(i) + bw / 2}" y="${Y(b.v) - 3}" font-size="${bw >= 22 ? 11 : 9}" text-anchor="middle" fill="#222">${f1(b.v)}</text>`;
    if (sel || bw >= 22 || [4, 7, 10, 1].includes(m)) g += `<text class="xm${sel ? ' sel' : ''}" x="${x0(i) + bw / 2}" y="${H - pb + 14}" font-size="10" text-anchor="middle" fill="${sel ? "#222" : "#777"}">${m}</text>`;
    if (m === 4) g += `<line class="fyline" x1="${x0(i)}" x2="${x0(i)}" y1="${pt - 22}" y2="${H - pb + 4}" stroke="#888" stroke-dasharray="4 3"/>`;
  });
  data.fys.forEach((fy, k) => { const sel = fy === data.selFY;
    g += `<text class="fyl${sel ? ' sel' : ''}" x="${x0(k * 12) + 5}" y="${pt - 9}" font-size="12" font-weight="700" fill="${sel ? col : '#555'}">${fy}年度${sel ? '（表示中）' : ''}</text>`; });
  if (today) { const i = data.bars.findIndex(b => b.ym === today); if (i >= 0) g += `<line class="today" x1="${x0(i) + bw / 2}" x2="${x0(i) + bw / 2}" y1="${pt}" y2="${H - pb}" stroke="#333" stroke-width="1" stroke-dasharray="2 2"/><text x="${x0(i) + bw / 2}" y="${H - 4}" font-size="10" text-anchor="middle" fill="#333">今月</text>`; }
  // タップ用（年度の範囲いっぱい・透明。一番上）
  data.fys.forEach((fy, k) => { g += `<rect class="fyhit" data-a="fy|${fy}" data-fy="${fy}" x="${x0(k * 12)}" y="0" width="${bw * 12}" height="${H}" fill="#000" fill-opacity="0" style="cursor:pointer"><title>${fy}年度を表示</title></rect>`; });
  return { svg: g + '</svg>', W, selX: x0(Math.max(0, data.fys.indexOf(data.selFY)) * 12), selW: bw * 12 };
}
