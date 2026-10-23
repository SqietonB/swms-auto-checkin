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
import { editableFields, isDue } from '../lib/checkin.mjs';
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
