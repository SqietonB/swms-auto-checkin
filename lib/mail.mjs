// Minimal SMTP client + MIME builder — no dependencies, `node:net` / `node:tls` only.
//
// Supports the two shapes people actually use:
//   secure: true   implicit TLS           (QQ / 163 / Gmail on port 465)
//   secure: false  plain connect + STARTTLS (port 587, port 25)
//
// Auth is AUTH LOGIN with an AUTH PLAIN fallback. For QQ Mail and 163 the
// password is the per-account 授权码 (authorization code), not the login password.
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

/** Wrap a base64 string at 76 characters, as MIME requires. */
function wrap76(b64) {
  return b64.replace(/(.{76})/g, '$1' + CRLF);
}

/** RFC 2047 encoded-word, used for non-ASCII header values such as the subject. */
export function encodeHeader(value) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** Quote a display name if it needs it; otherwise return it as-is. */
function formatAddress(addr) {
  const s = String(addr).trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (!m) return s;
  const name = m[1].replace(/^"|"$/g, '');
  return name ? `${encodeHeader(name)} <${m[2]}>` : `<${m[2]}>`;
}

/**
 * Build a complete RFC 5322 message.
 * The body is base64 encoded: that keeps CJK text intact and guarantees no line
 * exceeds the SMTP limit or starts with a dot.
 */
export function buildMessage({ from, to, subject, body, date = new Date(), messageId }) {
  const recipients = Array.isArray(to) ? to : [to];
  const domain = String(from).replace(/^.*@/, '') || 'localhost';
  const id = messageId || `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`;

  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${recipients.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];

  const encoded = wrap76(Buffer.from(String(body), 'utf8').toString('base64'));
  return headers.join(CRLF) + CRLF + CRLF + encoded;
}

/** SMTP requires lines beginning with '.' to be doubled. */
export function dotStuff(message) {
  return String(message).replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

// ---------------------------------------------------------------- SMTP client

class Smtp {
  constructor(socket, { timeoutMs = 20000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
    this.queued = [];
    this.waiters = [];
    this.closed = false;

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => this._fail(new Error('SMTP 超时')));
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('SMTP 连接被关闭')));
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf(CRLF)) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.lines.push(line);
      // A reply ends on a line whose 4th character is a space ("250 ok"),
      // continuations look like "250-first line".
      if (/^\d{3}([ ]|$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
        this.lines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(reply);
        else this.queued.push(reply);
      }
    }
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  read() {
    if (this.queued.length) return Promise.resolve(this.queued.shift());
    if (this.closed) return Promise.reject(new Error('SMTP 连接已关闭'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (this.closed) {
        this.waiters.pop();
        reject(new Error('SMTP 连接已关闭'));
      }
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Send a command and return its reply. */
  async cmd(line) {
    await this.write(line + CRLF);
    return this.read();
  }

  /** Send a command and throw unless the reply code is in `expect`. */
  async expect(line, ...codes) {
    const reply = await this.cmd(line);
    if (!codes.includes(reply.code)) {
      throw new Error(`${line.split(' ')[0]} -> ${reply.code} ${reply.text}`);
    }
    return reply;
  }

  /** Hand the socket over to TLS (STARTTLS), returning a client on the new socket. */
  async upgrade(host) {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('timeout');
    this.closed = true;
    this.waiters.splice(0);

    const secure = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: this.socket, servername: host }, () => resolve(s));
      s.once('error', reject);
    });
    return new Smtp(secure, { timeoutMs: this.timeoutMs });
  }

  close() {
    this.closed = true;
    try { this.socket.destroy(); } catch { /* already gone */ }
  }

  end() {
    try { this.socket.end(); } catch { /* already gone */ }
  }
}

function open({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(new Error(`无法连接 ${host}:${port} — ${e.message}`));
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    });
  }).then((socket) => {
    socket.removeAllListeners('error');
    socket.setTimeout(0);
    return new Smtp(socket, { timeoutMs });
  });
}

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

/**
 * Send one message.
 * @returns {Promise<{ok:true, accepted:string[]}>}
 */
export async function sendMail({
  host, port = 465, secure = true, user, pass, from, to,
  subject, body, timeoutMs = 25000, allowInsecure = false,
}) {
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s).trim()).filter(Boolean);
  if (!host) throw new Error('缺少 smtp host');
  if (!recipients.length) throw new Error('缺少收件人');
  const sender = String(from || user || '').trim();
  if (!sender) throw new Error('缺少发件人');

  let smtp = await open({ host, port, secure, timeoutMs });
  try {
    smtp.queued = [];
    const greeting = await smtp.read();
    if (greeting.code !== 220) throw new Error(`服务器问候异常: ${greeting.text}`);

    let ehlo = await smtp.cmd(`EHLO ${host}`);
    if (ehlo.code !== 250) ehlo = await smtp.cmd(`HELO ${host}`);
    if (ehlo.code !== 250) throw new Error(`EHLO 失败: ${ehlo.text}`);

    if (!secure) {
      if (/STARTTLS/i.test(ehlo.text)) {
        await smtp.expect('STARTTLS', 220);
        smtp = await smtp.upgrade(host);
        const again = await smtp.cmd(`EHLO ${host}`);
        if (again.code !== 250) throw new Error(`STARTTLS 后 EHLO 失败: ${again.text}`);
        ehlo = again;
      } else if (!allowInsecure) {
        throw new Error('服务器不支持 STARTTLS，拒绝明文发送。确实需要明文请设置 allowInsecure: true');
      }
    }

    if (user) {
      // AUTH LOGIN is a three-step exchange: the server prompts for the
      // username and password with its own 334 replies.
      const start = await smtp.cmd('AUTH LOGIN');
      if (start.code === 235) {
        // Some servers accept AUTH LOGIN with no credentials at all (rare).
      } else if (start.code === 334) {
        const userReply = await smtp.cmd(b64(user));
        if (userReply.code !== 334) throw new Error(`认证失败 (${userReply.code})：${userReply.text.split('\n').pop()}`);
        const passReply = await smtp.cmd(b64(pass));
        if (passReply.code !== 235) {
          throw new Error(
            `认证失败 (${passReply.code})：请确认用的是邮箱「授权码」而不是登录密码 — ${passReply.text.split('\n').pop()}`,
          );
        }
      } else if (start.code === 500 || start.code === 504) {
        // Server does not implement AUTH LOGIN — fall back to AUTH PLAIN.
        await smtp.expect(`AUTH PLAIN ${b64(`\0${user}\0${pass ?? ''}`)}`, 235);
      } else {
        throw new Error(`认证失败 (${start.code})：${start.text.split('\n').pop()}`);
      }
    }

    await smtp.expect(`MAIL FROM:<${sender.replace(/^.*<|>.*$/g, '')}>`, 250);
    for (const rcpt of recipients) {
      await smtp.expect(`RCPT TO:<${rcpt.replace(/^.*<|>.*$/g, '')}>`, 250, 251);
    }
    await smtp.expect('DATA', 354);

    const message = dotStuff(buildMessage({ from: sender, to: recipients, subject, body }));
    await smtp.write(message + CRLF + '.' + CRLF);
    const done = await smtp.read();
    if (done.code !== 250) throw new Error(`发送被拒绝: ${done.text}`);

    await smtp.cmd('QUIT').catch(() => {});
    smtp.end();
    return { ok: true, accepted: recipients };
  } catch (e) {
    smtp.close();
    throw e;
  }
}
