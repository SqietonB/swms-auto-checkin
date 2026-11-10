// Offline test suite — no network, no credentials.
//
// The RSA vector below is the important one: it is a ciphertext copied verbatim
// from a real browser login request, and it pins down the site's unusual
// textbook-RSA + reversed-plaintext scheme. If someone "fixes" rsaEncrypt() to
// use standard PKCS#1 v1.5, this test fails immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rsaEncrypt, Jar, form } from '../lib/cas.mjs';
import { FALLBACK_KEY } from '../lib/auth.mjs';
import { editableFields, isDue, listTasks, taskListBody, TASK_LIST_BODY, TASK_PAGE_SIZE } from '../lib/checkin.mjs';
import { recognize } from '../lib/ocr.mjs';
import { decodePNG } from '../lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ROOT, 'templates.json');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

// Captured from a real browser login POST to the CAS v1/tickets endpoint
// for the throwaway password "DummyPass123".
//
// Its provenance was double-checked by decrypting it with the private exponent
// that the CAS front-end bundle leaks: the plaintext is exactly
// reverse("DummyPass123") with no padding — which is why standard PKCS#1 v1.5
// encryption is rejected by this server.
const BROWSER_CIPHERTEXT =
  '9d4222c3e0aee4e1df8de90f50e6b527deb8c8423d604435b5670ffde47e1b7e33fbf9aaa50d61b147bbb27be8b9c952da7cfbee52f180628ae84773d8743a42dd5e83b7e7bc5cf01729f065a95e217b3a547c951b1a35901ebecd0b304a13e61f24efd190eaecf81c16dde80d8676f44ac288ca269607e81f369a017a759bcf';

test('rsaEncrypt reproduces the real browser ciphertext', () => {
  const got = rsaEncrypt('DummyPass123', FALLBACK_KEY.modulus, FALLBACK_KEY.public_exponent);
  assert.equal(got, BROWSER_CIPHERTEXT);
});

test('rsaEncrypt output shape and determinism', () => {
  const a = rsaEncrypt('DummyPass123', FALLBACK_KEY.modulus, FALLBACK_KEY.public_exponent);
  const b = rsaEncrypt('DummyPass123', FALLBACK_KEY.modulus, FALLBACK_KEY.public_exponent);
  assert.equal(a, b, 'textbook RSA without padding must be deterministic');
  assert.equal(a.length, 256, '1024-bit modulus => 256 hex chars');
  assert.match(a, /^[0-9a-f]+$/);

  const other = rsaEncrypt('DummyPass124', FALLBACK_KEY.modulus, FALLBACK_KEY.public_exponent);
  assert.notEqual(a, other);
});

test('rsaEncrypt rejects a password longer than the modulus', () => {
  assert.throws(() => rsaEncrypt('x'.repeat(200), FALLBACK_KEY.modulus, FALLBACK_KEY.public_exponent));
});

test('form() URL-encodes and drops undefined values', () => {
  assert.equal(form({ a: '1', b: 'x y', c: undefined, d: '' }), 'a=1&b=x+y&d=');
});

test('Jar stores cookies and renders them in order', () => {
  const jar = new Jar();
  jar.load({ JSESSIONID: 'abc', route: 'r1' });
  assert.equal(jar.header(), 'JSESSIONID=abc; route=r1');
  assert.deepEqual(jar.toJSON(), { JSESSIONID: 'abc', route: 'r1' });
});

