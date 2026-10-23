#!/usr/bin/env node
// 学工系统 自动签到 (签到任务) — zero-dependency Node.js.
//
//   node checkin.mjs --list                 show today's tasks and their state
//   node checkin.mjs                        sign every due task
//   node checkin.mjs --dry-run              show what would be sent
//   node checkin.mjs --watch 30             loop, checking every 30 minutes
//   node checkin.mjs --fresh                ignore the saved session, log in again
//   node checkin.mjs --test-mail            send a test notification and exit
//
// Credentials, in order of precedence:
//   --user/--pass  >  SWMS_USERNAME/SWMS_PASSWORD  >  config.json
//   (the older ZHGX_USERNAME / ZHGX_PASSWORD prefix is still honoured)
//
// The authenticated session is cached in .session-<user>.json and reused while
// the server still accepts it, so routine runs skip the CAPTCHA entirely.
//
// Email notification is configured under "mail" in config.json and fires on
// success, failure, lockout and unexpected errors.
//
// Exit codes: 0 ok · 1 error · 2 nothing due · 3 account locked
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login } from './lib/auth.mjs';
import { Api } from './lib/api.mjs';
import { listTasks, isDue, signTask, recentAnswers } from './lib/checkin.mjs';
import { sessionFile, loadSession, saveSession, clearSession } from './lib/session.mjs';
import { mailConfig, formatReport, notify } from './lib/notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const a = {
    watch: 0, dryRun: false, list: false, json: false, location: '', inRange: false,
    fresh: false, noSession: false, noMail: false, testMail: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    switch (v) {
      case '--user': case '--username': case '-u': a.username = next(); break;
      case '--pass': case '--password': case '-p': a.password = next(); break;
      case '--location': case '-l': a.location = next(); break;
      case '--in-range': a.inRange = true; break;
      case '--out-range': a.inRange = false; break;
      case '--watch': a.watch = Number(next()) || 0; break;
      case '--dry-run': a.dryRun = true; break;
      case '--list': a.list = true; break;
      case '--json': a.json = true; break;
      case '--fresh': a.fresh = true; break;
      case '--no-session': a.noSession = true; break;
      case '--mail': case '--mail-to': case '--email': a.mailTo = next(); break;
      case '--no-mail': a.noMail = true; break;
      case '--test-mail': a.testMail = true; break;
      case '--help': case '-h': a.help = true; break;
      default:
        if (v.startsWith('-')) { console.error(`unknown option: ${v}`); process.exit(1); }
    }
  }
  return a;
}

