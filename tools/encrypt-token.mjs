#!/usr/bin/env node
// 使い方: node tools/encrypt-token.mjs <トークンのファイル> <合言葉のファイル> [config.js]
//  トークン・合言葉は画面にもログにも出しません。config.js の encToken を書き換えます。
//  合言葉の変更：同じトークン（または新しいトークン）と新しい合言葉で実行し直し、config.js をコミット。
import fs from 'fs';
import { encryptSecret, decryptSecret } from '../crypto.js';
const [tokFile, passFile, cfg = new URL('../config.js', import.meta.url).pathname] = process.argv.slice(2);
if (!tokFile || !passFile) { console.error('usage: node tools/encrypt-token.mjs <token-file> <passphrase-file> [config.js]'); process.exit(1); }
const token = fs.readFileSync(tokFile, 'utf8').trim(), pass = fs.readFileSync(passFile, 'utf8').trim();
if (!/^(github_pat_|ghp_)/.test(token)) { console.error('トークンの形式が違うようです（github_pat_ で始まるはず）'); process.exit(1); }
if (pass.length < 12) { console.error('合言葉が短すぎます（12文字以上にしてください）'); process.exit(1); }
const blob = await encryptSecret(token, pass);
if ((await decryptSecret(blob, pass)) !== token) { console.error('検証失敗'); process.exit(1); }
let src = fs.readFileSync(cfg, 'utf8');
src = src.replace(/encToken:\s*(null|\{[^}]*\})\s*,?[^\n]*/, `encToken: ${JSON.stringify(blob)},`);
fs.writeFileSync(cfg, src);
console.log('config.js を更新しました（iter=' + blob.iter + '）。トークン・合言葉は出力していません。');
