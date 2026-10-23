// CAS login (lyuapServer / Apereo-CAS style REST flow).
import { Jar, rsaEncrypt, form, DEFAULT_HEADERS, follow, fetchRetry } from './cas.mjs';
import { recognize } from './ocr.mjs';

export const CAS = 'https://cas.kmyz.edu.cn';
export const CAS_BASE = '/lyuapServer';
/** The app we want a ticket for. http:// (not https) is what the portal itself uses. */
export const DEFAULT_SERVICE = 'http://zhxg.kmyz.edu.cn/zftal-xgxt-web/teacher/xtgl/index/check.zf';

// Fallback key (public_exponent / modulus as shipped in the CAS front-end bundle).
// Exported so the test suite can lock in the encryption scheme against a real
// browser ciphertext.
export const FALLBACK_KEY = {
  public_exponent: '010001',
  modulus: '00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1',
};

function hdrs(jar, extra = {}) {
  const h = { ...DEFAULT_HEADERS, ...extra };
  const c = jar.header();
  if (c) h.Cookie = c;
  return h;
}

/**
 * The RSA public key is bootstrapped from the CAS login page's JS bundle so a
 * server-side key rotation does not silently break password encryption.
 * Kept on a short leash: the bundled key is known-good, so a slow CAS page must
 * not delay every login.
 */
export async function fetchPublicKey(jar, { service = DEFAULT_SERVICE, timeoutMs = 8000 } = {}) {
  try {
    const loginUrl = `${CAS}${CAS_BASE}/login?service=${encodeURIComponent(service)}`;
    const r = await fetchRetry(loginUrl, { headers: hdrs(jar) }, { timeoutMs, retries: 1 });
    jar.store(r);
    const html = await r.text();
    const scripts = [...html.matchAll(/src=["']?(\/assets\/js\/[^"'\s>]+\.js)/g)].map((m) => m[1]);
    for (const src of scripts) {
      const js = await (await fetchRetry(`${CAS}${src}`, { headers: hdrs(jar) }, { timeoutMs, retries: 1 })).text();
      const e = /public_exponent:\s*"([0-9a-fA-F]+)"/.exec(js);
      const m = /modulus:\s*"([0-9a-fA-F]+)"/.exec(js);
      if (e && m) return { public_exponent: e[1], modulus: m[1], source: src };
    }
  } catch {
    /* fall through to the bundled key */
  }
  return { ...FALLBACK_KEY, source: 'built-in fallback' };
}

export async function getCaptcha(jar, uid = '') {
  const r = await fetchRetry(`${CAS}${CAS_BASE}/kaptcha?uid=${encodeURIComponent(uid)}`, { headers: hdrs(jar) }, { timeoutMs: 15000 });
  jar.store(r);
  const j = await r.json();
  if (!j || !j.content) throw new Error('kaptcha returned no image: ' + JSON.stringify(j).slice(0, 200));
  const png = Buffer.from(String(j.content).split(',')[1], 'base64');
  return { uid: j.uid, png };
}

/**
 * Log in and return the authenticated cookie jar.
 * Retries with a fresh CAPTCHA when the answer is rejected or unreadable.
 */
export async function login({
  username,
  password,
  service = DEFAULT_SERVICE,
  templates,
  attempts = 6,
  log = () => {},
  jar = new Jar(),
} = {}) {
  if (!username || !password) throw new Error('username and password are required');
  const key = await fetchPublicKey(jar, { service });
  log(`RSA key from ${key.source}`);

  const encrypted = rsaEncrypt(password, key.modulus, key.public_exponent);
  let lastReason = 'no attempt made';

  for (let i = 1; i <= attempts; i++) {
    const { uid, png } = await getCaptcha(jar);
    const rec = recognize(png, templates);
    if (!rec.confident) {
      lastReason = `captcha unreadable (read "${rec.text}", ${rec.count} glyphs)`;
      log(`attempt ${i}: ${lastReason}, retrying`);
      continue;
    }
    log(`attempt ${i}: captcha "${rec.text}"`);

    const res = await fetchRetry(`${CAS}${CAS_BASE}/v1/tickets`, {
      method: 'POST',
      headers: hdrs(jar, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: form({
        username: username.replace(/\s+/g, ''),
        password: encrypted,
        service,
        loginType: '',
        id: uid,
        code: rec.text,
        otpcode: '',
      }),
      redirect: 'manual',
    }, { timeoutMs: 20000 });
    jar.store(res);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    const code = body?.data?.code;

    if (code === 'CODEFALSE') {
      lastReason = 'captcha rejected';
      log(`attempt ${i}: captcha rejected, retrying`);
      continue;
    }
    if (code === 'USERLOCK') {
      // Repeated wrong passwords lock the account for ~10 minutes. Retrying
      // cannot help and risks extending the lock, so stop immediately.
      return { ok: false, reason: `account is locked until ${body.data.data}`, locked: true, body, jar };
    }
    if (code) {
      lastReason = `server said ${code}${body.data.data ? ' (' + body.data.data + ')' : ''}`;
      log(`attempt ${i}: ${lastReason}`);
      // "5,3" style payloads are the consecutive-failure counter.
      if (String(body.data.data || '').split(',')[1] === '5') {
        return { ok: false, reason: lastReason, locked: true, body, jar };
      }
      continue;
    }
    if (body && body.meta && body.meta.success === false) {
      lastReason = `server said: ${body.meta.message}`;
      log(`attempt ${i}: ${lastReason}`);
      return { ok: false, reason: lastReason, body, jar };
    }

    // This CAS answers the REST ticket call with {"tgt":..., "ticket":...} in the
    // body rather than a 201 + Location header, so accept either shape.
    let ticket = typeof body?.ticket === 'string' ? body.ticket : null;
    const tgtUrl = typeof body?.tgt === 'string' ? body.tgt : res.headers.get('location');

    if (!ticket && tgtUrl) {
      const tgt = new URL(tgtUrl, CAS).toString();
      const r2 = await fetchRetry(tgt, {
        method: 'POST',
        headers: hdrs(jar, { 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: form({ service }),
        redirect: 'manual',
      }, { timeoutMs: 20000 });
      jar.store(r2);
      const raw = (await r2.text()).trim();
      try { ticket = JSON.parse(raw).ticket || raw; } catch { ticket = raw; }
    }

    if (!ticket) {
      lastReason = `no service ticket in response: ${text.slice(0, 300)}`;
      log(`attempt ${i}: ${lastReason}`);
      continue;
    }

    const { res: r3, hops, finalUrl } = await follow(jar, `${service}?ticket=${encodeURIComponent(ticket)}`);
    if (r3.status !== 200) {
      lastReason = `ticket redemption failed: ${r3.status} at ${finalUrl}`;
      log(`attempt ${i}: ${lastReason}`);
      continue;
    }
    log(`登录成功（ticket 换取完成，${hops.length} 次跳转）`);
    return { ok: true, jar, service, ticket, finalUrl, hops, captcha: rec.text };
  }

  return { ok: false, reason: lastReason, jar };
}
