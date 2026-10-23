// Cookie jar + helpers for CAS login (zero dependencies).

export class Jar {
  constructor() { this.cookies = new Map(); }
  store(res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.raw?.()['set-cookie'] || []);
    for (const c of list) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i < 0) continue;
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  toJSON() { return Object.fromEntries(this.cookies); }
  load(obj) { for (const [k, v] of Object.entries(obj || {})) this.cookies.set(k, v); }
}

function powmod(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

/**
 * RSA encryption exactly as this CAS front-end does it — and it is NOT
 * PKCS#1: it is textbook RSA over the UTF-8 bytes of the password in REVERSE
 * order, hex-encoded.
 *
 *     ciphertext = ( reverse(utf8(password)) as a big-endian integer ) ^ e mod n
 *
 * Established by capturing a real browser submission and reproducing its
 * ciphertext byte-for-byte. Both quirks matter, and both were needed to log in:
 *   - Node's crypto.publicEncrypt (PKCS#1 v1.5) is rejected with PASSERROR.
 *   - Without the byte reversal the integer is wrong and also rejected.
 * Note this makes the ciphertext deterministic — there is no random padding.
 */
export function rsaEncrypt(plain, modulusHex, exponentHex = '010001') {
  const n = BigInt('0x' + modulusHex);
  const e = BigInt('0x' + exponentHex);
  const block = Buffer.from(plain, 'utf8').reverse();
  const m = BigInt('0x' + block.toString('hex'));
  if (m >= n) throw new Error('password too long for the RSA modulus');
  const byteLen = Math.ceil(n.toString(16).length / 2);
  return powmod(m, e, n).toString(16).padStart(byteLen * 2, '0');
}

export function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.append(k, v);
  return p.toString();
}

export const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with retries for transient failures.
 *
 * The campus hosts are frequently slow or briefly unreachable, and a single
 * connect timeout used to abort the whole run. Connection errors and 5xx are
 * retried with a short backoff; 4xx and normal responses are returned as-is.
 */
export async function fetchRetry(url, init = {}, { retries = 3, timeoutMs = 25000, backoffMs = 700 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status} from ${url}`);
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  const hint = lastErr?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ? '（连接超时，网络不通或被墙）' : '';
  throw new Error(`请求失败 ${url}${hint}: ${lastErr?.cause?.code || lastErr?.message || lastErr}`);
}

/**
 * Follow a URL chain with a cookie jar, returning the last response.
 * `redirect: 'manual'` step-by-step so we can observe each hop.
 */
export async function follow(jar, url, opts = {}, maxHops = 12) {
  const hops = [];
  let cur = url;
  let method = opts.method || 'GET';
  let body = opts.body;
  for (let i = 0; i < maxHops; i++) {
    const headers = { ...DEFAULT_HEADERS, ...(opts.headers || {}) };
    const ch = jar.header();
    if (ch) headers.Cookie = ch;
    const res = await fetchRetry(cur, { method, body, headers, redirect: 'manual', ...(opts.fetchOpts || {}) });
    jar.store(res);
    const loc = res.headers.get('location');
    hops.push({ url: cur, status: res.status, location: loc });
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      method = 'GET'; body = undefined;
      continue;
    }
    return { res, hops, finalUrl: cur };
  }
  throw new Error('too many redirects');
}