test('templates.json is well formed', () => {
  const t = JSON.parse(fs.readFileSync(TEMPLATES, 'utf8'));
  assert.equal(t.version, 1);
  assert.equal(t.size, 16);
  assert.equal(t.charset, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghjklmnopqrstuvwxyz');
  assert.equal(t.charset.length, 61, 'the captcha never uses the letter i');
  assert.ok(!t.charset.includes('i'));
  assert.ok(t.templates.length >= 61);

  for (const tpl of t.templates) {
    assert.ok(t.charset.includes(tpl.ch), `unknown char ${tpl.ch}`);
    assert.equal(tpl.vec.length, t.size * t.size, `${tpl.ch} vector must be 16x16`);
    assert.ok(tpl.vec.every((v) => v >= 0 && v <= 1.5), `${tpl.ch} vector must be normalised`);
  }
});

test('every charset character has at least one template', () => {
  const t = JSON.parse(fs.readFileSync(TEMPLATES, 'utf8'));
  const covered = new Set(t.templates.map((x) => x.ch));
  for (const ch of t.charset) assert.ok(covered.has(ch), `no template for "${ch}"`);
});

test('PNG decoder reads the captcha fixtures', () => {
  const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.png')) : [];
  assert.ok(files.length > 0, 'expected captcha fixtures in test/fixtures');

  for (const f of files) {
    const img = decodePNG(fs.readFileSync(path.join(FIXTURES, f)));
    assert.ok(img.width > 10 && img.height > 10, `${f}: implausible size`);
    assert.equal(img.rgba.length, img.width * img.height * 4, `${f}: rgba length`);
  }
});

test('OCR returns 4 in-charset characters for every fixture', () => {
  const t = JSON.parse(fs.readFileSync(TEMPLATES, 'utf8'));
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.png'));
  let confident = 0;

  for (const f of files) {
    const rec = recognize(fs.readFileSync(path.join(FIXTURES, f)), t);
    assert.equal(rec.count, 4, `${f}: segmented ${rec.count} glyphs, not 4`);
    assert.equal(rec.text.length, 4, `${f}: read "${rec.text}"`);
    for (const ch of rec.text) assert.ok(t.charset.includes(ch), `${f}: "${ch}" is not in the charset`);
    if (rec.confident) confident++;
  }

  // The bundled fixtures were used to build the templates, so this is a
  // regression guard on segmentation — not a measure of real-world accuracy.
  assert.ok(confident >= files.length - 1, `only ${confident}/${files.length} fixtures read confidently`);
});

test('OCR also accepts a bare template array', () => {
  const t = JSON.parse(fs.readFileSync(TEMPLATES, 'utf8'));
  const f = fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.png'))[0];
  const png = fs.readFileSync(path.join(FIXTURES, f));
  assert.deepEqual(
    recognize(png, t.templates).text,
    recognize(png, t).text,
  );
});

test('isDue matches only open, unsigned tasks', () => {
  assert.equal(isDue({ zt: '进行中', dkzt: '0', dkztmc: '未签到' }), true);
  assert.equal(isDue({ zt: '进行中', dkzt: '1', dkztmc: '已签到' }), false, 'already signed');
  assert.equal(isDue({ zt: '已截止', dkzt: '0', dkztmc: '未签到' }), false, 'window closed');
  assert.equal(isDue({ zt: '未开始', dkzt: '0', dkztmc: '未签到' }), false, 'not open yet');
});

test('editableFields applies the browser rule: editable && !hidden && showType !== hidden', () => {
  const formData = {
    groupFields: [
      {
        fields: [
          { fieldCode: 'dkzp', editable: true, hidden: false, showType: 'select', value: '', defaultValue: '' },
          { fieldCode: 'wd', editable: true, hidden: false, showType: 'input', value: '36' },
          { fieldCode: 'wz', editable: false, hidden: true, showType: 'text', value: 'somewhere' },
          { fieldCode: 'sffwn', editable: true, hidden: true, showType: 'radio', value: '0' },
          { fieldCode: 'secret', editable: true, hidden: false, showType: 'hidden', value: 'x' },
          { fieldCode: 'ro', editable: false, hidden: false, showType: 'text', value: 'read only' },
        ],
      },
      { fields: [{ fieldCode: 'jszk', editable: true, hidden: false, showType: 'select', defaultValue: '1' }] },
    ],
  };
  assert.deepEqual(editableFields(formData), { dkzp: '', wd: '36', jszk: '1' });
});

test('editableFields tolerates a malformed form payload', () => {
  assert.deepEqual(editableFields(undefined), {});
  assert.deepEqual(editableFields({}), {});
  assert.deepEqual(editableFields({ groupFields: [{}, { fields: [] }] }), {});
});

// ------------------------------------------------------------ task-list paging
//
// The task list is paginated and ordered oldest-first (by row_id), so the task
// that is currently open is on the LAST page. Fetching page 1 only — which the
// original code did — hides it as soon as the history passes TASK_PAGE_SIZE
// records, and the script reports "nothing due" forever.

/** A stand-in for Api that serves `pages` (an array of item arrays). */
function fakeApi(pages, { code = 0, calls = [] } = {}) {
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      if (code !== 0) return { json: { code, msg: 'server said no' }, text: '' };
      const page = Number(body.currentPage);
      return {
        json: { code: 0, data: { items: pages[page - 1] || [], currentPage: page, totalPage: pages.length } },
        text: '',
      };
    },
  };
}

