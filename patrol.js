// パトロール履歴（金子さん専用）。カレンダーの中身は非公開リポジトリに暗号化して置き、ここでだけ読む
import CFG from './patrol-config.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { GitHubStore, ConflictError } from './store.js';
import * as P from './patrol-core.js';
import * as N from './patrol-notes.js';

const $ = s => document.querySelector(s), main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const WD = '日月火水木金土', wd = d => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
const ymLabel = ym => `${ym.slice(0, 4)}年${Number(ym.slice(5))}月`;
const addYm = (ym, n) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const S = { demo: new URLSearchParams(location.search).has('demo'), view: 'month' };

// ---------- 読み込み ----------
function stores(token) {
  const mk = path => new GitHubStore({ owner: CFG.owner, repo: CFG.repo, branch: CFG.branch, path, token });
  return { roumu: mk(CFG.roumuPath), events: mk(`${CFG.dir}/events.json`), settings: mk(`${CFG.dir}/settings.json`), notes: mk(`${CFG.dir}/notes.json`), photos: new N.PhotoStore({ owner: CFG.owner, repo: CFG.repo, branch: CFG.branch, token }) };
}
async function openDoc(doc, pass) { const t = await decryptSecret(doc.blob, pass); if (t == null) throw new Error('合言葉が違うか、データが壊れています'); return JSON.parse(t); }
async function loadAll() {
  if (S.demo) {
    const d = await (await fetch('patrol-demo.json', { cache: 'no-store' })).json();
    Object.assign(S, { today: d.today, roumu: d.roumu, meta: d.events, settings: { ...P.DEFAULT_SETTINGS(), ...d.settings }, settingsSha: null, notes: d.notes || [], notesSha: null, notesErr: '' });
    S.demoPhotos = S.demoPhotos || {}; for (const n of S.notes) if (n.photo && !S.demoPhotos[n.photo]) S.demoPhotos[n.photo] = await N.demoPicture(n.photo.endsWith('2') ? 1 : 0);
  } else {
    const st = stores(S.token); S.st = st;
    const [r, e] = await Promise.all([st.roumu.load(), st.events.load().catch(err => { if (/404/.test(err.message)) return null; throw err; })]);
    S.roumu = r.doc; S.meta = e ? await openDoc(e.doc, S.pass) : { events: [], colorAvailable: false };
    await loadSettings(); await loadNotes(); S.today = jstToday();
  }
  recompute();
  S.ym = S.ym || S.today.slice(0, 7); S.fy = S.fy || P.fyOf(S.today);
}
async function loadSettings() {
  try { const s = await S.st.settings.load(); S.settings = { ...P.DEFAULT_SETTINGS(), ...(await openDoc(s.doc, S.pass)) }; S.settingsSha = s.sha; }
  catch (err) { if (!/404/.test(err.message)) throw err; S.settings = P.DEFAULT_SETTINGS(); S.settingsSha = undefined; }
}
// 気づき（notes.json）：読めなくても他の画面は使えるようにする
async function loadNotes() {
  try { const r = await S.st.notes.load(); const d = await openDoc(r.doc, S.pass); S.notes = d.notes || []; S.notesSha = r.sha; S.notesErr = ''; }
  catch (err) { if (/404/.test(err.message)) { S.notes = []; S.notesSha = undefined; S.notesErr = ''; } else { if (err.auth) throw err; S.notes = S.notes || []; S.notesErr = err.message; } }
}
const recompute = () => { S.a = P.analyze(S.meta.events || [], S.roumu, S.settings); S.byKey = Object.fromEntries(S.a.allSites.map(s => [s.key, s])); };
const catTag = c => c === '改修' ? '<span class="tag kai">改修</span>' : c === '新築' ? '<span class="tag">新築</span>' : '<span class="tag">区分未確認</span>';
const reasonText = e => e.reason === 'rule' ? (e.label || P.REASONS.rule) : P.REASONS[e.reason];
const siteName = k => (S.byKey[k] || {}).name || k;

// 設定の保存（暗号化・ぶつかったら読み直してもう一度）
async function changeSettings(fn, msg) {
  if (S.demo) { fn(S.settings); recompute(); render(); toast('（お試し：保存はしません）'); return; }
  for (let i = 0; i < 3; i++) {
    const next = structuredClone(S.settings); fn(next);
    const doc = { schema: P.SCHEMA, kind: 'settings', blob: await encryptSecret(JSON.stringify(next), S.pass, 300000) };
    try { S.settingsSha = await S.st.settings.save(doc, S.settingsSha, `パトロール：${msg}（暗号化）`); S.settings = next; recompute(); render(); toast('保存しました'); return; }
    catch (e) { if (!(e instanceof ConflictError)) { toast('保存できませんでした：' + e.message); return; } await loadSettings(); }
  }
  toast('ほかの端末と同時に保存されたため、保存できませんでした。もう一度どうぞ');
}
// 気づきの保存（暗号化・ぶつかったら読み直してもう一度）。うまくいけば true
async function changeNotes(fn, msg) {
  if (S.demo) { S.notes = fn(S.notes); render(); toast('（お試し：保存はしません）'); return true; }
  if (S.notesErr) { toast('気づきを読み込めていないため保存しません。開き直してください'); return false; }
  for (let i = 0; i < 3; i++) {
    const next = fn(structuredClone(S.notes));
    const doc = { schema: P.SCHEMA, kind: N.NOTES_KIND, blob: await encryptSecret(JSON.stringify({ notes: next }), S.pass, 300000) };
    try { S.notesSha = await S.st.notes.save(doc, S.notesSha, `パトロール：${msg}（暗号化）`); S.notes = next; render(); toast('保存しました'); return true; }
    catch (e) { if (!(e instanceof ConflictError)) { toast('保存できませんでした：' + (e.auth ? '鍵の期限切れかもしれません' : e.message)); return false; } await loadNotes(); }
  }
  toast('ほかの端末と同時に保存されたため、保存できませんでした。もう一度どうぞ'); return false;
}
function toast(t) { $('#status').textContent = t; clearTimeout(S.tt); S.tt = setTimeout(() => { $('#status').textContent = statusText(); }, 3000); }
const statusText = () => S.demo ? 'お試し表示（架空のデータ）' : (S.meta && S.meta.syncedAt ? `同期 ${md(S.meta.syncedAt.slice(0, 10))}` : '');

