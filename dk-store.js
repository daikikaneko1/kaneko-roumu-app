// 出来高データの読み書き（非公開リポジトリ kaneko-roumu-data の data/dekidaka/ 以下。中身はすべて暗号文）
//  state.json        … 取り込み済みの全データ。区分ごとの封筒（閲覧用だけが書き換える。sha で衝突検出）
//  entries/<id>.json … 入力用・閲覧用の「入力1回分」。新しいファイルを足すだけ（上書きしない）
import { b64e, b64d } from './crypto.js';
import { ConflictError } from './store.js';
import { seal, open } from './dk-crypto.js';
import { SCHEMA, splitState, joinState, recipientRoles, FIELDS } from './dk-core.js';

const newId = at => at.replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + b64e(globalThis.crypto.getRandomValues(new Uint8Array(6))).replace(/[+/=]/g, c => ({ '+': 'x', '/': 'y', '=': '' }[c]));
const utf8 = { enc: s => b64e(new TextEncoder().encode(s)), dec: s => new TextDecoder().decode(b64d(s.replace(/\n/g, ''))) };
export class GitHubBackend {
  constructor({ owner, repo, branch = 'main', token, fetchImpl }) { Object.assign(this, { owner, repo, branch, token }); this.fetch = fetchImpl || globalThis.fetch.bind(globalThis); }
  api(p) { return `https://api.github.com/repos/${this.owner}/${this.repo}/${p}`; }
  h(extra = {}) { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra }; }
  async chk(r, what) { if (r.status === 401 || r.status === 403) throw Object.assign(new Error('auth'), { auth: true, status: r.status }); if (!r.ok) throw new Error(`${what}失敗 (${r.status})`); return r; }
  async getFile(path) {
    const u = this.api('contents/' + path.split('/').map(encodeURIComponent).join('/')) + `?ref=${encodeURIComponent(this.branch)}&_=${Date.now()}`;
    const r = await this.fetch(u, { headers: this.h(), cache: 'no-store' });
    if (r.status === 404) return null;
    const j = await (await this.chk(r, '読み込み')).json();
    if (j.content && j.encoding === 'base64') return { text: utf8.dec(j.content), sha: j.sha };
    const r2 = await this.chk(await this.fetch(u, { headers: this.h({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' }), '読み込み');
    return { text: await r2.text(), sha: j.sha };
  }
  async putFile(path, text, sha, message) {
    const r = await this.fetch(this.api('contents/' + path.split('/').map(encodeURIComponent).join('/')), { method: 'PUT', headers: this.h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ message, content: utf8.enc(text), ...(sha ? { sha } : {}), branch: this.branch }) });
    if (r.status === 409 || r.status === 422) throw new ConflictError();
    await this.chk(r, '保存'); return (await r.json()).content.sha;
  }
  async listDir(prefix) { // git tree（1000件の上限がない）
    const r = await this.fetch(this.api(`git/trees/${encodeURIComponent(this.branch)}?recursive=1&_=${Date.now()}`), { headers: this.h(), cache: 'no-store' });
    const j = await (await this.chk(r, '一覧')).json();
    return (j.tree || []).filter(t => t.type === 'blob' && t.path.startsWith(prefix)).map(t => ({ path: t.path, sha: t.sha }));
  }
  async getBlob(sha) { const r = await this.fetch(this.api(`git/blobs/${sha}`), { headers: this.h(), cache: 'no-store' }); const j = await (await this.chk(r, '読み込み')).json(); return utf8.dec(j.content); }
}
// 体験・テスト用（ブラウザ内だけ）
export class MemoryBackend {
  constructor() { this.files = new Map(); this.n = 0; }
  async getFile(path) { const f = this.files.get(path); return f ? { ...f } : null; }
  async putFile(path, text, sha) { const f = this.files.get(path); if ((f && f.sha !== sha) || (!f && sha)) throw new ConflictError(); const s = 'mem' + (++this.n); this.files.set(path, { text, sha: s }); return s; }
  async listDir(prefix) { return [...this.files].filter(([p]) => p.startsWith(prefix)).map(([path, f]) => ({ path, sha: f.sha })); }
  async getBlob(sha) { for (const f of this.files.values()) if (f.sha === sha) return f.text; throw new Error('no blob'); }
}

// role: 'view' | 'input'、priv: その役割の秘密鍵（CryptoKey）、pubs: { view, input } 公開鍵、scope: 入力用が読める範囲
export class DekidakaStore {
  constructor({ backend, dir = 'data/dekidaka', role, priv, pubs, scope = 0 }) { Object.assign(this, { backend, dir, role, priv, pubs, scope: Number(scope) }); }
  get statePath() { return `${this.dir}/state.json`; }
  recips(ds) { return Object.fromEntries(recipientRoles(ds, this.scope).map(r => [r, this.pubs[r]])); }
  async encryptState(doc) {
    const parts = splitState(doc), sections = {};
    for (const [ds, obj] of Object.entries(parts)) sections[ds] = await seal(obj, this.recips(ds), `state/${ds}`);
    return { v: 1, kind: 'dekidaka-state', schema: SCHEMA, scope: this.scope, merged: doc.merged || [], updatedAt: doc.updatedAt || null, updatedBy: doc.updatedBy || '', sections };
  }
  async decryptState(file) {
    const parts = {};
    for (const [ds, env] of Object.entries(file.sections || {})) { const o = await open(env, this.role, this.priv, `state/${ds}`); if (o) parts[ds] = o; }
    if (!parts.names) throw Object.assign(new Error('この合言葉では出来高データを開けません'), { nokey: true });
    return joinState(file, parts);
  }
  // Sync（store.js）から使う load / save
  async load() {
    const f = await this.backend.getFile(this.statePath);
    if (!f) throw Object.assign(new Error('出来高データがまだありません'), { missing: true });
    return { doc: await this.decryptState(JSON.parse(f.text)), sha: f.sha };
  }
  async save(doc, sha, message) {
    if (this.role !== 'view') throw new Error('入力用は全体データを保存できません');
    const { readable, ...clean } = doc;
    return this.backend.putFile(this.statePath, JSON.stringify(await this.encryptState(clean), null, 1) + '\n', sha, message || '出来高 更新');
  }
  // ---- 入力1回分 ----
  async listEntries() { return (await this.backend.listDir(`${this.dir}/entries/`)).filter(e => e.path.endsWith('.json')).map(e => ({ ...e, id: e.path.split('/').pop().slice(0, -5) })); }
  async readEntry(e) {
    const file = JSON.parse(await this.backend.getBlob(e.sha)); let out = null;
    for (const [ds, env] of Object.entries(file.sections || {})) {
      const o = await open(env, this.role, this.priv, `entry/${file.id}/${ds}`); if (!o) continue;
      if (o.type === 'keishoReq') return { id: file.id, type: 'keishoReq', at: o.at, by: o.by, req: o.req };
      out = out || { id: file.id, key: o.key, at: o.at, by: o.by, fields: {} }; Object.assign(out.fields, o.fields);
    }
    return out; // 読める区分がなければ null
  }
  // fields: { amount?, ninku?, note? }（入れた項目だけ）
  async addEntry({ key, fields, by = '', at = new Date().toISOString() }) {
    const id = newId(at);
    const byDs = {};
    for (const [f, v] of Object.entries(fields)) { const ds = FIELDS[f]; if (!ds) continue; (byDs[ds] = byDs[ds] || {})[f] = v; }
    const sections = {};
    for (const [ds, fs] of Object.entries(byDs)) sections[ds] = await seal({ key, at, by, fields: fs }, this.recips(ds), `entry/${id}/${ds}`);
    const file = { v: 1, kind: 'dekidaka-entry', id, sections };
    await this.backend.putFile(`${this.dir}/entries/${id}.json`, JSON.stringify(file) + '\n', null, '出来高 入力');
    return { id, key, at, by, fields };
  }
  // 請書追加の申請（入力用 → 閲覧用が承認・却下）。中身（請書名・金額など）は master と同じ受取人だけが読める
  async addRequest({ req, by = '', at = new Date().toISOString() }) {
    const id = newId(at), sections = { master: await seal({ type: 'keishoReq', at, by, req }, this.recips('master'), `entry/${id}/master`) };
    await this.backend.putFile(`${this.dir}/entries/${id}.json`, JSON.stringify({ v: 1, kind: 'dekidaka-entry', id, sections }) + '\n', null, '出来高 請書追加の申請');
    return { id, type: 'keishoReq', at, by, req };
  }
  // 取り込み済み（merged）でない入力を読む。entries＝数字の入力、requests＝請書追加の申請（承認・却下まで残る）
  async pendingEntries(merged = []) {
    const done = new Set(merged), out = [], reqs = []; let unreadable = 0;
    for (const e of await this.listEntries()) { if (done.has(e.id)) continue; const r = await this.readEntry(e); if (!r) unreadable++; else if (r.type === 'keishoReq') reqs.push(r); else out.push(r); }
    const byAt = (a, b) => (a.at < b.at ? -1 : 1);
    return { entries: out.sort(byAt), requests: reqs.sort(byAt), unreadable };
  }
}
