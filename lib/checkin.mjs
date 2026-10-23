// 签到任务 (daily check-in) discovery + submission.
//
// Contract reverse-engineered from the SPA bundle (rcsw~ba27a82c) and verified
// against a live session:
//
//   POST /rcsw/qdrw/getStudentQdTask.zf   -> the student's task list
//   GET  /rcsw/qdrw/signData.zf?rwid=     -> per-task record (jlid) + time window
//   GET  /rcsw/qdrw/signPersonData.zf?id= -> record state (dkzt 1 = already signed)
//   GET  /dynamic/form/group/qdrwjg/qd.zf -> the check-in form (health questions)
//   POST /rcsw/qdrw/sign.zf               -> the actual sign-in
//
// The browser builds the sign-in body as
//   { id, rwid, dkjg: '1', wz, sffwn, ...onlyEditableCodes }
// where onlyEditableCodes = every form field with `editable && !hidden &&
// showType !== 'hidden'`, and wz/sffwn come from the geolocation component.
import { Api } from './api.mjs';

export const TASK_LIST_BODY = {
  gnczid: 'qdrw_action',
  inputType: JSON.stringify({ fxdkrw: [''] }),
  selectType: '{}',
  inputSqlType: '0',
  orders: '[]',
  showCount: '50',
  currentPage: '1',
  checkBoxType: '{}',
  dateType: '{}',
  numberType: '{}',
};

export async function listTasks(api) {
  const r = await api.post('/rcsw/qdrw/getStudentQdTask.zf', TASK_LIST_BODY);
  if (r.json?.code !== 0) throw new Error(`task list failed: ${r.json?.msg || r.text.slice(0, 200)}`);
  return r.json.data?.items || [];
}

/** The fields the browser would submit for this record. */
export function editableFields(formData) {
  const fields = (formData?.groupFields || []).flatMap((g) => g.fields || []);
  const out = {};
  for (const f of fields) {
    if (f.editable && !f.hidden && f.showType !== 'hidden') {
      out[f.fieldCode] = f.value ?? f.defaultValue ?? '';
    }
  }
  return out;
}

export function isDue(task) {
  return task.zt === '进行中' && task.dkzt !== '1' && task.dkztmc !== '已签到';
}

export async function taskState(api, task) {
  const sd = await api.get('/rcsw/qdrw/signData.zf', { rwid: task.rwid });
  if (sd.json?.code !== 0) return { ok: false, reason: sd.json?.msg || 'signData failed' };
  const jlid = sd.json.data?.jlid;
  if (!jlid) return { ok: false, reason: '任务未找到或不属于您的任务列表' };

  const pd = await api.get('/rcsw/qdrw/signPersonData.zf', { id: jlid });
  if (pd.json?.code !== 0) return { ok: false, reason: pd.json?.msg || 'signPersonData failed' };
  const data = pd.json.data || {};

  const df = await api.get('/dynamic/form/group/qdrwjg/qd.zf', { dataId: `data|qdrwjg|${jlid}` });
  const fields = df.json?.code === 0 ? editableFields(df.json.data) : {};
  return { ok: true, jlid, data, fields, window: { from: data.dkkssj, to: data.dkjssj } };
}

/**
 * Reuse the answers from the most recently signed record.
 *
 * The health questions (当前体温 / 精神状况 / 症状 / 是否在校) are required selects
 * with no configured default, so a fresh record comes back empty. Rather than
 * inventing health declarations, repeat whatever the student last declared.
 */
export async function recentAnswers(api, tasks, log = () => {}) {
  const signed = tasks
    .filter((t) => t.dkzt === '1')
    .sort((a, b) => String(b.dkjssj).localeCompare(String(a.dkjssj)));
  for (const t of signed.slice(0, 3)) {
    try {
      const s = await taskState(api, t);
      if (!s.ok) continue;
      const filled = Object.fromEntries(Object.entries(s.fields).filter(([, v]) => v !== '' && v != null));
      if (Object.keys(filled).length) {
        log(`沿用上次申报值（来自 ${t.fxdkrw} ${t.dkjssj}）：${JSON.stringify(filled)}`);
        return filled;
      }
    } catch { /* try the next one */ }
  }
  return {};
}

/**
 * Sign one task.
 * @param {object} opts
 *   location  address string recorded as 位置 (wz); may be empty
 *   inRange   whether that location is inside the configured fence (sffwn)
 *   answers   fallback values for required fields the record leaves empty
 *   dryRun    build the request but do not send it
 */
export async function signTask(api, task, { location = '', inRange = false, dryRun = false, answers = {}, log = () => {} } = {}) {
  const state = await taskState(api, task);
  if (!state.ok) return { task, ok: false, reason: state.reason };

  const { jlid, data, fields } = state;
  if (data.dkzt === '1') return { task, ok: true, skipped: true, reason: '已签到' };

  const merged = { ...answers, ...fields };
  for (const [k, v] of Object.entries(fields)) if (v === '' || v == null) merged[k] = answers[k] ?? v;

  const body = {
    id: jlid,
    rwid: task.rwid,
    dkjg: '1',
    wz: location,
    sffwn: inRange ? '1' : '0',
    ...merged,
  };

  if (dryRun) {
    log(`[dry-run] would POST /rcsw/qdrw/sign.zf ${JSON.stringify(body)}`);
    return { task, ok: true, dryRun: true, body };
  }

  log(`signing ${task.fxdkrw} (${task.dkkssj} ~ ${task.dkjssj}) ...`);
  const res = await api.post('/rcsw/qdrw/sign.zf', body);
  const code = res.json?.code;
  const msg = res.json?.msg || res.text.slice(0, 200);
  if (code === 0) {
    log(`  -> OK: ${msg}`);
    return { task, ok: true, msg, body };
  }
  if (/重复签到/.test(msg)) {
    log(`  -> already signed: ${msg}`);
    return { task, ok: true, skipped: true, msg, body };
  }
  log(`  -> FAILED: ${msg}`);
  return { task, ok: false, reason: msg, body };
}
