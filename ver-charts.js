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
// 2) 版ごとの人工合計の推移：1つの版＝1つの点。lines = [{ label, color, bold, values: [数 or null（その版に無い）] }]、shorts＝版の短い名前（古い順）
// 土工と鳶工は別の線（足さない）。前の版との差は「+26」「−170」と符号つきの文字でも出す
export const TRADE_COLORS = { doko: '#D55E00', tobi: '#0072B2' };
export function totalsSvg(lines, shorts, { avail = 680 } = {}) {
  const n = shorts.length; if (!n || !lines.length) return '';
  const pl = 50, pr = 16, pt = 30, pb = 52, H = lines.length > 1 ? 290 : 230;
  const bw = Math.max((avail - pl - pr) / n, 58), W = Math.max(avail, Math.round(pl + pr + bw * n));
  const vals = lines.flatMap(l => l.values).filter(v => v != null); if (!vals.length) return '';
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const pad = Math.max((hi - lo) * 0.3, hi * 0.03, 1), step = niceMax((hi - lo + 2 * pad) / 4);
  const bot = Math.max(0, Math.floor((lo - pad) / step) * step), top = Math.max(bot + step * 4, Math.ceil((hi + pad) / step) * step);
  const X = i => pl + bw * i + bw / 2, Y = v => pt + 14 + (H - pt - 14 - pb) * (1 - (v - bot) / (top - bot || 1));
  let g = `<svg class="chart vchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="版ごとの人工合計" style="width:${W}px;max-width:none">`;
  for (let k = 0; k <= 4; k++) { const v = bot + (top - bot) * k / 4; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e7ee"/><text x="${pl - 4}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#777">${Math.round(v).toLocaleString('ja-JP')}</text>`; }
  const fmt = v => Math.round(v).toLocaleString('ja-JP');
  const mean = l => { const v = l.values.filter(x => x != null); return v.reduce((a, b) => a + b, 0) / (v.length || 1); };
  const topLine = lines.reduce((a, l) => (mean(l) > mean(a) ? l : a), lines[0]);
  lines.forEach(l => {
    const below = lines.length > 1 && l !== topLine; // 2本のときは下の線の数字を点の下に（重ならないように）
    const pts = l.values.map((v, i) => (v == null ? null : `${X(i)},${Y(v)}`)).filter(Boolean).join(' ');
    g += `<polyline points="${pts}" fill="none" stroke="${l.color}" stroke-width="${l.bold ? 3 : 2}" data-line="${esc(l.label)}"><title>${esc(l.label)}</title></polyline>`;
    l.values.forEach((v, i) => {
      if (v == null) return;
      const prev = i ? l.values[i - 1] : null, d = prev == null ? null : v - prev;
      g += `<circle cx="${X(i)}" cy="${Y(v)}" r="${i === n - 1 ? 5.5 : 4}" fill="${l.color}"/>`;
      const dt = d == null ? '' : `（${Math.abs(d) < 0.5 ? '±0' : (d > 0 ? '+' : '−') + fmt(Math.abs(d))}）`;
      const y1 = below ? Y(v) + 17 : Y(v) - (dt ? 21 : 9), y2 = y1 + 12;
      g += `<text x="${X(i)}" y="${y1}" font-size="11" font-weight="700" text-anchor="middle" fill="${l.color}">${fmt(v)}</text>`;
      if (dt) g += `<text x="${X(i)}" y="${y2}" font-size="10" text-anchor="middle" fill="${l.color}">${dt}</text>`;
    });
  });
  shorts.forEach((t, i) => { g += `<text x="${X(i)}" y="${H - pb + 16}" font-size="11" text-anchor="middle" fill="#444">${esc(t)}</text>`; });
  g += `<text x="${pl}" y="${H - 6}" font-size="11" fill="#777">版（人工＝5カ年の合計。（ ）は前の版との差）</text></svg>`;
  return `<div class="chart-scroll">${g}</div>`;
}
// 1本だけのとき（互換）
export function totalSvg(points, opt = {}) { return totalsSvg([{ label: '人工', color: '#111', bold: true, values: points.map(p => p.v) }], points.map(p => p.short), opt); }
