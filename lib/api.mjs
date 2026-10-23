// Thin client for the zftal-xgxt-web JSON API.
import { Jar, DEFAULT_HEADERS, fetchRetry } from './cas.mjs';

export const BASE = 'https://zhxg.kmyz.edu.cn/zftal-xgxt-web';

export class Api {
  constructor(jar = new Jar()) { this.jar = jar; }

  headers(extra = {}) {
    const h = {
      ...DEFAULT_HEADERS,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://zhxg.kmyz.edu.cn/',
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    };
    const c = this.jar.header();
    if (c) h.Cookie = c;
    return h;
  }

  async request(method, path, { query, body, form: asForm = true } = {}) {
    let url = path.startsWith('http') ? path : BASE + path;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(query).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    const init = { method, headers: this.headers(), redirect: 'manual' };
    if (body !== undefined) {
      if (asForm) {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        init.body = typeof body === 'string' ? body : new URLSearchParams(body).toString();
      } else {
        init.headers['Content-Type'] = 'application/json;charset=UTF-8';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetchRetry(url, init, { timeoutMs: 25000 });
    this.jar.store(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, res };
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body) { return this.request('POST', path, { body }); }

  /**
   * The SPA calls this on boot. It yields the signed-in identity (学号 zgh + 姓名 xm)
   * and answers {"code":-3,"msg":"未登录，无法访问该地址"} once the session is gone,
   * so it doubles as a cheap liveness probe for a stored session.
   */
  async profile() {
    if (this._profile !== undefined) return this._profile;
    const r = await this.get('/teacher/xtgl/index/getUserRoleInfo.zf');
    this._profile = r.json?.code === 0 ? r.json.data : null;
    return this._profile;
  }

  /**
   * 'ok'      — the stored cookies are still accepted
   * 'expired' — the server definitively rejected them
   * 'unknown' — the request never completed (network problem); the cookies may
   *             still be perfectly good, so the caller must NOT discard them
   */
  async sessionStatus() {
    try {
      const r = await this.get('/teacher/xtgl/index/getUserRoleInfo.zf');
      if (r.json?.code === 0) { this._profile = r.json.data; return 'ok'; }
      return 'expired';
    } catch (e) {
      this.lastError = e;
      return 'unknown';
    }
  }

  async isAuthenticated() {
    return (await this.sessionStatus()) === 'ok';
  }
}
