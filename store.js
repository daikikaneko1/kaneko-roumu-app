// GitHub の非公開リポジトリにある JSON を contents API で読み書きする
import { b64e, b64d } from './crypto.js';
export class ConflictError extends Error { constructor() { super('conflict'); this.conflict = true; } }
export class GitHubStore {
  constructor({ owner, repo, path, branch = 'main', token, fetchImpl }) {
    Object.assign(this, { owner, repo, path, branch, token }); this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }
  url() { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path.split('/').map(encodeURIComponent).join('/')}`; }
  headers() { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; }
  async load() {
    const r = await this.fetch(`${this.url()}?ref=${encodeURIComponent(this.branch)}&_=${Date.now()}`, { headers: this.headers(), cache: 'no-store' });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('auth'), { auth: true, status: r.status });
    if (!r.ok) throw new Error(`読み込み失敗 (${r.status})`);
    const j = await r.json();
    let text;
    if (j.content && j.encoding === 'base64') text = new TextDecoder().decode(b64d(j.content.replace(/\n/g, '')));
    else { // 1MB を超えると content が空になるので raw で取り直す
      const r2 = await this.fetch(`${this.url()}?ref=${encodeURIComponent(this.branch)}&_=${Date.now()}`, { headers: { ...this.headers(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
      if (!r2.ok) throw new Error(`読み込み失敗 (${r2.status})`);
      text = await r2.text();
    }
    return { doc: JSON.parse(text), sha: j.sha };
  }
  async save(doc, sha, message) {
    const body = { message, content: b64e(new TextEncoder().encode(JSON.stringify(doc, null, 1) + '\n')), sha, branch: this.branch };
    const r = await this.fetch(this.url(), { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) throw new ConflictError();
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('auth'), { auth: true, status: r.status });
    if (!r.ok) throw new Error(`保存失敗 (${r.status})`);
    const j = await r.json(); return j.content.sha;
  }
}
// 版（data/versions/YYYY-MM.json）：一覧・読み込み・「無いときだけ作る」。版は上書きしない（sha を付けずに作る→あれば 422 で何もしない）
export class GitHubVersions {
  constructor(cfg, dir = 'data/versions') { this.cfg = cfg; this.dir = dir; this.fetch = cfg.fetchImpl || globalThis.fetch.bind(globalThis); }
  store(path) { return new GitHubStore({ ...this.cfg, path }); }
  async list() {
    const st = this.store(this.dir);
    const r = await this.fetch(`${st.url()}?ref=${encodeURIComponent(st.branch)}&_=${Date.now()}`, { headers: st.headers(), cache: 'no-store' });
    if (r.status === 404) return [];
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('auth'), { auth: true, status: r.status });
    if (!r.ok) throw new Error(`版の一覧を読めません (${r.status})`);
    const j = await r.json(); return Array.isArray(j) ? j : [];
  }
  async get(ym) { return (await this.store(`${this.dir}/${ym}.json`).load()).doc; }
  async createIfMissing(ym, version) {
    const st = this.store(`${this.dir}/${ym}.json`);
    const body = { message: `版を保存：${ym}（アプリを開いたとき・自動）`, content: b64e(new TextEncoder().encode(JSON.stringify(version, null, 1) + '\n')), branch: st.branch };
    const r = await this.fetch(st.url(), { method: 'PUT', headers: { ...st.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 422 || r.status === 409) return false; // もうある（ほかの端末や自動保存が先に作った）
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('auth'), { auth: true, status: r.status });
    if (!r.ok) throw new Error(`版を保存できません (${r.status})`);
    return true;
  }
}
// 体験用の版（ブラウザ内だけ）
export class MemoryVersions {
  constructor(map = {}) { this.map = structuredClone(map); }
  async list() { return Object.keys(this.map).map(k => ({ type: 'file', name: k + '.json' })); }
  async get(ym) { if (!this.map[ym]) throw new Error('版がありません'); return structuredClone(this.map[ym]); }
  async createIfMissing(ym, version) { if (this.map[ym]) return false; this.map[ym] = structuredClone(version); return true; }
}
// テスト・体験用（ブラウザ内だけで完結）
export class MemoryStore {
  constructor(doc) { this.doc = doc; this.sha = 'm1'; this.n = 1; }
  async load() { return { doc: structuredClone(this.doc), sha: this.sha }; }
  async save(doc, sha) { if (sha !== this.sha) throw new ConflictError(); this.doc = structuredClone(doc); this.sha = 'm' + (++this.n); return this.sha; }
}
// 未保存の op をためて保存。競合したら最新を取り直して op を再適用（＝マージ）して再保存
export class Sync {
  constructor(store, applyOps, { onChange, persist } = {}) { Object.assign(this, { store, applyOps, onChange: onChange || (() => {}), persist: persist || (() => {}) }); this.pending = []; this.base = null; this.sha = null; this.saving = null; this.status = 'idle'; }
  get doc() { return this.applyOps(this.base, this.pending); }
  async load() { const { doc, sha } = await this.store.load(); this.base = doc; this.sha = sha; this.onChange(); return this.doc; }
  push(op) { this.pending.push({ ...op, at: new Date().toISOString() }); this.persist(this.pending); this.onChange(); }
  async save(who = '') {
    if (this.saving) return this.saving;
    if (!this.pending.length) return true;
    this.saving = (async () => {
      this.status = 'saving'; this.onChange();
      for (let attempt = 0; attempt < 5; attempt++) {
        const ops = this.pending.slice();
        const next = this.applyOps(this.base, ops);
        next.updatedAt = new Date().toISOString(); next.updatedBy = who;
        try {
          const sha = await this.store.save(next, this.sha, `更新 ${ops.length}件${who ? ' by ' + who : ''}`);
          this.base = next; this.sha = sha; this.pending = this.pending.slice(ops.length); this.persist(this.pending);
          this.status = 'saved'; this.onChange(); return true;
        } catch (e) {
          if (!e.conflict) { this.status = 'error'; this.error = e; this.onChange(); throw e; }
          const r = await this.store.load(); this.base = r.doc; this.sha = r.sha; // 他の人の保存を取り込んで再適用
          this.merged = (this.merged || 0) + 1;
        }
      }
      this.status = 'error'; this.onChange(); throw new Error('保存が混み合っています。もう一度お試しください');
    })().finally(() => { this.saving = null; });
    return this.saving;
  }
  async refresh() { if (this.pending.length || this.saving) return false; const r = await this.store.load(); if (r.sha !== this.sha) { this.base = r.doc; this.sha = r.sha; this.onChange(); return true; } return false; }
}