// ---------- 画面 ----------
function specialBlock(p, compact) {
  const v = P.specialView(S.a, p, S.today), pct = v.total ? Math.round(v.achieved / v.total * 100) : 0;
  const head = `${esc(p.label)} ${md(p.start)}〜${md(p.end)}：${p.target}回`;
  return `<section class="card sp" data-special="${esc(p.id)}"><h3>🎯 ${head}</h3>
   <div><b style="font-size:20px">${v.achieved}/${v.total}現場 達成</b> <span class="muted small">${S.today < p.start ? 'まだ始まっていません' : S.today > p.end ? '期間終了' : `のこり${v.daysLeft}日`}・対象は新築だけ（改修は外す）</span></div>
   <div class="bar"><i style="width:${pct}%"></i></div>
   ${v.rows.map(r => `<div class="sprow ${r.ok ? 'ok' : 'ng'}" data-site="${esc(r.key)}"><span>${r.ok ? '✅' : '⚠️'}</span><span class="n">${esc(r.name)}</span><span class="dots">${'●'.repeat(Math.min(r.done, p.target))}${'○'.repeat(Math.max(0, p.target - r.done))}</span><b>${r.done}/${p.target}</b></div>`).join('')}
   ${compact ? '' : ''}</section>`;
}
function viewMonth() {
  const v = P.monthView(S.a, S.ym, S.settings.monthlyTarget || 2), act = P.activeSpecials(S.settings, S.today);
  const unsure = S.a.events.filter(e => e.status === 'unsure' && e.date.startsWith(S.ym)).length;
  return `${act.map(p => specialBlock(p)).join('')}
  <div class="sw"><button data-ym="-1" aria-label="前の月">◀ 前月</button><b>${ymLabel(S.ym)}</b><button data-ym="1" aria-label="次の月">次月 ▶</button></div>
  <div class="sum"><div><b>${v.visited}</b><small>行った現場</small></div><div><b>${v.total}</b><small>回数</small></div><div><b style="color:${v.short ? 'var(--ng)' : 'var(--ok)'}">${v.short}</b><small>2回未満（新築）</small></div></div>
  ${unsure ? `<div class="note">🔍 この月に「要確認」が${unsure}件あります → <a href="#check">除外チェック</a>で決めてください（決めるまで数えません）</div>` : ''}
  ${S.meta.colorAvailable === false && !S.demo ? '<div class="note">カレンダーの色が読めないため、グレー（行っていない）は自動で外せません。行っていない予定は 現場をタップ →「行っていない」で外してください。</div>' : ''}
  ${v.rows.map(r => `<div class="card site ${r.short ? 'short' : ''}" data-site="${esc(r.key)}"><span class="mark">${r.target == null ? '・' : r.short ? '⚠️' : '✅'}</span><div class="nm"><b>${esc(r.name)}</b><small>${catTag(r.category)}${r.trades.map(t => `<span class="tag">${esc(t)}</span>`).join('')}${r.team ? `<span class="tag">${esc(r.team)}</span>` : ''}${r.extra ? '<span class="tag">パトロール専用</span>' : ''}</small></div><div class="cnt">${r.count}<small>${r.target != null ? `/${r.target}回` : '回'}</small></div></div>`).join('')}`;
}
function viewYear() {
  const v = P.yearView(S.a, S.fy, S.settings.monthlyTarget || 2, S.today);
  const sp = (S.settings.special || []).filter(p => P.fyOf(p.start) === S.fy || P.fyOf(p.end) === S.fy);
  return `<div class="sw"><button data-fy="-1">◀ 前年度</button><b>${S.fy}年度</b><button data-fy="1">次年度 ▶</button></div>
  ${sp.length ? `<div class="acts" style="margin-bottom:8px">${sp.map(p => `<button data-showsp="${esc(p.id)}">🎯 ${esc(p.label)}（${md(p.start)}〜${md(p.end)}）</button>`).join('')}</div>` : ''}
  <div class="tw"><table><thead><tr><th class="nm">現場</th>${v.months.map(m => `<th>${Number(m.slice(5))}月</th>`).join('')}<th>計</th></tr></thead><tbody>
  ${v.rows.map(r => `<tr class="${r.category === '改修' ? 'kai' : ''}"><td class="nm" data-site="${esc(r.key)}">${r.category === '改修' ? '<span class="tag kai">改修</span>' : ''}${esc(r.name)}</td>${r.cells.map(c => `<td class="c ${c.red ? 'red' : ''} ${c.n ? '' : 'z'}" data-cell="${esc(r.key)}|${c.ym}">${c.n || (c.red ? '0' : '·')}</td>`).join('')}<td><b>${r.cells.reduce((t, c) => t + c.n, 0)}</b></td></tr>`).join('')}
  </tbody></table></div><p class="muted small">赤＝その月 2回未満（新築・今月まで）。改修は赤にしません。数字をタップすると日付が出ます。</p>`;
}
function evRow(e, extra = '') { return `<div class="ev"><div class="d">${md(e.date)}(${wd(e.date)})${e.time ? `<br><small class="muted">${e.time}</small>` : ''}</div><div class="t">${esc(e.title)}${e.location ? `<div class="why">📍${esc(e.location)}</div>` : ''}${extra}</div></div>`; }
function viewSite(key) {
  const s = S.byKey[key]; if (!s) return '<p>現場が見つかりません</p>';
  const vs = P.visitsOf(S.a, key).sort((a, b) => b.date.localeCompare(a.date)), ex = S.a.events.filter(e => e.status === 'exclude' && e.site === key);
  return `<p><button data-back>← もどる</button></p><h2>${esc(s.name)}</h2><p class="muted">${s.category || '区分未確認'}${s.done ? '・終了' : ''}${s.trades.length ? '・' + s.trades.join('/') : ''}${s.team ? '・' + esc(s.team) : ''}${s.extra ? '・パトロール専用' : ''}${s.mergedNames ? '・まとめた名前：' + esc(s.mergedNames.join('、')) : ''}${s.note ? '・' + esc(s.note) : ''}・今年度 ${vs.filter(e => P.fyOf(e.date) === S.fy).length}回</p>
  <div class="card"><h3 style="margin-top:0">行った日</h3>${vs.length ? vs.map(e => evRow(e, `<div class="why">${esc(e.how || '')}${e.colorUnknown && !S.demo ? '・色未確認' : ''}</div><div class="acts"><button data-ov="${esc(e.id)}" data-ovs="exclude">行っていない（外す）</button>${e.manual ? `<button data-ov="${esc(e.id)}" data-ovs="clear">元に戻す</button>` : ''}</div>`)).join('') : '<p class="muted">まだありません</p>'}</div>
  ${siteNotesBlock(key)}
  ${ex.length ? `<div class="card"><h3 style="margin-top:0">数えていない予定</h3>${ex.map(e => evRow(e, `<span class="pill ${e.reason}">${esc(reasonText(e))}</span>${e.manual ? ` <button data-ov="${esc(e.id)}" data-ovs="clear">元に戻す</button>` : ''}`)).join('')}</div>` : ''}`;
}
// ---------- 気づき ----------
const catPill = c => `<span class="cat ${N.CAT_CLASS[c] || 'c4'}">${esc(c)}</span>`;
const noteSite = n => n.site ? (S.byKey[n.site] ? S.byKey[n.site].name : (n.siteName || n.site)) : '現場なし（全体）';
function noteCard(n, withSite = true) {
  return `<div class="card note-c" data-note="${esc(n.id)}"><div class="nh"><b>${md(n.date)}(${wd(n.date)})</b>${catPill(n.cat)}${n.photo ? '<span title="写真あり">📷</span>' : ''}</div>${withSite ? `<div class="ns">🏗 ${esc(noteSite(n))}</div>` : ''}<div class="nt">${esc(n.text)}</div></div>`;
}
function siteNotesBlock(key) {
  const ns = N.filterNotes(S.notes || [], { site: key });
  return `<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h3 style="margin:0">💡 この現場の気づき（${ns.length}件）</h3><button class="primary" data-nadd="${esc(key)}">＋ 気づきを追加</button></div>${ns.map(n => noteCard(n, false)).join('') || '<p class="muted small">まだありません</p>'}</div>`;
}
function notesSiteOptions(sel, allLabel) {
  const used = new Set((S.notes || []).map(n => n.site).filter(Boolean));
  const sites = S.a.allSites.filter(s => !s.hidden && (!s.done || used.has(s.key) || s.key === sel)).sort((a, b) => (used.has(b.key) - used.has(a.key)) || a.name.localeCompare(b.name, 'ja'));
  const orphan = [...used].filter(k => !S.byKey[k] && k === sel);
  return `<option value="">${allLabel}</option>${sites.map(s => `<option value="${esc(s.key)}" ${s.key === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}${orphan.map(k => `<option value="${esc(k)}" selected>${esc(k)}</option>`).join('')}`;
}
function notesList() {
  const f = S.nf || {}, all = S.notes || [], ns = N.filterNotes(all, f, siteName);
  return `<p class="muted small" style="margin:4px 2px">${ns.length}件${ns.length !== all.length ? `（全${all.length}件中）` : ''}・新しい順</p>${ns.map(n => noteCard(n)).join('') || `<p class="muted">${all.length ? '当てはまる気づきはありません' : 'まだありません。現場で気づいたことを「＋ 気づきを追加」から残せます。'}</p>`}`;
}
function viewNotes() {
  const f = S.nf = S.nf || { q: '', cat: '', site: '' };
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h2>💡 気づき</h2><button class="primary" data-nadd="">＋ 気づきを追加</button></div>
  ${S.notesErr ? `<div class="note">気づきを読み込めませんでした：${esc(S.notesErr)}（開き直してください）</div>` : ''}
  <div class="card nf"><input type="search" id="nq" placeholder="🔎 語句で探す（例：スポコン、打ち継ぎ）" value="${esc(f.q)}" enterkeyhint="search">
  <div class="chips" role="group" aria-label="カテゴリ"><button class="chip ${f.cat ? '' : 'on'}" data-nfcat="">すべて</button>${N.CATS.map(c => `<button class="chip ${N.CAT_CLASS[c]} ${f.cat === c ? 'on' : ''}" data-nfcat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <select id="nsite" aria-label="現場">${notesSiteOptions(f.site, 'すべての現場')}</select></div>
  <div id="nlist">${notesList()}</div>`;
}
function noteForm(n) {
  S.form = { id: n ? n.id : null, blob: null, w: 0, h: 0, removePhoto: false, old: n || null };
  const site = n ? n.site : (S.formSite || '');
  sheet(`<h3 style="margin-top:0">${n ? '✏️ 気づきを直す' : '💡 気づきを追加'}</h3><form id="nform">
  <label>本文（必須）<textarea id="ntext" rows="5" placeholder="例：打ち継ぎ面のスポコンに隙間。職長が気づいて埋めるべき">${esc(n ? n.text : '')}</textarea></label>
  <div class="small muted" style="margin-top:8px">カテゴリ</div><div class="chips" id="ncats">${N.CATS.map(c => `<button type="button" class="chip ${N.CAT_CLASS[c]} ${n && n.cat === c ? 'on' : ''}" data-ncat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div style="display:flex;gap:6px;margin-top:8px"><label style="flex:2;min-width:0">現場<select id="nsitef">${notesSiteOptions(site, '現場なし（全体）')}</select></label><label style="flex:0 0 150px">日付<input type="date" id="ndate" value="${esc(n ? n.date : S.today)}"></label></div>
  <div class="small muted" style="margin-top:8px">写真（任意・1枚）</div>
  <div id="nphwrap">${n && n.photo ? `<div class="ph" data-phpath="${esc(n.photo)}">写真を読み込み中…</div>` : ''}</div>
  <div class="acts"><label class="filebtn">📷 写真を撮る・選ぶ<input type="file" id="nfile" accept="image/*" hidden></label><button type="button" data-nphclear ${n && n.photo ? '' : 'hidden'}>写真を外す</button></div>
  <p id="nmsg" class="small" style="color:var(--ng);min-height:1em"></p>
  <button type="submit" class="primary" id="nsave" style="width:100%">保存</button></form>`);
  const ph = $('#sheet [data-phpath]'); if (ph) showPhoto(ph);
}
function noteDetail(id) {
  const n = (S.notes || []).find(x => x.id === id); if (!n) return;
  sheet(`<div class="nh"><b>${md(n.date)}(${wd(n.date)})</b>${catPill(n.cat)}</div><h3 style="margin:6px 0">🏗 ${esc(noteSite(n))}</h3><div class="nt full">${esc(n.text)}</div>
  ${n.photo ? `<div class="ph" data-phpath="${esc(n.photo)}">写真を読み込み中…</div>` : ''}
  <p class="muted small">登録 ${esc((n.created || '').slice(0, 10))}${n.updated && n.updated !== n.created ? `・更新 ${esc(n.updated.slice(0, 10))}` : ''}</p>
  <div class="acts"><button data-nedit="${esc(n.id)}">✏️ 直す</button><button data-ndel="${esc(n.id)}" style="color:var(--ng)">🗑 削除</button>${n.site && S.byKey[n.site] ? `<button data-gosite="${esc(n.site)}">現場の詳細へ</button>` : ''}</div>`);
  const ph = $('#sheet [data-phpath]'); if (ph) showPhoto(ph);
}
async function photoBlob(path) {
  S.photoCache = S.photoCache || {}; if (S.photoCache[path]) return S.photoCache[path];
  const b = S.demo ? S.demoPhotos[path] : await S.st.photos.get(path, S.pass); if (!b) throw new Error('写真がありません');
  return (S.photoCache[path] = URL.createObjectURL(b));
}
async function showPhoto(el) { try { const u = await photoBlob(el.dataset.phpath); el.innerHTML = `<img src="${u}" alt="気づきの写真">`; } catch (e) { el.textContent = '写真を読めませんでした：' + (e.auth ? '鍵の期限切れかもしれません' : e.message); } }
async function saveNote() {
  const F = S.form, msg = t => { $('#nmsg').textContent = t; };
  const cat = ($('#ncats .chip.on') || {}).dataset?.ncat || '', siteKey = $('#nsitef').value, now = new Date().toISOString();
  const note = { id: F.id || N.newId(), date: $('#ndate').value, site: siteKey, siteName: siteKey ? siteName(siteKey) : '', cat, text: $('#ntext').value.trim(), photo: F.old ? F.old.photo || null : null, created: F.old ? F.old.created : now, updated: now };
  const bad = N.validNote(note); if (bad) { msg(bad); return; }
  const btn = $('#nsave'); btn.disabled = true; btn.textContent = '保存中…';
  const oldPhoto = note.photo; let newPath = null;
  try {
    if (F.blob) {
      newPath = N.photoPath(CFG.dir, note.id);
      if (S.demo) S.demoPhotos[newPath] = F.blob; else { btn.textContent = '写真を送信中…'; await S.st.photos.put(newPath, new Uint8Array(await F.blob.arrayBuffer()), S.pass); }
      note.photo = newPath; note.photoW = F.w; note.photoH = F.h;
    } else if (F.removePhoto) { note.photo = null; delete note.photoW; delete note.photoH; }
  } catch (e) { msg('写真を保存できませんでした：' + (e.auth ? '鍵の期限切れかもしれません' : e.message)); btn.disabled = false; btn.textContent = '保存'; return; }
  btn.textContent = '保存中…';
  const ok = await changeNotes(list => N.upsertNote(list, note), F.old ? '気づきを直す' : '気づきを追加');
  if (!ok) { if (newPath && !S.demo) S.st.photos.del(newPath).catch(() => {}); if ($('#nsave')) { btn.disabled = false; btn.textContent = '保存'; } return; }
  if (oldPhoto && oldPhoto !== note.photo && !S.demo) S.st.photos.del(oldPhoto).catch(() => toast('古い写真のファイルは消せませんでした（気づきは保存済み）'));
  $('#sheet').hidden = true; S.form = null;
}
async function deleteNote(id) {
  const n = (S.notes || []).find(x => x.id === id); if (!n) return;
  if (!confirm(`この気づきを削除しますか？\n${md(n.date)} ${n.cat}\n（元に戻せません）`)) return;
  const ok = await changeNotes(list => N.removeNote(list, id), '気づきを削除'); if (!ok) return;
  $('#sheet').hidden = true;
  if (n.photo && !S.demo) S.st.photos.del(n.photo).catch(() => toast('写真のファイルは消せませんでした（気づきは削除済み）'));
}
const KIND = { ask: '金子さんに確認中', ambiguous: '候補が2つ以上', nosite: '現場が分からない', similar: '現場名に似ているがパトロールか不明', kind: 'パトロールか分からない（式・謝罪など）' };
function siteSelect(e) {
  const opts = (e.options || []).filter(k => S.byKey[k]), rest = S.a.sites.filter(s => !opts.includes(s.key)).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return `<select data-sel="${esc(e.id)}">${opts.map(k => `<option value="${esc(k)}">候補：${esc(siteName(k))}</option>`).join('')}<option value="">— ほかの現場 —</option>${rest.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('')}</select>`;
}
function viewCheck() {
  const inFy = e => P.fyOf(e.date) === S.fy;
  const un = S.a.events.filter(e => e.status === 'unsure' && inFy(e)).sort((a, b) => b.date.localeCompare(a.date));
  const ex = S.a.events.filter(e => e.status === 'exclude' && inFy(e)).sort((a, b) => b.date.localeCompare(a.date));
  return `<h2>除外チェック <small class="muted">${S.fy}年度</small></h2>
  <h3>🔍 要確認・未割り当て（${un.length}件）</h3><p class="muted small">決めるまで数えません。現場を選んで「数える」か「数えない」を押してください。</p>
  ${un.map(e => `<div class="card q">${evRow(e, `<div class="why">${esc(KIND[e.kind] || '')}${e.note ? '：' + esc(e.note) : ''}</div>${siteSelect(e)}<label class="small" style="display:block;margin-top:4px"><input type="checkbox" data-alias="${esc(e.id)}"> 「${esc(e.title)}」をこの現場の別名として覚える</label><div class="acts"><button class="primary" data-ov="${esc(e.id)}" data-ovs="count">この現場で数える</button><button data-ov="${esc(e.id)}" data-ovs="exclude">数えない</button></div>`)}</div>`).join('') || '<p class="muted">ありません 👍</p>'}
  <h3>🚫 外した予定（${ex.length}件）</h3>
  <div class="card">${ex.map(e => evRow(e, `<span class="pill ${e.reason}">${esc(reasonText(e))}</span>${e.site ? ` <small class="muted">${esc(siteName(e.site))}</small>` : ''}${e.manual ? ` <button data-ov="${esc(e.id)}" data-ovs="clear">元に戻す</button>` : ''}`)).join('') || '<p class="muted">ありません</p>'}</div>`;
}
function viewSettings() {
  const sp = S.settings.special || [];
  return `<h2>設定</h2>
  <div class="card"><h3 style="margin-top:0">🎯 特別目標の期間</h3><p class="muted small">期間・回数を変えたり、追加できます。対象は新築だけ（改修は外す）。</p>
  ${sp.map((p, i) => `<div class="card" data-sprow="${i}"><label>名前<input type="text" data-f="label" value="${esc(p.label)}"></label><div style="display:flex;gap:6px"><label style="flex:1">はじめ<input type="date" data-f="start" value="${esc(p.start)}"></label><label style="flex:1">おわり<input type="date" data-f="end" value="${esc(p.end)}"></label><label style="width:80px">回数<input type="number" min="1" max="20" data-f="target" value="${p.target}"></label></div><div class="acts"><button data-spdel="${i}">この期間を消す</button></div></div>`).join('')}
  <div class="acts"><button data-spadd>＋ 期間を追加</button><button class="primary" data-spsave>特別目標を保存</button></div></div>
  <div class="card"><h3 style="margin-top:0">✅ 月${S.settings.monthlyTarget || 2}回・特別目標の対象（新築）</h3><p class="muted small">まだ始まっていない現場などはチェックを外すと、⚠️・赤・特別目標から外れます（回数は記録されます）。</p>
  ${S.a.sites.filter(s => s.category === '新築' && !s.done).sort((a, b) => a.name.localeCompare(b.name, 'ja')).map(s => `<label style="display:flex;gap:8px;align-items:center;min-height:40px"><input type="checkbox" data-tgt="${esc(s.key)}" ${s.noTarget ? '' : 'checked'}> ${esc(s.name)}</label>`).join('')}
  <div class="acts"><button class="primary" data-tgtsave>対象を保存</button></div></div>
  <div class="card"><h3 style="margin-top:0">👁️ 表示する現場</h3><p class="muted small">チェックを外すと「非表示」：今月・年度・年末目標に出ません。その現場の予定は消さずに 除外チェック に「非表示の現場」で残ります。</p>
  ${S.a.allSites.filter(s => !s.done || s.hidden).sort((a, b) => (b.hidden - a.hidden) || a.name.localeCompare(b.name, 'ja')).map(s => `<label style="display:flex;gap:8px;align-items:center;min-height:40px"><input type="checkbox" data-show="${esc(s.key)}" ${s.hidden ? '' : 'checked'}> ${esc(s.name)}${s.hidden ? ' <span class="tag">非表示</span>' : ''}</label>`).join('')}
  <div class="acts"><button class="primary" data-showsave>表示を保存</button></div></div>
  <div class="card"><h3 style="margin-top:0">🏷️ 現場の別名</h3><p class="muted small">カレンダーでの呼び方を「、」区切りで。例：〇〇西口、〇〇PT</p>
  ${S.a.sites.filter(s => !s.done || (S.settings.aliases[s.key] || []).length).sort((a, b) => a.name.localeCompare(b.name, 'ja')).map(s => `<label style="display:block;margin:8px 0"><b>${esc(s.name)}</b>${s.category === '改修' ? ' <span class="tag kai">改修</span>' : ''}<input type="text" data-aliasfor="${esc(s.key)}" value="${esc((S.settings.aliases[s.key] || []).join('、'))}"></label>`).join('')}
  <div class="acts"><button class="primary" data-aliassave>別名を保存</button></div></div>
  <div class="card"><h3 style="margin-top:0">➕ パトロール専用の現場（山積みには入りません）</h3><p class="muted small">区分が分からないときは「未確認」（目標の対象外）。</p>
  ${(S.settings.extraSites || []).map((x, i) => `<div class="card" data-xrow="${i}"><label>現場名<input type="text" data-x="name" value="${esc(x.name)}"></label><div style="display:flex;gap:6px"><label style="flex:1">区分<select data-x="category">${P.CATEGORIES.map(c => `<option value="${c}" ${c === (x.category || '') ? 'selected' : ''}>${c || '未確認'}</option>`).join('')}</select></label><label style="flex:2">チーム・元方<input type="text" data-x="team" value="${esc(x.team || '')}"></label></div><label>メモ<input type="text" data-x="note" value="${esc(x.note || '')}"></label><label class="small"><input type="checkbox" data-x="done" ${x.done ? 'checked' : ''}> 終わった・やらない現場</label> <button data-xdel>消す</button></div>`).join('')}
  <div class="acts"><button data-xadd>＋ 現場を追加</button><button class="primary" data-xsave>現場を保存</button></div></div>
  <div class="card"><h3 style="margin-top:0">🚫 予定名のルール</h3><p class="muted small">予定名にこの文字があれば「数えない」または「確認待ち」にします（「、」区切り）。</p>
  ${(S.settings.rules || []).map((r, i) => `<div class="card" data-rrow="${i}"><label>文字<input type="text" data-r="patterns" value="${esc((r.patterns || []).join('、'))}"></label><div style="display:flex;gap:6px"><label style="flex:1">する事<select data-r="action"><option value="exclude" ${r.action === 'exclude' ? 'selected' : ''}>数えない</option><option value="ask" ${r.action === 'ask' ? 'selected' : ''}>確認待ち</option></select></label><label style="flex:2">理由<input type="text" data-r="label" value="${esc(r.label || '')}"></label></div><button data-rdel>消す</button></div>`).join('')}
  <div class="acts"><button data-radd>＋ ルールを追加</button><button class="primary" data-rsave>ルールを保存</button></div></div>
  <div class="card small muted">月の目標：${S.settings.monthlyTarget || 2}回（新築）・カレンダー同期：${S.meta.syncedAt ? esc(S.meta.syncedAt.slice(0, 16).replace('T', ' ')) + '（UTC）' : '—'}・色の情報：${S.meta.colorAvailable ? 'あり' : 'なし'}${S.demo ? '' : '<br><button data-logout>ログアウト（この端末の合言葉を消す）</button>'}</div>`;
}
function render() {
  const h = location.hash.replace('#', '') || 'month', [v, arg] = h.split('/');
  S.view = v; document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === v || (v === 'site' && a.dataset.nav === 'month')));
  main.innerHTML = v === 'notes' ? viewNotes() : v === 'year' ? viewYear() : v === 'check' ? viewCheck() : v === 'settings' ? viewSettings() : v === 'site' ? viewSite(decodeURIComponent(arg || '')) : viewMonth();
  $('#status').textContent = statusText();
}
function sheet(html) { const s = $('#sheet'); s.innerHTML = `<div class="box">${html}<p><button data-close style="width:100%">閉じる</button></p></div>`; s.hidden = false; }

