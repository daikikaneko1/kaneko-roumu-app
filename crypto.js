// 合言葉でトークンを暗号化/復号（PBKDF2-SHA256 → AES-256-GCM）。ブラウザ / Node 共通。
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
export const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass, salt, iter) {
  const base = await subtle.importKey('raw', enc.encode(pass.normalize('NFKC').trim()), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(secret, pass, iter = 600000) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, iter);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}
// 合言葉が違うと AES-GCM の認証で失敗する → null
export async function decryptSecret(blob, pass) {
  try {
    const key = await deriveKey(pass, b64d(blob.salt), blob.iter);
    return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv) }, key, b64d(blob.ct)));
  } catch { return null; }
}
