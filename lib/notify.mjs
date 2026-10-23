// Email notification: decide whether to notify, render the report, send it.
//
// Notifying must never break the check-in itself, so every failure here is
// reported to the log and swallowed.
import { sendMail } from './mail.mjs';

const SPLIT = /[,;\s]+/;
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(SPLIT)).map((s) => String(s).trim()).filter(Boolean);

/**
 * Normalise the mail settings from config.json, environment and CLI.
 * @returns {{host:string,port:number,secure:boolean,user:string,pass:string,from:string,to:string[]}|null}
 */
export function mailConfig({ cfg = {}, mailTo, noMail = false, env = process.env } = {}) {
  if (noMail) return null;

  const m = { ...(cfg.mail || {}) };
  const truthy = (v) => !/^(0|false|no)$/i.test(String(v).trim());

  // SWMS_* is the documented prefix; ZHGX_* keeps older setups working.
  const get = (name) => (env[`SWMS_${name}`] !== undefined ? env[`SWMS_${name}`] : env[`ZHGX_${name}`]);

  const set = (name, key, cast = (v) => v) => {
    const v = get(`MAIL_${name}`);
    if (v !== undefined && v !== '') m[key] = cast(v);
  };
  set('HOST', 'host');
  set('PORT', 'port', Number);
  set('USER', 'user');
  set('PASS', 'pass');
  set('FROM', 'from');
  set('TO', 'to', list);
  set('SECURE', 'secure', truthy);
  set('ALLOW_INSECURE', 'allowInsecure', truthy);

  if (mailTo) m.to = list(mailTo);

  if (m.enabled === false) return null;

  const to = list(m.to ?? m.receiver);
  const host = String(m.host ?? m.smtp_host ?? '').trim();
  const user = String(m.user ?? m.sender ?? '').trim();
  const from = String(m.from ?? user).trim();

  // Auto-enable when the essentials are present; opt out with "enabled": false.
  if (!host || !to.length || !from) return null;

  const port = Number(m.port ?? m.smtp_port ?? (m.secure === false ? 587 : 465));
  return {
    host,
    port,
    secure: m.secure !== false && port !== 587 && port !== 25,
    user,
    pass: String(m.pass ?? m.sender_key ?? ''),
    from,
    to,
    allowInsecure: m.allowInsecure === true,
    notifyWhenIdle: m.notifyWhenIdle === true,
  };
}

const pad = (n) => String(n).padStart(2, '0');
const ts = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const FRIENDLY = {
  dkzp: (v) => ({ 1: '是，在学校', 2: '否，不在学校' }[v] || v),
  jszk: (v) => ({ 1: '好', 2: '一般', 3: '差' }[v] || v),
  yclx: (v) => ({ 1: '咳嗽', 2: '腹泻', 4: '流涕', 5: '以上都无' }[v] || v),
};

function describeAnswer(key, value) {
  if (value === '' || value == null) return '(空)';
  return FRIENDLY[key] ? `${value}（${FRIENDLY[key](value)}）` : String(value);
}

/**
 * Render the notification.
 * @returns {{subject:string, body:string, ok:boolean}}
 */
export function formatReport({ identity = {}, results = [], tasks = [], due = 0, kind, error, at = new Date() }) {
  const who = [identity.学号 || '', identity.姓名 || ''].filter(Boolean).join(' ');

  const signed = results.filter((r) => r.ok && !r.skipped && !r.dryRun);
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => !r.ok);

  const isError = kind === 'error' || kind === 'locked';
  const ok = !isError && failed.length === 0 && signed.length > 0;

  const names = (list_) => list_.map((r) => r.task?.fxdkrw).filter(Boolean).join('、');
  let headline;
  if (kind === 'locked') headline = '🔒 账号锁定';
  else if (kind === 'error') headline = '⚠️ 运行异常';
  else if (failed.length && signed.length) headline = '⚠️ 部分签到失败';
  else if (failed.length) headline = '❌ 签到失败';
  else if (signed.length) headline = '✅ 签到成功';
  else headline = 'ℹ️ 无需签到';

  const detail = failed.length && signed.length ? `${names(signed)}、${names(failed)}` : names(signed) || names(failed);
  const plain = headline.replace(/^[^\u4e00-\u9fa5]+/, '').trim();
  const subject = `[${plain}] ${who}${detail ? ' · ' + detail : ''}`.trim();

  const lines = [];
  lines.push(headline);
  lines.push('');
  if (who) lines.push(`账号：${who}`);

  if (isError) {
    lines.push(`时间：${ts(at)}`);
    lines.push('');
    lines.push(kind === 'locked' ? '账号已锁定：' + (error || '') : '错误：' + (error || ''));
    if (kind === 'locked') lines.push('连续密码错误会触发锁定，脚本已停止以免延长锁定。');
  } else {
    lines.push(`时间：${ts(at)}`);
    if (signed.length || failed.length || skipped.length) {
      lines.push(`结果：成功 ${signed.length} 个，失败 ${failed.length} 个${skipped.length ? `，已签到 ${skipped.length} 个` : ''}`);
    }
  }

  if (signed.length) {
    lines.push('');
    lines.push('─ 签到成功 ─');
    for (const r of signed) {
      lines.push(`✅ ${r.task?.fxdkrw || ''}  ${r.task?.dkkssj || ''} ~ ${r.task?.dkjssj || ''}`);
      if (r.body) {
        lines.push('   提交内容：');
        for (const [k, v] of Object.entries(r.body)) {
          if (['id', 'rwid', 'dkjg'].includes(k)) continue;
          const label = { wz: '位置', sffwn: '是否在范围内', dkzp: '是否在校', wd: '体温', jszk: '精神状况', yclx: '症状' }[k] || k;
          lines.push(`     ${label}：${describeAnswer(k, v)}`);
        }
      }
    }
  }

  if (failed.length) {
    lines.push('');
    lines.push('─ 签到失败 ─');
    for (const r of failed) {
      lines.push(`❌ ${r.task?.fxdkrw || ''}  ${r.task?.dkkssj || ''} ~ ${r.task?.dkjssj || ''}`);
      lines.push(`   原因：${r.reason || '未知'}`);
    }
  }

  if (!signed.length && !failed.length && !isError) {
    lines.push('');
    lines.push(due ? '有任务待签到但未产生结果。' : '当前没有需要签到的任务。');
    for (const t of tasks) {
      lines.push(`  ${t.zt === '进行中' ? '●' : ' '} ${t.fxdkrw}  ${t.dkkssj} ~ ${t.dkjssj}  ${t.zt}  ${t.dkztmc}`);
    }
  }

  lines.push('');
  lines.push('— 由 swms-auto-checkin 自动发送');

  return { subject, body: lines.join('\n') + '\n', ok };
}

/**
 * Send a notification. Never throws: mail problems are logged, not propagated.
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function notify(mail, report, log = () => {}) {
  if (!mail) return { sent: false, reason: '未配置邮箱' };
  try {
    await sendMail({ ...mail, subject: report.subject, body: report.body });
    log(`邮件已发送 → ${mail.to.join(', ')}（${report.subject}）`);
    return { sent: true };
  } catch (e) {
    log(`邮件发送失败：${e.message}`);
    return { sent: false, reason: e.message };
  }
}