main.addEventListener('click', e => {
  const t = e.target.closest('button,[data-site],[data-cell],[data-note]'); if (!t) return;
  if (t.dataset.nadd !== undefined) { S.formSite = t.dataset.nadd; noteForm(null); }
  else if (t.dataset.note) noteDetail(t.dataset.note);
  else if (t.dataset.nfcat !== undefined) { S.nf.cat = t.dataset.nfcat; main.querySelectorAll('[data-nfcat]').forEach(b => b.classList.toggle('on', b.dataset.nfcat === S.nf.cat)); $('#nlist').innerHTML = notesList(); }
  else if (t.dataset.ym) { S.ym = addYm(S.ym, +t.dataset.ym); render(); }
  else if (t.dataset.fy) { S.fy += +t.dataset.fy; render(); }
  else if (t.dataset.cell) { const [k, ym] = t.dataset.cell.split('|'), vs = P.visitsOf(S.a, k).filter(x => x.date.startsWith(ym)); sheet(`<h3>${esc(siteName(k))}<br><small class="muted">${ymLabel(ym)}：${vs.length}回</small></h3>${vs.map(x => evRow(x)).join('') || '<p class="muted">この月は行っていません</p>'}<p><button data-gosite="${esc(k)}">現場の詳細へ</button></p>`); }
  else if (t.dataset.showsp) { const p = S.settings.special.find(x => x.id === t.dataset.showsp); sheet(specialBlock(p)); }
  else if (t.dataset.back !== undefined) history.back();
  else if (t.dataset.ov) {
    const id = t.dataset.ov, ovs = t.dataset.ovs, ev = S.a.events.find(x => x.id === id);
    const sel = main.querySelector(`[data-sel="${CSS.escape(id)}"]`), site = sel && sel.value, alias = main.querySelector(`[data-alias="${CSS.escape(id)}"]`);
    if (ovs === 'count' && !site) { toast('現場を選んでください'); return; }
    changeSettings(st => {
      st.overrides = st.overrides || {};
      if (ovs === 'clear') delete st.overrides[id];
      else st.overrides[id] = ovs === 'count' ? { status: 'count', site, date: ev.date } : { status: 'exclude', date: ev.date, site: ev.site || null };
      if (ovs === 'count' && alias && alias.checked) { st.aliases = st.aliases || {}; const l = st.aliases[site] = st.aliases[site] || []; const n = P.norm(ev.title); if (!l.some(x => P.norm(x) === n)) l.push(ev.title.trim()); }
    }, ovs === 'count' ? '予定を現場に割り当て' : ovs === 'exclude' ? '予定を外す' : '手の設定を戻す');
  }
  else if (t.dataset.spadd !== undefined) { S.settings.special.push({ id: 'sp-' + Date.now().toString(36), label: '特別目標', start: S.today, end: S.today, target: 3, category: '新築' }); render(); }
  else if (t.dataset.spdel !== undefined) { t.closest('[data-sprow]').remove(); }
  else if (t.dataset.spsave !== undefined) {
    const rows = [...main.querySelectorAll('[data-sprow]')].map(r => { const old = (S.settings.special || [])[+r.dataset.sprow] || {}; const g = f => r.querySelector(`[data-f="${f}"]`).value; return { id: old.id || 'sp-' + Date.now().toString(36), label: g('label').trim() || '特別目標', start: g('start'), end: g('end'), target: Math.max(1, parseInt(g('target'), 10) || 1), category: '新築' }; });
    if (rows.some(r => !r.start || !r.end || r.start > r.end)) { toast('はじめ・おわりの日付を確かめてください'); return; }
    changeSettings(st => { st.special = rows; }, '特別目標を変更');
  }
  else if (t.dataset.showsave !== undefined) { const shown = new Set([...main.querySelectorAll('[data-show]')].filter(i => i.checked).map(i => i.dataset.show)), listed = [...main.querySelectorAll('[data-show]')].map(i => i.dataset.show); changeSettings(st => { st.hidden = [...new Set([...(st.hidden || []).filter(k => !listed.includes(k)), ...listed.filter(k => !shown.has(k))])]; }, '表示する現場を変更'); }
  else if (t.dataset.tgtsave !== undefined) { const off = [...main.querySelectorAll('[data-tgt]')].filter(i => !i.checked).map(i => i.dataset.tgt); changeSettings(st => { st.noTarget = off; }, '目標の対象を変更'); }
  else if (t.dataset.xadd !== undefined) { S.settings.extraSites = [...(S.settings.extraSites || []), { name: '', category: '', team: '', note: '', done: false }]; render(); }
  else if (t.dataset.xdel !== undefined || t.dataset.rdel !== undefined) { t.closest('[data-xrow],[data-rrow]').remove(); }
  else if (t.dataset.xsave !== undefined) {
    const rows = [...main.querySelectorAll('[data-xrow]')].map(r => { const g = f => r.querySelector(`[data-x="${f}"]`); return { name: g('name').value.trim(), category: g('category').value, team: g('team').value.trim(), note: g('note').value.trim(), done: g('done').checked }; }).filter(x => P.norm(x.name).length >= 2);
    changeSettings(st => { st.extraSites = rows; }, 'パトロール専用の現場を変更');
  }
  else if (t.dataset.radd !== undefined) { S.settings.rules = [...(S.settings.rules || []), { id: 'r-' + Date.now().toString(36), patterns: [], action: 'exclude', label: '' }]; render(); }
  else if (t.dataset.rsave !== undefined) {
    const rows = [...main.querySelectorAll('[data-rrow]')].map(r => { const old = (S.settings.rules || [])[+r.dataset.rrow] || {}; const g = f => r.querySelector(`[data-r="${f}"]`).value; return { ...old, id: old.id || 'r-' + Date.now().toString(36), patterns: g('patterns').split(/[、,，]/).map(x => x.trim()).filter(x => P.norm(x).length >= 2), action: g('action'), label: g('label').trim() }; }).filter(r => r.patterns.length);
    changeSettings(st => { st.rules = rows; }, '予定名のルールを変更');
  }
  else if (t.dataset.aliassave !== undefined) {
    const m = {}; main.querySelectorAll('[data-aliasfor]').forEach(i => { const l = i.value.split(/[、,，]/).map(x => x.trim()).filter(x => P.norm(x).length >= 2); if (l.length) m[i.dataset.aliasfor] = l; });
    changeSettings(st => { const keep = Object.fromEntries(Object.entries(st.aliases || {}).filter(([k]) => !main.querySelector(`[data-aliasfor="${CSS.escape(k)}"]`))); st.aliases = { ...keep, ...m }; }, '別名を変更');
  }
  else if (t.dataset.logout !== undefined) { if (!confirm('この端末のログインを消しますか？次に開くとき合言葉が要ります。')) return; forget().then(() => location.reload()); }
  else if (t.dataset.site) location.hash = 'site/' + encodeURIComponent(t.dataset.site);
});
main.addEventListener('input', e => { if (e.target.id === 'nq') { S.nf.q = e.target.value; $('#nlist').innerHTML = notesList(); } });
main.addEventListener('change', e => { if (e.target.id === 'nsite') { S.nf.site = e.target.value; $('#nlist').innerHTML = notesList(); } });
$('#sheet').addEventListener('change', async e => {
  if (e.target.id !== 'nfile' || !e.target.files[0]) return;
  const w = $('#nphwrap'), btn = $('#nsave'); w.innerHTML = '<div class="ph">写真を小さくしています…</div>'; btn.disabled = true;
  try { const r = await N.shrinkImage(e.target.files[0]); Object.assign(S.form, { blob: r.blob, w: r.w, h: r.h, removePhoto: false }); w.innerHTML = `<div class="ph"><img src="${URL.createObjectURL(r.blob)}" alt="選んだ写真"></div><p class="muted small">${r.w}×${r.h}・${Math.round(r.blob.size / 1024)}KB（元 ${Math.round(r.orig / 1024)}KB）</p>`; $('#sheet [data-nphclear]').hidden = false; }
  catch (err) { w.innerHTML = ''; $('#nmsg').textContent = err.message; }
  btn.disabled = false; e.target.value = '';
});
$('#sheet').addEventListener('submit', e => { if (e.target.id === 'nform') { e.preventDefault(); saveNote(); } });
$('#sheet').addEventListener('click', e => { const t = e.target;
  if (t.closest('#nform') || t.dataset.nedit || t.dataset.ndel) {
    if (t.dataset.ncat) { $('#sheet').querySelectorAll('[data-ncat]').forEach(b => b.classList.toggle('on', b === t)); }
    else if (t.dataset.nphclear !== undefined) { Object.assign(S.form, { blob: null, removePhoto: true }); $('#nphwrap').innerHTML = '<p class="muted small">写真なしで保存します</p>'; t.hidden = true; }
    else if (t.dataset.nedit) noteForm((S.notes || []).find(x => x.id === t.dataset.nedit));
    else if (t.dataset.ndel) deleteNote(t.dataset.ndel);
    return;
  }
  if (t.id === 'sheet' && S.form && $('#nform')) return; // 入力中は外側を押しても閉じない（「閉じる」で閉じる）
  if (t.id === 'sheet' || t.dataset.close !== undefined) $('#sheet').hidden = true; else if (t.dataset.gosite) { $('#sheet').hidden = true; location.hash = 'site/' + encodeURIComponent(t.dataset.gosite); } else { const r = t.closest('[data-site]'); if (r) { $('#sheet').hidden = true; location.hash = 'site/' + encodeURIComponent(r.dataset.site); } } });