function loadConfig() {
  for (const p of [path.join(HERE, 'config.json'), path.join(process.cwd(), 'config.json')]) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error(`bad config ${p}: ${e.message}`); }
    }
  }
  return {};
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = src.findIndex((l, i) => i > 0 && !l.startsWith('//'));
  console.log(src.slice(1, end === -1 ? 14 : end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const cfg = loadConfig();
/** Read an env var under the current prefix, falling back to the legacy one. */
const env = (name) => process.env[`SWMS_${name}`] ?? process.env[`ZHGX_${name}`];
const username = args.username || env('USERNAME') || cfg.username;
const password = args.password || env('PASSWORD') || cfg.password;
const location = args.location || cfg.location || '';
const inRange = args.inRange || cfg.inRange === true;

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = args.json ? () => {} : (m) => console.log(`[${stamp()}] ${m}`);

const mail = mailConfig({ cfg, mailTo: args.mailTo, noMail: args.noMail });

// --test-mail runs before the credential check so mail can be set up first.
if (args.testMail) {
  if (!mail) {
    console.error('未配置邮箱。请在 config.json 里填写 mail 段（host / to / user / pass）。');
    process.exit(1);
  }
  log(`发送测试邮件 → ${mail.to.join(', ')}（${mail.host}:${mail.port}, ${mail.secure ? '隐式 TLS' : 'STARTTLS'}）`);
  const at = new Date();
  const res = await notify(mail, {
    subject: `[测试] swms-auto-checkin 邮件通知配置正常`,
    body: [
      '这是一封测试邮件。',
      '',
      `时间：${at.toLocaleString('zh-CN', { hour12: false })}`,
      `SMTP：${mail.host}:${mail.port}（${mail.secure ? '隐式 TLS' : 'STARTTLS'}）`,
      `发件人：${mail.from}`,
      `收件人：${mail.to.join(', ')}`,
      '',
      '收到这封邮件说明邮件通知已经配置成功。',
      '',
      '— 由 swms-auto-checkin 自动发送',
    ].join('\n') + '\n',
  }, log);
  process.exit(res.sent ? 0 : 1);
}

if (!username || !password) {
  console.error('缺少账号或密码。用 --user/--pass、环境变量 SWMS_USERNAME/SWMS_PASSWORD，或 config.json。');
  process.exit(1);
}

let templates;
try {
  templates = JSON.parse(fs.readFileSync(path.join(HERE, 'templates.json'), 'utf8'));
} catch (e) {
  console.error(`无法读取 templates.json (${e.message})——它必须和 checkin.mjs 放在同一目录。`);
  process.exit(1);
}

if (mail) log(`邮件通知已启用 → ${mail.to.join(', ')}（${mail.host}:${mail.port}）`);

const SESSION = args.noSession ? null : sessionFile(HERE, username);
let cachedApi = null;
let identity = null;

/** Print who we are: 学号 + 姓名. */
async function announce(api) {
  if (identity) return identity;
  try {
    const p = await api.profile();
    if (!p) return null;
    identity = { 学号: p.zgh || username, 姓名: p.xm || '' };
    log(`当前用户：${identity.学号} ${identity.姓名}`);
  } catch (e) {
    log(`已登录 ${username}（读取姓名失败：${e.message}）`);
    identity = { 学号: username, 姓名: '' };
  }
  return identity;
}

/** True when the API answered with the "not logged in" code. */
function isAuthError(e) {
  return /未登录|无法访问该地址|code":-3/.test(String(e?.message || ''));
}

/**
 * Get an authenticated Api.
 * Reuses the in-memory session, then the on-disk session, and only falls back
 * to a full CAPTCHA login when the server no longer accepts the cookies.
 */
async function connect({ force = false } = {}) {
  if (!force && cachedApi && (await cachedApi.sessionStatus()) === 'ok') {
    await announce(cachedApi);
    return { api: cachedApi };
  }

  if (SESSION && !force) {
    const saved = loadSession(SESSION, { username });
    if (saved) {
      const api = new Api(saved.jar);
      const status = await api.sessionStatus();
      const mins = saved.savedAt ? Math.round((Date.now() - saved.savedAt) / 60000) : null;
      if (status === 'ok') {
        log(`复用已保存的会话${mins != null ? `（${mins} 分钟前登录）` : ''}，跳过登录和验证码`);
        cachedApi = api;
        await announce(api);
        return { api };
      }
      if (status === 'unknown') {
        // A timeout is not proof the cookies are bad — keep the file.
        log(`无法连接服务器校验会话（${api.lastError?.message || '网络错误'}），保留会话文件并尝试重新登录。`);
      } else {
        log(`已保存的会话已失效${mins != null ? `（${mins} 分钟前登录）` : ''}，重新登录。`);
        clearSession(SESSION);
      }
    }
  }

  log(`登录中 (${username}) ...`);
  const auth = await login({
    username,
    password,
    templates,
    attempts: 8,
    log: (m) => log('  ' + m),
  });
  if (!auth.ok) return { error: auth };

  if (SESSION) {
    saveSession(SESSION, auth.jar, { username });
    log(`会话已保存到 ${path.basename(SESSION)}`);
  }
  cachedApi = new Api(auth.jar);
  await announce(cachedApi);
  return { api: cachedApi };
}

async function connectOrFail() {
  const conn = await connect();
  if (!conn.error) return conn;

  const auth = conn.error;
  if (auth.locked) {
    console.error(`[${stamp()}] 账号已锁定：${auth.reason}`);
    console.error('  连续密码错误会触发锁定（约 10 分钟）。脚本已停止，以免延长锁定。');
    return { code: 3, result: { ok: false, locked: true, reason: auth.reason }, mail: { kind: 'locked', error: auth.reason } };
  }
  console.error(`[${stamp()}] 登录失败：${auth.reason}`);
  return { code: 1, result: { ok: false, reason: auth.reason }, mail: { kind: 'error', error: auth.reason } };
}

/** Run `fn(api)`; if the stored session turns out to be stale, log in and retry once. */
async function withApi(fn) {
  let conn = await connect({ force: args.fresh });
  if (conn.code) return conn;
  try {
    return await fn(conn.api);
  } catch (e) {
    if (!isAuthError(e)) throw e;
    log('会话在运行中失效，重新登录后重试 ...');
    if (SESSION) clearSession(SESSION);
    cachedApi = null;
    conn = await connectOrFail();
    if (conn.code) return conn;
    return fn(conn.api);
  }
}

// ---------------------------------------------------------------- one round
async function runOnce() {
  return withApi(async (api) => {
    const who = identity || { 学号: username, 姓名: '' };
    const tasks = await listTasks(api);
    const due = tasks.filter(isDue);

    if (args.list) {
      for (const t of tasks) {
        console.log(`${t.zt === '进行中' ? '●' : ' '} ${(t.fxdkrw || '').padEnd(6)} ${t.dkkssj} ~ ${t.dkjssj}  ${t.zt}  ${t.dkztmc}  [${t.qdmsmc}]`);
      }
      return { code: 0, result: { ok: true, ...who, tasks } };
    }

    log(`共 ${tasks.length} 个任务，可签到 ${due.length} 个`);
    if (!due.length) {
      log('当前没有需要签到的任务。');
      return { code: 2, result: { ok: true, ...who, due: 0, tasks }, mail: { kind: 'idle', tasks, due: 0 } };
    }

    // Required health questions have no configured default; repeat the student's
    // own most recent declaration unless config.json overrides it.
    const answers = { ...(await recentAnswers(api, tasks, log)), ...(cfg.health || {}) };
    log(`将填写的申报项：${JSON.stringify({ wz: location, sffwn: inRange ? '1' : '0', ...answers })}`);

    const results = [];
    for (const t of due) {
      try {
        results.push(await signTask(api, t, { location, inRange, dryRun: args.dryRun, answers, log }));
      } catch (e) {
        results.push({ task: t, ok: false, reason: e.message });
        log(`  -> 异常: ${e.message}`);
      }
    }

    const failed = results.filter((r) => !r.ok);
    const signed = results.filter((r) => r.ok && !r.skipped && !r.dryRun);
    log(`完成：${who.学号} ${who.姓名} 成功签到 ${signed.length} 个，失败 ${failed.length} 个。`);
    return {
      code: failed.length ? 1 : 0,
      result: { ok: !failed.length, ...who, signed: signed.length, results },
      mail: { kind: 'run', results, tasks, due: due.length },
    };
  });
}

/** Render and send the notification for one round, if mail is configured. */
async function sendReport(outcome) {
  if (!mail || !outcome.mail) return;
  if (outcome.mail.kind === 'idle' && !mail.notifyWhenIdle) {
    log('本轮无需签到，不发送邮件。');
    return;
  }
  const report = formatReport({ identity: identity || {}, ...outcome.mail });
  await notify(mail, report, log);
}

// ---------------------------------------------------------------- main
let outcome;
try {
  outcome = await runOnce();
} catch (e) {
  console.error(`[${stamp()}] 运行失败：${e.message}`);
  if (args.json) console.log(JSON.stringify({ ok: false, 学号: username, 姓名: identity?.姓名 || '', reason: e.message }, null, 2));
  await sendReport({ mail: { kind: 'error', error: e.message } });
  process.exit(1);
}
if (args.json) console.log(JSON.stringify(outcome.result, null, 2));
await sendReport(outcome);

if (args.watch > 0 && outcome.code !== 3) {
  const ms = args.watch * 60 * 1000;
  log(`进入监视模式，每 ${args.watch} 分钟检查一次。按 Ctrl+C 退出。`);
  for (;;) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const o = await runOnce();
      if (args.json) console.log(JSON.stringify(o.result));
      await sendReport(o);
      if (o.code === 3) { log('账号锁定，监视模式停止。'); break; }
    } catch (e) {
      console.error(`[${stamp()}] 本轮出错：${e.message}`);
      await sendReport({ mail: { kind: 'error', error: e.message } });
    }
  }
} else {
  process.exit(outcome.code);
}