const task = (id, { zt = '已截止', dkzt = '0', dkztmc = '未签到' } = {}) => ({
  id, rwid: `rw-${id}`, dkkssj: '2026-10-22 06:30:00', dkjssj: '2026-10-22 09:00:00', zt, dkzt, dkztmc,
});

test('taskListBody pages the request and leaves the template on page 1', () => {
  assert.equal(taskListBody(3).currentPage, '3');
  assert.equal(taskListBody(3).showCount, String(TASK_PAGE_SIZE));
  assert.equal(taskListBody(2, 10).showCount, '10');
  assert.equal(TASK_LIST_BODY.currentPage, '1', 'the exported template must not be mutated');
  assert.equal(TASK_LIST_BODY.showCount, String(TASK_PAGE_SIZE));
});

test('listTasks finds the open task when it sits beyond the first page', async () => {
  const firstPage = Array.from({ length: TASK_PAGE_SIZE }, (_, i) => task(`old-${i}`));
  const secondPage = [task('recent'), task('open', { zt: '进行中', dkzt: '0', dkztmc: '未签到' })];
  const api = fakeApi([firstPage, secondPage]);

  const tasks = await listTasks(api, {});
  assert.equal(tasks.length, TASK_PAGE_SIZE + 2, 'every record must come back');
  assert.equal(api.calls.length, 3, 'a full page must be followed by another request');

  const due = tasks.filter(isDue);
  assert.equal(due.length, 1, 'the open task is only reachable by paging');
  assert.equal(due[0].id, 'open');
});

test('listTasks stops on the first empty page', async () => {
  const api = fakeApi([[task('a')], []]);
  const tasks = await listTasks(api, { showCount: 1 });
  assert.deepEqual(tasks.map((t) => t.id), ['a']);
  assert.equal(api.calls.length, 2);
});

test('listTasks stops when the server repeats a page instead of advancing', async () => {
  const page = [task('a'), task('b')];
  const api = fakeApi([page, page]);
  const tasks = await listTasks(api, { showCount: 2 });
  assert.deepEqual(tasks.map((t) => t.id), ['a', 'b'], 'the repeat must not duplicate records');
  assert.equal(api.calls.length, 2, 'the wrap-around must be detected immediately');
});

test('listTasks ignores records that overlap two pages', async () => {
  const api = fakeApi([[task('a'), task('b')], [task('b'), task('c')]]);
  const tasks = await listTasks(api, { showCount: 2 });
  assert.deepEqual(tasks.map((t) => t.id), ['a', 'b', 'c']);
});

test('listTasks stops at maxPages and says so', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => [task(`p${i}`)]);
  const api = fakeApi(pages);
  const logs = [];
  const tasks = await listTasks(api, { showCount: 1, maxPages: 3, log: (m) => logs.push(m) });

  assert.equal(tasks.length, 3);
  assert.equal(api.calls.length, 3, 'a misbehaving server must not spin forever');
  assert.ok(logs.some((m) => /页上限/.test(m)), 'truncation must be reported');
});

test('listTasks surfaces a non-zero server code', async () => {
  const api = fakeApi([[]], { code: 500 });
  await assert.rejects(() => listTasks(api), /task list failed/);
});
