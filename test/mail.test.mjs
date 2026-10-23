// Mail notification tests — fully offline.
//
// The integration test starts a throwaway SMTP server on localhost and drives
// the real client through it, so command sequencing, AUTH LOGIN, dot-stuffing
// and message framing are all exercised for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { buildMessage, dotStuff, encodeHeader, sendMail } from '../lib/mail.mjs';
import { mailConfig, formatReport, notify } from '../lib/notify.mjs';

test('encodeHeader passes ASCII through and encodes UTF-8', () => {
  assert.equal(encodeHeader('Check-in OK'), 'Check-in OK');
  assert.equal(encodeHeader('签到成功'), '=?UTF-8?B?562+5Yiw5oiQ5Yqf?=');

  const decoded = Buffer.from(encodeHeader('签到失败').replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8');
  assert.equal(decoded, '签到失败');
});

test('buildMessage produces a well-formed MIME message', () => {
  const msg = buildMessage({
    from: 'bot@example.com',
    to: ['a@example.com', 'b@example.com'],
    subject: '签到成功',
    body: '第一行\n第二行',
    date: new Date('2026-10-22T07:00:00Z'),
    messageId: '<fixed@example.com>',
  });

  assert.match(msg, /^From: bot@example\.com\r\n/);
  assert.match(msg, /\r\nTo: a@example\.com, b@example\.com\r\n/);
  assert.match(msg, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(msg, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(msg, /\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.ok(msg.includes('\r\n\r\n'), 'headers must be separated from the body');

  const [headers, body] = msg.split('\r\n\r\n');
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), '第一行\n第二行');
  assert.ok(!headers.includes('\n\n'), 'headers must use CRLF only');
  for (const line of msg.split('\r\n')) assert.ok(line.length <= 998, 'SMTP line limit');
});

test('dotStuff escapes leading dots', () => {
  assert.equal(dotStuff('.hidden\r\nnormal\r\n.again'), '..hidden\r\nnormal\r\n..again');
  assert.equal(dotStuff('no dots here'), 'no dots here');
});

test('mailConfig auto-enables on host+to and respects the switches', () => {
  const base = { mail: { host: 'smtp.qq.com', to: 'me@qq.com', user: 'me@qq.com', pass: 'code' } };

  const on = mailConfig({ cfg: base });
  assert.equal(on.host, 'smtp.qq.com');
  assert.equal(on.port, 465);
  assert.equal(on.secure, true);
  assert.deepEqual(on.to, ['me@qq.com']);
  assert.equal(on.from, 'me@qq.com', 'from defaults to user');

  assert.equal(mailConfig({ cfg: base, noMail: true }), null, '--no-mail disables it');
  assert.equal(mailConfig({ cfg: { mail: { ...base.mail, enabled: false } } }), null);
  assert.equal(mailConfig({ cfg: { mail: { host: 'smtp.qq.com' } } }), null, 'no recipient -> off');
  assert.equal(mailConfig({ cfg: {} }), null, 'no config -> off');
});

test('mailConfig picks sensible TLS defaults and accepts alternatives', () => {
  const opts = (mail) => mailConfig({ cfg: { mail: { user: 'u@x.y', ...mail } } });

  assert.equal(opts({ host: 'h', to: 'a@b.c', port: 587 }).secure, false, '587 means STARTTLS');
  assert.equal(opts({ host: 'h', to: 'a@b.c', port: 25 }).secure, false);
  assert.equal(opts({ host: 'h', to: 'a@b.c', port: 465 }).secure, true);
  assert.equal(opts({ host: 'h', to: 'a@b.c', secure: false }).secure, false);
  assert.equal(opts({ host: 'h', to: 'a@b.c', secure: false }).port, 587);
  assert.equal(opts({ host: 'h', to: 'a@b.c', allowInsecure: true }).allowInsecure, true);

  // The reference project's field names are accepted too.
  const ref = opts({ smtp_host: 'smtp.qq.com', smtp_port: 465, sender: 'me@qq.com', sender_key: 'k', receiver: 'you@qq.com' });
  assert.equal(ref.host, 'smtp.qq.com');
  assert.equal(ref.pass, 'k');
  assert.deepEqual(ref.to, ['you@qq.com']);

  const env = mailConfig({
    cfg: base(),
    env: { SWMS_MAIL_HOST: 'smtp.env', SWMS_MAIL_TO: 'x@y.z, p@q.r', SWMS_MAIL_PASS: 'envpass' },
  });
  assert.equal(env.host, 'smtp.env');
  assert.equal(env.pass, 'envpass');
  assert.deepEqual(env.to, ['x@y.z', 'p@q.r']);

  // The legacy ZHGX_* prefix still resolves, and SWMS_* wins when both are set.
  const legacy = mailConfig({ cfg: base(), env: { ZHGX_MAIL_HOST: 'smtp.old', ZHGX_MAIL_TO: 'old@x.y' } });
  assert.equal(legacy.host, 'smtp.old');
  assert.deepEqual(legacy.to, ['old@x.y']);

  const both = mailConfig({ cfg: base(), env: { SWMS_MAIL_HOST: 'new', ZHGX_MAIL_HOST: 'old' } });
  assert.equal(both.host, 'new');

  assert.deepEqual(mailConfig({ cfg: base(), mailTo: 'one@two.three' }).to, ['one@two.three']);
  assert.equal(mailConfig({ cfg: base() }).notifyWhenIdle, false, 'idle报告默认不发');
  assert.equal(opts({ host: 'h', to: 'a@b.c', notifyWhenIdle: true }).notifyWhenIdle, true);
  function base() { return { mail: { host: 'h', to: 'a@b.c', user: 'u', pass: 'p' } }; }
});

test('formatReport describes a successful run', () => {
  const r = formatReport({
    identity: { 学号: '学号', 姓名: '用户' },
    kind: 'run',
    due: 1,
    tasks: [],
    results: [{
      ok: true,
      task: { fxdkrw: '晨检打卡', dkkssj: '2026-10-23 06:30:00', dkjssj: '2026-10-23 09:00:00' },
      body: { id: 'x', rwid: 'y', dkjg: '1', wz: '', sffwn: '0', dkzp: '1', wd: '36', jszk: '1', yclx: '5' },
    }],
    at: new Date('2026-10-23T07:02:12'),
  });

  assert.equal(r.ok, true);
  assert.match(r.subject, /签到成功/);
  assert.match(r.subject, /学号 用户/);
  assert.match(r.subject, /晨检打卡/);

  assert.match(r.body, /✅ 签到成功/);
  assert.match(r.body, /晨检打卡/);
  assert.match(r.body, /是否在校：1（是，在学校）/);
  assert.match(r.body, /症状：5（以上都无）/);
  assert.match(r.body, /位置：\(空\)/);
  assert.ok(!r.body.includes('学院'), 'the college must not appear in the report');
  assert.ok(!r.body.includes('rwid'), 'internal ids must not be echoed');
});

test('formatReport describes failures, lockouts and crashes', () => {
  const failed = formatReport({
    identity: { 学号: '1', 姓名: 'A' },
    kind: 'run',
    results: [{ ok: false, task: { fxdkrw: '午检打卡' }, reason: '不在打卡时间内' }],
  });
  assert.equal(failed.ok, false);
  assert.match(failed.subject, /签到失败/);
  assert.match(failed.body, /原因：不在打卡时间内/);

  const partial = formatReport({
    kind: 'run',
    results: [
      { ok: true, task: { fxdkrw: '晨检打卡' }, body: {} },
      { ok: false, task: { fxdkrw: '午检打卡' }, reason: 'boom' },
    ],
  });
  assert.match(partial.subject, /部分签到失败/);

  const locked = formatReport({ kind: 'locked', error: '账号已锁定至 10:00' });
  assert.equal(locked.ok, false);
  assert.match(locked.subject, /账号锁定/);
  assert.match(locked.body, /账号已锁定至 10:00/);

  const crash = formatReport({ kind: 'error', error: '连接超时' });
  assert.match(crash.subject, /运行异常/);
  assert.match(crash.body, /连接超时/);

  const idle = formatReport({ kind: 'idle', tasks: [{ fxdkrw: '晚检打卡', zt: '进行中', dkztmc: '已签到', dkkssj: 'a', dkjssj: 'b' }] });
  assert.match(idle.subject, /无需签到/);
  assert.match(idle.body, /晚检打卡/);
  assert.ok(!/结果：成功/.test(idle.body), 'no pointless tallies when nothing happened');
});

test('notify never throws — mail trouble must not break the check-in', async () => {
  const log = [];
  const report = { subject: 's', body: 'b' };

  assert.deepEqual(await notify(null, report, (m) => log.push(m)), { sent: false, reason: '未配置邮箱' });

  // Port 1 is reserved and refuses connections immediately.
  const res = await notify(
    { host: '127.0.0.1', port: 1, secure: false, allowInsecure: true, from: 'a@b.c', to: ['d@e.f'] },
    report,
    (m) => log.push(m),
  );
  assert.equal(res.sent, false);
  assert.ok(res.reason, 'a reason is reported');
  assert.ok(log.some((m) => /邮件发送失败/.test(m)), 'the failure is logged, not thrown');
});

// ---------------------------------------------------------- SMTP integration

/** A minimal SMTP server that records one message and replies 250 to everything. */
function fakeSmtp() {
  return new Promise((resolve) => {
    const state = { commands: [], auth: {}, from: null, to: [], message: null };

    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let authStep = null; // null | 'user' | 'pass'

      const send = (line) => socket.write(line + '\r\n');
      send('220 fake.local ESMTP ready');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              send('250 2.0.0 Ok: queued');
            } else {
              state.message = (state.message ?? '') + line + '\r\n';
            }
            continue;
          }

          // Continuation lines of AUTH LOGIN are credentials, not commands.
          if (authStep === 'user') { state.auth.user = line; authStep = 'pass'; send('334 UGFzc3dvcmQ6'); continue; }
          if (authStep === 'pass') { state.auth.pass = line; authStep = null; send('235 2.7.0 Accepted'); continue; }

          state.commands.push(line);
          const verb = line.split(' ')[0].toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') send('250-fake.local\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760');
          else if (verb === 'AUTH') {
            if (/^AUTH LOGIN$/i.test(line)) { authStep = 'user'; send('334 VXNlcm5hbWU6'); }
            else send('504 5.5.4 Unrecognized authentication type');
          } else if (verb === 'MAIL') { state.from = line; send('250 2.1.0 Ok'); }
          else if (verb === 'RCPT') { state.to.push(line); send('250 2.1.5 Ok'); }
          else if (verb === 'DATA') { inData = true; send('354 End data with <CR><LF>.<CR><LF>'); }
          else if (verb === 'QUIT') { send('221 2.0.0 Bye'); socket.end(); }
          else send('250 2.0.0 Ok');
        }
      });
      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

