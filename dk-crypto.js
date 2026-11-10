// 出来高用の暗号（ブラウザ / Node 共通、WebCrypto のみ）
//  - 役割（view＝閲覧用・input＝入力用）ごとに ECDH P-256 の鍵ペア。公開鍵は config.js、秘密鍵は各合言葉で暗号化（crypto.js の PBKDF2 60万回＋AES-GCM）。
//  - データは「封筒」：ランダムな AES-256-GCM の鍵で本文を暗号化し、その鍵を受取人（役割）ごとに ECDH-ES＋HKDF で包む。
//    受取人に入っていない役割は、合言葉を知っていても読めない。
import { b64e, b64d } from './crypto.js';
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
const rnd = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const INFO = te.encode('kaneko-dekidaka/v1 wrap');

export async function generateRoleKey() {
  const kp = await subtle.generateKey(EC, true, ['deriveBits']);
  const pub = await subtle.exportKey('jwk', kp.publicKey);
  const priv = b64e(new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)));
  return { pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, priv };
}
export const importPub = jwk => subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, EC, true, []);
export const importPriv = b64 => subtle.importKey('pkcs8', b64d(b64), EC, false, ['deriveBits']);
// 公開鍵の指紋（鍵の取り違え・作り直しの検出用）
export async function kidOf(jwk) { const h = new Uint8Array(await subtle.digest('SHA-256', te.encode(jwk.x + '.' + jwk.y))); return b64e(h.subarray(0, 9)); }

async function wrapKeyFor(rawKey, pubJwk) {
  const eph = await subtle.generateKey(EC, true, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: await importPub(pubJwk) }, eph.privateKey, 256);
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const kek = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = rnd(12);
  const wk = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, kek, rawKey));
  return { epk: b64e(epk), iv: b64e(iv), wk: b64e(wk) };
}
async function unwrapKey(r, privKey) {
  const epk = b64d(r.epk);
  const pub = await subtle.importKey('raw', epk, EC, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const kek = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64d(r.iv) }, kek, b64d(r.wk)));
}
// recipients: { view: jwk, input: jwk, ... }  aad: 封筒の用途（別の場所に貼り替えられないように）
export async function seal(obj, recipients, aad = '') {
  const raw = rnd(32), iv = rnd(12);
  const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj))));
  const rcpt = {};
  for (const [role, jwk] of Object.entries(recipients)) rcpt[role] = { kid: await kidOf(jwk), ...(await wrapKeyFor(raw, jwk)) };
  raw.fill(0);
  return { v: 1, alg: 'ECDH-ES-P256+HKDF+A256GCM', aad, iv: b64e(iv), ct: b64e(ct), rcpt };
}
// 自分の役割で開けられなければ null（受取人でない・鍵が違う・改ざん）
export async function open(env, role, privKey, aad) {
  try {
    if (!env || !env.rcpt || !env.rcpt[role]) return null;
    if (aad !== undefined && env.aad !== aad) return null;
    const raw = await unwrapKey(env.rcpt[role], privKey);
    const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    return JSON.parse(td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv), additionalData: te.encode(env.aad || '') }, key, b64d(env.ct))));
  } catch { return null; }
}
