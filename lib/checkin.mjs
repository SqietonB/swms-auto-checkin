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

/** Page size for the task list. The browser uses 50 and the server honours it. */
export const TASK_PAGE_SIZE = 50;

/** Hard stop on pagination, so a misbehaving server cannot spin forever. */
export const TASK_MAX_PAGES = 40;

export const TASK_LIST_BODY = {
  gnczid: 'qdrw_action',
  inputType: JSON.stringify({ fxdkrw: [''] }),
  selectType: '{}',
  inputSqlType: '0',
  orders: '[]',
  showCount: String(TASK_PAGE_SIZE),
  currentPage: '1',
  checkBoxType: '{}',
  dateType: '{}',
  numberType: '{}',
};

/** The POST body for one page of the task list. */
export function taskListBody(page = 1, showCount = TASK_PAGE_SIZE) {
  return { ...TASK_LIST_BODY, showCount: String(showCount), currentPage: String(page) };
}

/** Stable identity for one task record, used to ignore overlapping pages. */
function taskKey(t) {
  if (t.id != null) return `id:${t.id}`;
  return `k:${t.rwid}|${t.dkkssj}|${t.dkjssj}`;
}

/**
 * Fetch the student's *complete* task list.
 *
 * The endpoint is paginated and its natural order is `row_id` ascending, i.e.
 * oldest record first — so the task that is currently open sits on the **last**
 * page. Asking for page 1 only (which is what this used to do) silently drops
 * every record past `showCount`, and once a student's history grows beyond 50
 * records the open task is never seen and the script reports "nothing due"
 * forever.
 *
 * Termination is driven by what the server actually returns — an empty page, or
 * a page that repeats the previous one — rather than by `totalPage`. Stopping a
 * page early loses tasks, while fetching a page too many costs one request, so
 * the loop deliberately errs towards the cheap failure.
 */
export async function listTasks(api, { showCount = TASK_PAGE_SIZE, maxPages = TASK_MAX_PAGES, log = () => {} } = {}) {
  const seen = new Map();
  let prevFirst = null;
  let page = 1;

  for (; page <= maxPages; page++) {
    const r = await api.post('/rcsw/qdrw/getStudentQdTask.zf', taskListBody(page, showCount));
    if (r.json?.code !== 0) throw new Error(`task list failed: ${r.json?.msg || r.text.slice(0, 200)}`);

    const items = r.json.data?.items || [];
    if (!items.length) break; // definitive end of the list

    const first = String(items[0]?.id ?? items[0]?.rwid ?? '');
    if (page > 1 && first && first === prevFirst) break; // server wrapped around
    prevFirst = first;

    for (const t of items) seen.set(taskKey(t), t);
  }

  if (page > maxPages) log(`任务列表超过 ${maxPages} 页上限，只取了前 ${seen.size} 条。`);
  else if (page > 2) log(`任务列表共 ${seen.size} 条，跨 ${page - 1} 页。`);

  return [...seen.values()];
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
