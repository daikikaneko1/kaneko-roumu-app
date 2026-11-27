// パトロールの「気づき」（金子さん専用）：本文・カテゴリ・現場・日付・写真1枚（任意）。
// 一覧は data/patrol/notes.json（暗号化）、写真は1枚ずつ data/patrol/photos/YYYY-MM/<id>.json（暗号化）。
// 暗号はほかと同じ：パトロールの合言葉 → PBKDF2-SHA256 → AES-256-GCM。settings.json・events.json・roumu.json には触らない
export const CATS = ['打ち継ぎ・隙間', '安全', '品質', 'その他'];
export const CAT_CLASS = { '打ち継ぎ・隙間': 'c1', '安全': 'c2', '品質': 'c3', 'その他': 'c4' };
export const NOTES_KIND = 'notes', PHOTO_KIND = 'photo';
export const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const photoPath = (dir, id, now = new Date()) => `${dir}/photos/${new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 7)}/${id}-${Math.random().toString(36).slice(2, 8)}.json`;

// ---------- 並び・検索（副作用なし） ----------
const fold = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s　]+/g, ' ').trim();
export function sortNotes(notes) { return [...notes].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created || '').localeCompare(a.created || '')); }
// q：語句（空白で区切るとすべてを含むもの）。本文・現場名・カテゴリから探す。cat・site は完全一致（'' はすべて）
export function filterNotes(notes, { q = '', cat = '', site = '' } = {}, siteName = k => k) {
  const words = fold(q).split(' ').filter(Boolean);
  return sortNotes(notes.filter(n => (!cat || n.cat === cat) && (!site || n.site === site) &&
    words.every(w => fold([n.text, n.site ? siteName(n.site) : '', n.siteName || '', n.cat].join(' ')).includes(w))));
}
// 追加・直す・消す（同じ id は置きかえ）
export function upsertNote(list, note) { const i = list.findIndex(n => n.id === note.id); const out = [...list]; if (i >= 0) out[i] = note; else out.push(note); return out; }
export const removeNote = (list, id) => list.filter(n => n.id !== id);
export function validNote(n) { if (!String(n.text || '').trim()) return '本文を入れてください'; if (!CATS.includes(n.cat)) return 'カテゴリを選んでください'; if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date || '')) return '日付を入れてください'; return ''; }

// ---------- 写真の暗号（中身はバイトのまま。形はほかと同じ {v,kdf,iter,salt,iv,ct}） ----------
const subtle = globalThis.crypto.subtle;
const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass, salt, iter) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFKC').trim()), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptBytes(u8, pass, iter = 300000) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pass, salt, iter), u8));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}
export async function decryptBytes(blob, pass) {
  try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv) }, await deriveKey(pass, b64d(blob.salt), blob.iter), b64d(blob.ct))); }
  catch { return null; }
}

// ---------- GitHub（非公開リポジトリ）：写真ファイルの作成・読み込み・削除 ----------
export class PhotoStore {
  constructor({ owner, repo, branch = 'main', token, fetchImpl }) { Object.assign(this, { owner, repo, branch, token }); this.fetch = fetchImpl || globalThis.fetch.bind(globalThis); }
  url(path) { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`; }
  h(accept = 'application/vnd.github+json') { return { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }; }
  static err(r, what) { if (r.status === 401 || r.status === 403) return Object.assign(new Error('auth'), { auth: true, status: r.status }); return new Error(`${what} (${r.status})`); }
  async put(path, u8, pass, mime = 'image/jpeg') {
    const doc = { schema: 'kaneko-patrol/1', kind: PHOTO_KIND, mime, blob: await encryptBytes(u8, pass) };
    const content = b64e(new TextEncoder().encode(JSON.stringify(doc) + '\n'));
    const r = await this.fetch(this.url(path), { method: 'PUT', headers: { ...this.h(), 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'パトロール：気づきの写真（暗号化）', content, branch: this.branch }) });
    if (!r.ok) throw PhotoStore.err(r, '写真を保存できません'); return path;
  }
  async get(path, pass) { // 1MB を超えても読めるように raw で
    const r = await this.fetch(`${this.url(path)}?ref=${encodeURIComponent(this.branch)}`, { headers: this.h('application/vnd.github.raw+json'), cache: 'no-store' });
    if (!r.ok) throw PhotoStore.err(r, '写真を読めません');
    const doc = JSON.parse(await r.text()); const u8 = await decryptBytes(doc.blob, pass); if (!u8) throw new Error('写真を開けません（合言葉が違うか壊れています）');
    return new Blob([u8], { type: doc.mime || 'image/jpeg' });
  }
  async del(path) { // 無ければそれでよい
    const g = await this.fetch(`${this.url(path)}?ref=${encodeURIComponent(this.branch)}&_=${Date.now()}`, { headers: this.h('application/vnd.github.object+json'), cache: 'no-store' });
    if (g.status === 404) return false; if (!g.ok) throw PhotoStore.err(g, '写真を消せません');
    const { sha } = await g.json();
    const r = await this.fetch(this.url(path), { method: 'DELETE', headers: { ...this.h(), 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'パトロール：気づきの写真を削除', sha, branch: this.branch }) });
    if (r.status === 404) return false; if (!r.ok) throw PhotoStore.err(r, '写真を消せません'); return true;
  }
}

// ---------- 写真を小さくする（ブラウザだけ）：長い辺 1600px・JPEG、大きければさらに縮める ----------
async function decodeImage(file) {
  if (globalThis.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* 下へ */ } }
  const url = URL.createObjectURL(file);
  try { return await new Promise((ok, ng) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ng(new Error('この写真は読み込めません（JPEG か PNG でお試しください）')); i.src = url; }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
export async function shrinkImage(file, { maxEdge = 1600, maxBytes = 600 * 1024 } = {}) {
  const img = await decodeImage(file), W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
  for (const [edge, q] of [[maxEdge, 0.82], [maxEdge, 0.7], [1280, 0.7], [1024, 0.65], [800, 0.6]]) {
    const s = Math.min(1, edge / Math.max(W, H)), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', q));
    if (blob && (blob.size <= maxBytes || edge === 800)) return { blob, w, h, orig: file.size };
  }
  throw new Error('写真を縮められませんでした');
}

// ---------- お試し用の絵（架空。写真のかわりにその場で描く） ----------
export async function demoPicture(kind = 0) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
  g.fillStyle = '#9aa0a6'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#8a9096'; for (let i = 0; i < 400; i++) g.fillRect((i * 97) % 640, (i * 61) % 480, 3, 3);
  if (kind === 0) { g.fillStyle = '#b5bac0'; g.fillRect(0, 0, 640, 236); g.strokeStyle = '#3b3f44'; g.lineWidth = 6; g.beginPath(); g.moveTo(0, 240); g.lineTo(640, 236); g.stroke(); g.strokeStyle = '#e8790c'; g.lineWidth = 5; g.strokeRect(300, 210, 90, 60); }
  else { g.fillStyle = '#f2c94c'; g.fillRect(80, 360, 480, 24); g.fillStyle = '#222'; for (let x = 80; x < 560; x += 48) g.fillRect(x, 360, 24, 24); }
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(0, 440, 640, 40); g.fillStyle = '#333'; g.font = '22px sans-serif'; g.fillText('お試し用の絵（架空）', 16, 468);
  return await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.8));
}
