#!/usr/bin/env node
// 出来高の鍵・データの管理（管理者のパソコン用）。合言葉・トークン・金額は画面にもログにも出しません。
//  node tools/dekidaka-admin.mjs keys    <token> <入力用合言葉> <閲覧用合言葉> [--scope N]  … 鍵を作り config.js を更新（作り直すと過去のデータは読めなくなるので注意）
//  node tools/dekidaka-admin.mjs scope   N                                                    … 入力用の範囲だけ変える（鍵はそのまま）→ config.js をコミット → rekey
//  node tools/dekidaka-admin.mjs migrate <excel.json> <閲覧用合言葉> [commit]                 … Excel のデータを初回登録（state.json が無いときだけ）
//  node tools/dekidaka-admin.mjs rekey   <閲覧用合言葉> [commit]                              … 未取り込みの入力を取り込み、今の範囲で暗号化し直す
//  node tools/dekidaka-admin.mjs check   <入力用合言葉> <閲覧用合言葉>                         … 復号の確認（件数だけ表示）
//  <token> などはファイルのパス
import fs from 'fs';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { generateRoleKey, importPriv } from '../dk-crypto.js';
import { GitHubBackend, DekidakaStore } from '../dk-store.js';
import { applyOps, readableDatasets } from '../dk-core.js';
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
} else if (cmd === 'check') {
  const [inF, viewF] = a;
  for (const [role, f] of [['view', viewF], ['input', inF]]) {
    const u = await unlock(cfg, role, f); const st = storeFor(cfg, role, u); const { doc } = await st.load();
    console.log(role, '読めた区分:', doc.readable.join(','), '想定:', readableDatasets(role, cfg.dekidaka.inputScope).join(','), '請書', doc.keisho.length, '記録', Object.keys(doc.records).length);
  }
} else { console.log('usage: see header'); process.exit(1); }