addEventListener('hashchange', () => { $('#sheet').hidden = true; render(); scrollTo(0, 0); });

// ---------- ログイン（この端末で覚える） ----------
// 合言葉そのものは保存しない：取り出せない端末鍵（IndexedDB の CryptoKey）で暗号化したものだけを localStorage に置く。
// （データごとに別の塩で鍵を作り、保存のたびに新しく暗号化するため、合言葉と同じ働きのものが要る）
const REM = 'patrol-remember', IDB = 'kaneko-patrol', subtle = crypto.subtle;
const idb = mode => new Promise((ok, ng) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onerror = () => ng(r.error); r.onsuccess = () => ok(r.result.transaction('keys', mode).objectStore('keys')); });
const idbReq = q => new Promise((ok, ng) => { q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error); });
async function deviceKey(create) {
  let k = await idbReq((await idb('readonly')).get('device')).catch(() => null);
  if (!k && create) { k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await idbReq((await idb('readwrite')).put(k, 'device')); }
  return k;
}
const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u))), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function rememberPass(pass) {
  try { const k = await deviceKey(true), iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(pass)); localStorage.setItem(REM, JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) })); }
  catch (e) { localStorage.removeItem(REM); } // 覚えられない端末（プライベートモード等）は毎回入力
}
async function recallPass() {
  try { const r = JSON.parse(localStorage.getItem(REM) || 'null'); if (!r) return null; const k = await deviceKey(false); if (!k) return null; return new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.iv) }, k, unb64(r.ct))); }
  catch (e) { return null; }
}
async function forget() { localStorage.removeItem(REM); sessionStorage.removeItem('patrol-session'); try { await idbReq((await idb('readwrite')).delete('device')); } catch (e) { /* なければよい */ } }