test('sendMail drives a real SMTP conversation end to end', async () => {
  const { server, port, state } = await fakeSmtp();
  try {
    const body = '第一行\n.这一行以点开头\n最后一行';
    const res = await sendMail({
      host: '127.0.0.1',
      port,
      secure: false,
      allowInsecure: true,
      user: 'bot@example.com',
      pass: 'secret-code',
      from: 'bot@example.com',
      to: 'me@example.com',
      subject: '签到成功',
      body,
    });

    assert.deepEqual(res.accepted, ['me@example.com']);
    assert.ok(state.commands.some((c) => /^EHLO/.test(c)));
    assert.deepEqual(state.commands.filter((c) => /^(MAIL|RCPT|DATA|QUIT)/.test(c)), [
      'MAIL FROM:<bot@example.com>',
      'RCPT TO:<me@example.com>',
      'DATA',
      'QUIT',
    ]);
    assert.equal(Buffer.from(state.auth.user, 'base64').toString('utf8'), 'bot@example.com');
    assert.equal(Buffer.from(state.auth.pass, 'base64').toString('utf8'), 'secret-code');
    assert.match(state.from, /^MAIL FROM:<bot@example\.com>$/);
    assert.deepEqual(state.to, ['RCPT TO:<me@example.com>']);

    // The body is base64, so it must survive dot-stuffing untouched.
    const [, encoded] = state.message.split('\r\n\r\n');
    assert.equal(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8'), body);
    assert.ok(state.message.includes('Subject: =?UTF-8?B?'), 'subject must be RFC 2047 encoded');
  } finally {
    server.close();
  }
});

test('sendMail refuses plaintext when the server offers no STARTTLS', async () => {
  const { server, port } = await fakeSmtp();
  try {
    await assert.rejects(
      sendMail({ host: '127.0.0.1', port, secure: false, from: 'a@b.c', to: 'd@e.f', subject: 's', body: 'b' }),
      /STARTTLS/,
    );
  } finally {
    server.close();
  }
});

test('sendMail surfaces a rejected login', async () => {
  const server = net.createServer((socket) => {
    socket.write('220 x\r\n');
    socket.on('data', (chunk) => {
      const line = chunk.toString();
      if (/^EHLO/i.test(line)) socket.write('250-x\r\n250 AUTH LOGIN\r\n');
      else if (/^AUTH LOGIN$/i.test(line)) socket.write('334 VXNlcm5hbWU6\r\n');
      else socket.write('535 5.7.8 Authentication failed\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      sendMail({
        host: '127.0.0.1', port: server.address().port, secure: false, allowInsecure: true,
        user: 'a@b.c', pass: 'wrong', from: 'a@b.c', to: 'd@e.f', subject: 's', body: 'b',
      }),
      /认证失败/,
    );
  } finally {
    server.close();
  }
});
