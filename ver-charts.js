// 版の推移グラフ（外部ライブラリなし：SVG だけ）。色は色覚の違いに配慮した Okabe-Ito 配色。線の種類（点線など）でも区別
const PAL = ['#E69F00', '#56B4E9', '#009E73', '#CC79A7', '#0072B2', '#D55E00', '#999999'];
const DASH = ['6 4', '2 3', '10 4 2 4', '4 4', '1 3', '8 3'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = v => (Math.round(v * 10) / 10).toString();
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
// 線のスタイル：最新＝黒の太線、古い版＝色つきの細い点線（うすく）
export function lineStyles(n) {
  return Array.from({ length: n }, (_, i) => i === n - 1 ? { color: '#111', width: 3.5, opacity: 1, dash: '' } : { color: PAL[(n - 2 - i) % PAL.length], width: 2, opacity: 0.6, dash: DASH[(n - 2 - i) % DASH.length] });
}
export function legendHtml(series) {
  const st = lineStyles(series.length);
  return `<div class="legend vlegend">${series.map((s, i) => `<span><svg width="30" height="12" aria-hidden="true"><line x1="1" x2="29" y1="6" y2="6" stroke="${st[i].color}" stroke-width="${st[i].width}" stroke-opacity="${st[i].opacity}" stroke-dasharray="${st[i].dash}"/></svg>${esc(s.label)}${i === series.length - 1 ? '（最新）' : ''}</span>`).join('')}</div>`;
}
// 1) 計画線の重ね表示：x＝月、y＝人/日。series = [{ label, values: { 'YYYY-MM': v } }]（古い順）
export function overlaySvg(series, months, { avail = 680, unit = '人/日' } = {}) {
  if (!months.length) return '<p class="muted">この現場は、どの版にも人数が入っていません。</p>';
  const n = months.length, pl = 40, pr = 12, pt = 26, pb = 34, H = avail >= 860 ? 340 : 260;
  const bw = Math.max((avail - pl - pr) / n, n > 24 ? 22 : 30), W = Math.max(avail, Math.round(pl + pr + bw * n));
  const max = niceMax(Math.max(1, ...series.flatMap(s => months.map(ym => s.values[ym] || 0))) * 1.1);
  const X = i => pl + bw * i + bw / 2, Y = v => pt + (H - pt - pb) * (1 - v / max);
  let g = `<svg class="chart vchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="版ごとの計画線" style="width:${W}px;max-width:none">`;
  for (let k = 0; k <= 4; k++) { const v = max * k / 4; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e7ee"/><text x="${pl - 4}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#777">${f1(v)}</text>`; }
  months.forEach((ym, i) => {
    const [y, m] = ym.split('-').map(Number);
    if (m === 4 || i === 0) g += `<line x1="${pl + bw * i}" x2="${pl + bw * i}" y1="${pt - 16}" y2="${H - pb + 4}" stroke="#bbb" stroke-dasharray="${m === 4 ? '4 3' : '0'}"/><text x="${pl + bw * i + 3}" y="${pt - 6}" font-size="11" font-weight="700" fill="#555">${m >= 4 ? y : y - 1}年度</text>`;
    if (n <= 24 || i % 2 === 0) g += `<text x="${X(i)}" y="${H - pb + 14}" font-size="11" text-anchor="middle" fill="#444">${m}</text>`;
  });
  const st = lineStyles(series.length);
  series.forEach((s, k) => {
    const pts = months.map((ym, i) => `${X(i).toFixed(1)},${Y(s.values[ym] || 0).toFixed(1)}`).join(' ');
    g += `<polyline points="${pts}" fill="none" stroke="${st[k].color}" stroke-width="${st[k].width}" stroke-opacity="${st[k].opacity}" stroke-dasharray="${st[k].dash}" stroke-linejoin="round" data-ver="${esc(s.label)}"><title>${esc(s.label)}</title></polyline>`;
  });
  const last = series[series.length - 1];
  if (last && n <= 24) months.forEach((ym, i) => { const v = last.values[ym] || 0; if (v) g += `<circle cx="${X(i)}" cy="${Y(v)}" r="3" fill="#111"/>`; });
  g += `<text x="${pl}" y="${H - 6}" font-size="11" fill="#777">月（${unit}・1日あたり平均）</text></svg>`;
  return `<div class="chart-scroll">${g}</div>`;
}
// 2) 版ごとの人工合計の推移：1つの版＝1つの点。points = [{ label, short, v }]（古い順）
export function totalSvg(points, { avail = 680 } = {}) {
  if (!points.length) return '';
  const n = points.length, pl = 46, pr = 14, pt = 30, pb = 40, H = 220;
  const bw = Math.max((avail - pl - pr) / n, 54), W = Math.max(avail, Math.round(pl + pr + bw * n));
  const vals = points.map(p => p.v), hi = Math.max(...vals), lo = Math.min(...vals);
  const pad = Math.max((hi - lo) * 0.3, hi * 0.03, 1), step = niceMax((hi - lo + 2 * pad) / 4);
  const bot = Math.max(0, Math.floor((lo - pad) / step) * step), top = Math.max(bot + step * 4, Math.ceil((hi + pad) / step) * step);
  const X = i => pl + bw * i + bw / 2, Y = v => pt + (H - pt - pb) * (1 - (v - bot) / (top - bot || 1));
  let g = `<svg class="chart vchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="版ごとの人工合計" style="width:${W}px;max-width:none">`;
  for (let k = 0; k <= 4; k++) { const v = bot + (top - bot) * k / 4; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e7ee"/><text x="${pl - 4}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#777">${Math.round(v).toLocaleString('ja-JP')}</text>`; }
  g += `<polyline points="${points.map((p, i) => `${X(i)},${Y(p.v)}`).join(' ')}" fill="none" stroke="#111" stroke-width="2.5"/>`;
  points.forEach((p, i) => {
    const d = i ? p.v - points[i - 1].v : 0, cls = Math.abs(d) < 0.5 ? '' : d > 0 ? 'up' : 'dn';
    g += `<circle cx="${X(i)}" cy="${Y(p.v)}" r="${i === n - 1 ? 6 : 4.5}" fill="${cls === 'up' ? '#0B5CAD' : cls === 'dn' ? '#B3261E' : '#111'}"/>`;
    g += `<text x="${X(i)}" y="${Y(p.v) - 10}" font-size="12" font-weight="700" text-anchor="middle" fill="#222">${Math.round(p.v).toLocaleString('ja-JP')}</text>`;
    if (i) g += `<text x="${X(i)}" y="${Y(p.v) + 20}" font-size="11" text-anchor="middle" fill="${cls === 'up' ? '#0B5CAD' : cls === 'dn' ? '#B3261E' : '#777'}">${cls ? (d > 0 ? '+' : '−') + Math.round(Math.abs(d)).toLocaleString('ja-JP') : '±0'}</text>`;
    g += `<text x="${X(i)}" y="${H - pb + 16}" font-size="11" text-anchor="middle" fill="#444">${esc(p.short)}</text>`;
  });
  g += `<text x="${pl}" y="${H - 6}" font-size="11" fill="#777">版（人工＝5カ年の合計）</text></svg>`;
  return `<div class="chart-scroll">${g}</div>`;
}
