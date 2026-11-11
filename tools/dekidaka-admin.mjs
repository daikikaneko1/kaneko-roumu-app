#!/usr/bin/env node
// 出来高の鍵・データの管理（管理者のパソコン用）。合言葉・トークン・金額は画面にもログにも出しません。
//  node tools/dekidaka-admin.mjs keys    <token> <入力用合言葉> <閲覧用合言葉> [--scope N]  … 鍵を作り config.js を更新（作り直すと過去のデータは読めなくなるので注意）
//  node tools/dekidaka-admin.mjs scope   N                                                    … 入力用の範囲だけ変える（鍵はそのまま）→ config.js をコミット → rekey
//  node tools/dekidaka-admin.mjs retoken <token> <入力用合言葉> <閲覧用合言葉> [新しい入力用] [新しい閲覧用] … トークンの作り直し・合言葉の変更（鍵とデータはそのまま）
//  node tools/dekidaka-admin.mjs migrate <excel.json> <閲覧用合言葉> [commit]                 … Excel のデータを初回登録（state.json が無いときだけ）
//  node tools/dekidaka-admin.mjs rekey   <閲覧用合言葉> [commit]                              … 未取り込みの入力を取り込み、今の範囲で暗号化し直す
//  node tools/dekidaka-admin.mjs sites   <閲覧用合言葉> <現場名> <労務の現場ID,…|-> [commit] [--common 鳶=N,土工=N] … 現場ごとに分ける移行（1回だけ）：現場を1つ作り全部の請書・合算グループをそこへ、共通の目標単価。数字が前後で同じか確かめる
//  node tools/dekidaka-admin.mjs kogu    <閲覧用合言葉> [commit]                              … 工事区分「小口」の請書に種別「小口（単月請求）」をつける（1回だけ）。数字が前後で同じか確かめる
//  node tools/dekidaka-admin.mjs check   <入力用合言葉> <閲覧用合言葉>                         … 復号の確認（件数だけ表示）
//  <token> などはファイルのパス
import fs from 'fs';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { generateRoleKey, importPriv } from '../dk-crypto.js';
import { GitHubBackend, DekidakaStore } from '../dk-store.js';
import { applyOps, readableDatasets, overlayEntries, sitesMigrationOps, koguMigrationOps, figures } from '../dk-core.js';
import { ConflictError } from '../store.js';
import { buildState } from './dekidaka-build.mjs';
const CFG = new URL('../config.js', import.meta.url).pathname;
const read = f => fs.readFileSync(f, 'utf8').trim();
const loadCfg = async () => (await import(CFG + '?t=' + Date.now())).default;
function writeDk(block) {
  let src = fs.readFileSync(CFG, 'utf8');
  const line = `  dekidaka: ${JSON.stringify(block)},`;
  src = /\n  dekidaka: .*\n/.test(src) ? src.replace(/\n  dekidaka: .*\n/, '\n' + line + '\n') : src.replace(/\n};\s*$/, '\n' + line + '\n};\n');
  fs.writeFileSync(CFG, src);
}
async function bundle(role, token, priv, pass) { const b = await encryptSecret(JSON.stringify({ role, token, priv }), pass); if (!(await decryptSecret(b, pass))) throw new Error('検証失敗'); return b; }
async function unlock(cfg, role, passFile) {
  const s = await decryptSecret(cfg.dekidaka.bundle[role], read(passFile)); if (!s) throw new Error(`${role} の合言葉が違います`);
  const o = JSON.parse(s); return { token: o.token, priv: await importPriv(o.priv), privB64: o.priv };
}
const storeFor = (cfg, role, u) => new DekidakaStore({ backend: new GitHubBackend({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, token: u.token }), dir: cfg.dekidaka.dir, role, priv: u.priv, pubs: cfg.dekidaka.pub, scope: cfg.dekidaka.inputScope });
const [cmd, ...a] = process.argv.slice(2);
const cfg = await loadCfg();
if (cmd === 'keys') {
  const [tokF, inF, viewF] = a; const si = a.indexOf('--scope'); const scope = si >= 0 ? Number(a[si + 1]) : 0;
  const token = read(tokF), pin = read(inF), pview = read(viewF);
  const roumuF = new URL('../../secret/passphrase.txt', import.meta.url).pathname;
  if (pin === pview || (fs.existsSync(roumuF) && [pin, pview].includes(read(roumuF)))) throw new Error('合言葉は労務用・入力用・閲覧用で別にしてください');
  if (cfg.dekidaka && cfg.dekidaka.pub && !a.includes('--force')) throw new Error('鍵はもうあります（作り直すと今のデータが読めなくなります。--force で強制）');
  const v = await generateRoleKey(), i = await generateRoleKey();
  writeDk({ dir: 'data/dekidaka', inputScope: scope, pub: { view: v.pub, input: i.pub }, bundle: { view: await bundle('view', token, v.priv, pview), input: await bundle('input', token, i.priv, pin) } });
  console.log(`config.js に出来高の鍵を書きました（入力用の範囲 ${scope}）。`);
} else if (cmd === 'scope') {
  const n = Number(a[0]); if (![0, 1, 2].includes(n)) throw new Error('範囲は 0 / 1 / 2');
  writeDk({ ...cfg.dekidaka, inputScope: n });
  console.log(`入力用の範囲を ${n} にしました。config.js をコミットし、rekey で暗号化し直してください。`);
} else if (cmd === 'retoken') {
  const [tokF, inF, viewF, newInF, newViewF] = a; const token = read(tokF);
  if (!/^(github_pat_|ghp_)/.test(token)) throw new Error('トークンの形式が違うようです');
  const vi = await unlock(cfg, 'view', viewF), ii = await unlock(cfg, 'input', inF);
  const pin = read(newInF || inF), pview = read(newViewF || viewF); if (pin === pview) throw new Error('入力用と閲覧用は別の合言葉に');
  writeDk({ ...cfg.dekidaka, bundle: { view: await bundle('view', token, vi.privB64, pview), input: await bundle('input', token, ii.privB64, pin) } });
  console.log('config.js のトークン／合言葉を更新しました（鍵・データはそのまま）。config.js をコミットしてください。');
} else if (cmd === 'migrate') {
  const [xf, viewF, commit] = a; const u = await unlock(cfg, 'view', viewF); const st = storeFor(cfg, 'view', u);
  const doc = buildState(JSON.parse(fs.readFileSync(xf, 'utf8')));
  const exists = await st.backend.getFile(st.statePath);
  console.log(`請書 ${doc.keisho.length}件・月の記録 ${Object.keys(doc.records).length}件。state.json ${exists ? 'あり' : 'なし'}`);
  if (exists) throw new Error('state.json はもうあります（上書きしません）');
  if (commit !== 'commit') { console.log('dry run'); process.exit(0); }
  const sha = await st.save(doc, null, '出来高：Excel「出来高管理システム」から移行（暗号化済み）'); console.log('saved sha', sha);
} else if (cmd === 'rekey') {
  const [viewF, commit] = a; const u = await unlock(cfg, 'view', viewF); const st = storeFor(cfg, 'view', u);
  const { doc, sha } = await st.load(); const { entries, unreadable } = await st.pendingEntries(doc.merged);
  const next = applyOps(doc, [{ type: 'merge', entries }]);
  console.log(`未取り込みの入力 ${entries.length}件（読めない ${unreadable}件）。範囲 ${cfg.dekidaka.inputScope} で暗号化し直します`);
  if (commit !== 'commit') { console.log('dry run'); process.exit(0); }
  next.updatedAt = new Date().toISOString(); next.updatedBy = '管理者（暗号化し直し）';
  console.log('saved sha', await st.save(next, sha, `出来高：暗号化し直し（入力用の範囲 ${cfg.dekidaka.inputScope}）`));
} else if (cmd === 'sites') {
  const [viewF, name, ids, commit] = a; if (!name) throw new Error('現場名がありません');
  const u = await unlock(cfg, 'view', viewF); const st = storeFor(cfg, 'view', u);
  const site = { id: 'site-1', name, roumuIds: ids && ids !== '-' ? ids.split(',') : [], done: false };
  const ci = a.indexOf('--common'); // 例 --common 鳶=…,土工=…（目標単価。公開リポジトリには書かない）
  const common = ci >= 0 ? Object.fromEntries(a[ci + 1].split(',').map(x => x.split('=')).map(([t, v]) => [t, Number(v)])) : null;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const raw = await st.backend.getFile(st.statePath); if (!raw) throw new Error('state.json がありません');
    const bdir = new URL('../../backup/', import.meta.url).pathname; fs.mkdirSync(bdir, { recursive: true });
    const bf = `${bdir}dekidaka-state-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${raw.sha.slice(0, 7)}.json`; fs.writeFileSync(bf, raw.text); // 暗号文のまま
    const doc = await st.decryptState(JSON.parse(raw.text));
    const { entries, requests, unreadable } = await st.pendingEntries(doc.merged);
    const next = applyOps(doc, sitesMigrationOps(doc, site, common));
    const okBase = same(figures(doc), figures(next)), okOver = same(figures(overlayEntries(doc, entries)), figures(overlayEntries(next, entries)));
    console.log(`請書 ${doc.keisho.length}件・グループ ${doc.groups.length}件・記録 ${Object.keys(doc.records).length}件・未取り込みの入力 ${entries.length}件（申請 ${(requests || []).length}・読めない ${unreadable}）。バックアップ（暗号文）${bf.split('/').pop()}`);
    console.log(`数字の一致：保存済み ${okBase ? 'OK' : 'NG'}／入力を重ねた後 ${okOver ? 'OK' : 'NG'}`);
    if (!okBase || !okOver) throw new Error('数字が変わるので中止');
    if (commit !== 'commit') { console.log('dry run'); process.exit(0); }
    next.updatedAt = new Date().toISOString(); next.updatedBy = '管理者（現場ごとに分ける移行）';
    try { const sha = await st.save(next, raw.sha, `出来高：現場ごとに分ける（現場「${name}」に請書${doc.keisho.length}件、共通の目標単価）`); console.log('saved sha', sha); break; }
    catch (e) { if (e instanceof ConflictError && attempt < 4) { console.log('同時に更新あり → 取り直してやり直し'); continue; } throw e; }
  }
  const { doc: after } = await st.load(); const pe = await st.pendingEntries(after.merged);
  console.log(`保存後：現場 ${(after.settings.sites || []).length}件・siteId のある請書 ${after.keisho.filter(k => k.siteId).length}/${after.keisho.length}・グループ ${after.groups.filter(g => g.siteId).length}/${after.groups.length}・未取り込みの入力 ${pe.entries.length}件`);
} else if (cmd === 'kogu') {
  const [viewF, commit] = a; const u = await unlock(cfg, 'view', viewF); const st = storeFor(cfg, 'view', u);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const raw = await st.backend.getFile(st.statePath); if (!raw) throw new Error('state.json がありません');
    const bdir = new URL('../../backup/', import.meta.url).pathname; fs.mkdirSync(bdir, { recursive: true });
    const bf = `${bdir}dekidaka-state-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${raw.sha.slice(0, 7)}.json`; fs.writeFileSync(bf, raw.text); // 暗号文のまま
    const doc = await st.decryptState(JSON.parse(raw.text)); const { entries } = await st.pendingEntries(doc.merged);
    const ops = koguMigrationOps(doc); const next = applyOps(doc, ops);
    const okBase = same(figures(doc), figures(next)), okOver = same(figures(overlayEntries(doc, entries)), figures(overlayEntries(next, entries)));
    console.log(`小口にする請書 ${ops.length}件（${ops.map(o => o.id).join(',')}）・未取り込みの入力 ${entries.length}件。バックアップ（暗号文）${bf.split('/').pop()}`);
    console.log(`数字の一致：保存済み ${okBase ? 'OK' : 'NG'}／入力を重ねた後 ${okOver ? 'OK' : 'NG'}`);
    if (!okBase || !okOver) throw new Error('数字が変わるので中止');
    if (!ops.length) { console.log('変更なし'); break; }
    if (commit !== 'commit') { console.log('dry run'); process.exit(0); }
    next.updatedAt = new Date().toISOString(); next.updatedBy = '管理者（小口の種別）';
    try { console.log('saved sha', await st.save(next, raw.sha, `出来高：小口の請書に種別「小口（単月請求）」（${ops.length}件）`)); break; }
    catch (e) { if (e instanceof ConflictError && attempt < 4) { console.log('同時に更新あり → 取り直してやり直し'); continue; } throw e; }
  }
  const { doc: after } = await st.load(); console.log('保存後：小口', after.keisho.filter(k => k.kind === 'kogu').map(k => k.id).join(','));
} else if (cmd === 'check') {
  const [inF, viewF] = a;
  for (const [role, f] of [['view', viewF], ['input', inF]]) {
    const u = await unlock(cfg, role, f); const st = storeFor(cfg, role, u); const { doc } = await st.load();
    console.log(role, '読めた区分:', doc.readable.join(','), '想定:', readableDatasets(role, cfg.dekidaka.inputScope).join(','), '請書', doc.keisho.length, '記録', Object.keys(doc.records).length);
  }
} else { console.log('usage: see header'); process.exit(1); }
