// 出来高のグラフ（外部ライブラリなし：SVG と CSS だけ。オフラインでも表示）。数字は復号したあとに画面の中だけで描く
const yen = v => (v == null ? '' : Math.round(v).toLocaleString('ja-JP'));
const ax = v => { const a = Math.abs(v); return a >= 1e8 ? (v / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '億' : a >= 1e4 ? (Math.round(v / 1e2) / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + '万' : Math.round(v).toLocaleString('ja-JP'); };
const ym = s => s.replace(/^\d{2}(\d{2})-/, '$1/');
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }

// ---- 1) 請書残高：使った分（累計請求）＝濃い、残り＝薄い。残<20% 黄、<10% 赤、超過は赤で「超過」 ----
export function balance(amount, cum) {
  if (amount == null || !amount) return { set: false };
  const used = cum / amount, rem = amount - cum, remPct = rem / amount;
  const lv = cum > amount ? 'over' : remPct < 0.1 ? 'red' : remPct < 0.2 ? 'yellow' : 'ok';
  return { set: true, used, rem, remPct, lv };
}
export function balanceBar(amount, cum, { mini = false, name = '' } = {}) {
  const b = balance(amount, cum);
  if (!b.set) return `<div class="bal ${mini ? 'mini' : ''}">${name ? `<span class="bn">${name}</span>` : ''}<span class="unset">未設定</span></div>`;
  const w = Math.max(0, Math.min(100, b.used * 100));
  const label = b.lv === 'over' ? `超過 ${yen(-b.rem)}円（${(-b.remPct * 100).toFixed(1)}%）` : `残額 ${yen(b.rem)}円（残 ${(b.remPct * 100).toFixed(1)}%）`;
  const short = b.lv === 'over' ? `超過 ${(-b.remPct * 100).toFixed(0)}%` : `残 ${(b.remPct * 100).toFixed(0)}%`;
  return `<div class="bal ${mini ? 'mini' : ''} lv-${b.lv}" data-lv="${b.lv}">${name ? `<span class="bn">${name}</span>` : ''}<span class="track"><span class="used" style="width:${w.toFixed(1)}%"></span></span><span class="bl">${mini ? short : label}</span></div>`;
}

// ---- 2) 出来高推移：月次出来高（円/人工）の線＋累計の線、目標の点線。点は目標以上=緑・未満=赤。前月比 ↑↓ ----
// rows: groupSeries().rows（{ ym, I, N }）。データのある月まで渡す
export function trend(rows, target) {
  const pts = rows.map((r, i) => ({ i, ym: r.ym, v: r.I, c: r.N }));
  const withV = pts.filter(p => p.v != null);
  const last = withV[withV.length - 1], prev = withV[withV.length - 2];
  return { last, prev, diff: last && prev ? last.v - prev.v : null, dir: last && prev ? (last.v > prev.v ? 'up' : last.v < prev.v ? 'down' : 'flat') : null, target };
}
export function trendSvg(rows, target, { h = 230, title = '' } = {}) {
  const W = 680, H = h, L = 58, R = 14, T = 18, B = 34;
  const vals = rows.flatMap(r => [r.I, r.N]).filter(v => v != null);
  if (!vals.length) return '<p class="muted small">グラフにする月がまだありません。</p>';
  const lo = Math.min(0, ...vals), hi = niceMax(Math.max(...vals, target || 0) * 1.08);
  const n = rows.length, x = i => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1)), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => { const v = lo + (hi - lo) * f; return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="g"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="ya">${ax(v)}</text>`; }).join('');
  const step = Math.max(1, Math.ceil(n / 8));
  const xl = rows.map((r, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 12}" class="xa">${ym(r.ym)}</text>` : '')).join('');
  const path = key => { let d = '', pen = false; rows.forEach((r, i) => { const v = r[key]; if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
  const tl = target ? `<line x1="${L}" x2="${W - R}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}" class="tg"/><text x="${W - R}" y="${(y(target) - 5).toFixed(1)}" class="tgl">目標 ${yen(target)}</text>` : '';
  const dots = rows.map((r, i) => (r.I == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(r.I).toFixed(1)}" r="4.5" class="pt ${target ? (r.I >= target ? 'good' : 'bad') : 'nt'}"><title>${r.ym.replace('-', '/')} ${yen(r.I)} 円/人工</title></circle>`)).join('');
  return `<svg class="chart trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title || '出来高推移'}">${grid}${xl}${tl}<path d="${path('N')}" class="cum"/><path d="${path('I')}" class="mon"/>${dots}</svg>
   <div class="legend"><span class="lg mon">月次出来高</span><span class="lg cum">累計出来高</span>${target ? '<span class="lg tg">目標（共通単価）</span><span class="lg good">● 目標以上</span><span class="lg bad">● 目標未満</span>' : '<span class="muted">目標なし</span>'}</div>`;
}
export function trendHead(rows, target) {
  const t = trend(rows, target); if (!t.last) return '';
  const arrow = t.dir === 'up' ? '<b class="up">↑</b>' : t.dir === 'down' ? '<b class="down">↓</b>' : t.dir === 'flat' ? '<b>→</b>' : '';
  return `<div class="trendhead"><span>最新 ${t.last.ym.replace('-', '/')}：<b class="${target ? (t.last.v >= target ? 'good' : 'bad') : ''}">${yen(t.last.v)}</b> 円/人工</span>${t.diff != null ? `<span>前月比 ${arrow} ${t.diff > 0 ? '+' : ''}${yen(t.diff)}</span>` : ''}${t.last.c != null ? `<span>累計 ${yen(t.last.c)}</span>` : ''}</div>`;
}

// ---- 3) 小口：月々の請求＝棒、累計（積み上がり）＝線。残りはない ----
export function koguSvg(series, { h = 220 } = {}) {
  const rows = series; if (!rows.some(r => r.amount != null)) return '<p class="muted small">まだ請求がありません。</p>';
  const W = 680, H = h, L = 54, R = 58, T = 16, B = 34, n = rows.length;
  const mMax = niceMax(Math.max(1, ...rows.map(r => r.amount || 0)) * 1.05), cMax = niceMax(Math.max(1, ...rows.map(r => r.cumAmount)) * 1.05);
  const bw = Math.max(4, ((W - L - R) / n) * 0.62), x = i => L + ((i + 0.5) * (W - L - R)) / n;
  const yM = v => T + (H - T - B) * (1 - Math.max(0, v) / mMax), yC = v => T + (H - T - B) * (1 - Math.max(0, v) / cMax);
  const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${yM(mMax * f).toFixed(1)}" y2="${yM(mMax * f).toFixed(1)}" class="g"/><text x="${L - 6}" y="${(yM(mMax * f) + 4).toFixed(1)}" class="ya">${ax(mMax * f)}</text><text x="${W - R + 6}" y="${(yC(cMax * f) + 4).toFixed(1)}" class="ya r">${ax(cMax * f)}</text>`).join('');
  const step = Math.max(1, Math.ceil(n / 8));
  const xl = rows.map((r, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 12}" class="xa">${ym(r.ym)}</text>` : '')).join('');
  const bars = rows.map((r, i) => (r.amount ? `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${yM(r.amount).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yM(0) - yM(r.amount)).toFixed(1)}" class="kb"><title>${r.ym.replace('-', '/')} ${yen(r.amount)} 円</title></rect>` : '')).join('');
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yC(r.cumAmount).toFixed(1)}`).join('');
  return `<svg class="chart kogu" viewBox="0 0 ${W} ${H}" role="img" aria-label="小口の請求と累計">${grid}${xl}${bars}<path d="${d}" class="cum"/></svg>
   <div class="legend"><span class="lg kbar">月々の請求（左の目盛り）</span><span class="lg cum">累計（積み上がり・右の目盛り）</span></div>`;
}