async function start() { $('#nav').hidden = false; main.innerHTML = '<p>読み込み中…</p>'; await loadAll(); render(); }
function login(msg = '') {
  $('#nav').hidden = true;
  main.innerHTML = `<div class="login card"><h2>🔒 パトロール履歴</h2><p class="muted">パトロール用の合言葉を入れてください。この端末では次から入れなくて大丈夫です（設定 →「ログアウト」で消せます）。</p><form id="lf"><input type="password" id="pw" autocomplete="current-password" placeholder="合言葉"><p style="color:var(--ng)">${esc(msg)}</p><button class="primary" style="width:100%">ひらく</button></form><p class="small"><a href="?demo=1">お試し表示（架空のデータ）</a></p></div>`;
  $('#lf').addEventListener('submit', async ev => {
    ev.preventDefault(); const pass = $('#pw').value.trim(); main.querySelector('button').disabled = true;
    const token = await decryptSecret(CFG.encToken, pass).catch(() => null);
    if (!token) { login('合言葉が違います'); return; }
    S.pass = pass; S.token = token; await rememberPass(pass);
    try { await start(); } catch (e) { login(e.auth ? '鍵の期限切れかもしれません（連絡してください）' : e.message); }
  });
}
(async () => {
  if (S.demo) { await start(); return; }
  const pass = await recallPass();
  if (pass) {
    const token = await decryptSecret(CFG.encToken, pass).catch(() => null);
    if (!token) { await forget(); login('合言葉が変わりました。もう一度入れてください。'); return; }
    S.pass = pass; S.token = token;
    try { await start(); return; } catch (e) { login(e.auth ? '鍵の期限切れかもしれません（連絡してください）' : '読み込めませんでした（電波を確かめて開き直してください）：' + e.message); return; }
  }
  login();
})();
