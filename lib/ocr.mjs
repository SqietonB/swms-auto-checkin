// Captcha binarisation + glyph segmentation + template OCR (zero dependencies).
//
// Findings about this CAPTCHA (/lyuapServer/kaptcha):
//   * always exactly 4 characters, sans-serif, no rotation, no noise lines
//   * each character gets a random colour -> random ink intensity per glyph,
//     so thresholds must be relative to the whole image, then each glyph is
//     contrast-normalised on its own
//   * global threshold of 0.15 * (max colour distance) segments all glyphs cleanly
import { decodePNG } from './png.mjs';

export const SIZE = 16;

/** Per-pixel colour distance from the image's dominant (background) colour. */
export function inkDistance(img) {
  const { width, height, rgba } = img;
  const n = width * height;
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const k = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bg = 0, best = -1;
  for (const [k, c] of counts) if (c > best) { best = c; bg = k; }
  const br = (bg >> 16) & 255, bgr = (bg >> 8) & 255, bb = bg & 255;
  const dist = new Float32Array(n);
  let maxd = 0;
  for (let i = 0; i < n; i++) {
    const dr = rgba[i * 4] - br, dg = rgba[i * 4 + 1] - bgr, db = rgba[i * 4 + 2] - bb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    dist[i] = d;
    if (d > maxd) maxd = d;
  }
  return { dist, maxd, bg };
}

function columnSegments(mask, width, height) {
  const cols = new Array(width).fill(false);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) if (mask[y * width + x]) { cols[x] = true; break; }
  }
  const out = [];
  let s = -1;
  for (let x = 0; x < width; x++) {
    if (cols[x]) { if (s < 0) s = x; }
    else if (s >= 0) { out.push([s, x - 1]); s = -1; }
  }
  if (s >= 0) out.push([s, width - 1]);
  return out.filter(([a, b]) => b >= a);
}

function glyphBBox(mask, width, height, x0, x1) {
  let y0 = Infinity, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = x0; x <= x1; x++) if (mask[y * width + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
  }
  return { y0, y1 };
}

/**
 * Resample the glyph bbox onto a SIZE x SIZE grid, preserving aspect ratio
 * (shorter side centred with padding) and normalising contrast to 0..1.
 * Aspect preservation matters here: 'l'/'I'/'1' differ only in fine detail.
 */
export function normalise(dist, width, x0, x1, y0, y1, size = SIZE) {
  const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
  let peak = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = dist[y * width + x]; if (v > peak) peak = v; }
  if (peak <= 0) peak = 1;

  const scale = size / Math.max(gw, gh);
  const nw = Math.max(1, Math.min(size, Math.round(gw * scale)));
  const nh = Math.max(1, Math.min(size, Math.round(gh * scale)));
  const ox = Math.floor((size - nw) / 2);
  const oy = Math.floor((size - nh) / 2);

  const out = new Float32Array(size * size);
  for (let gy = 0; gy < nh; gy++) {
    const sy0 = y0 + Math.floor((gy * gh) / nh);
    let sy1 = y0 + Math.floor(((gy + 1) * gh) / nh) - 1;
    if (sy1 < sy0) sy1 = sy0;
    for (let gx = 0; gx < nw; gx++) {
      const sx0 = x0 + Math.floor((gx * gw) / nw);
      let sx1 = x0 + Math.floor(((gx + 1) * gw) / nw) - 1;
      if (sx1 < sx0) sx1 = sx0;
      let sum = 0, cnt = 0;
      for (let y = sy0; y <= sy1 && y <= y1; y++) {
        for (let x = sx0; x <= sx1 && x <= x1; x++) { sum += dist[y * width + x]; cnt++; }
      }
      out[(oy + gy) * size + (ox + gx)] = cnt ? sum / cnt / peak : 0;
    }
  }
  return out;
}

export function vecDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}

export function renderVec(v, size = SIZE, chars = ' .:-=+*#%@') {
  const rows = [];
  for (let y = 0; y < size; y++) {
    let s = '';
    for (let x = 0; x < size; x++) s += chars[Math.min(chars.length - 1, Math.round(v[y * size + x] * (chars.length - 1)))];
    rows.push(s);
  }
  return rows.join('\n');
}

/**
 * Extract glyphs from a captcha PNG.
 * @returns {{width:number,height:number,glyphs:Array<{x0:number,x1:number,y0:number,y1:number,w:number,h:number,vec:Float32Array}>}}
 */
export function extractGlyphs(pngBuffer, { inkFraction = 0.15, size = SIZE, expect = 4 } = {}) {
  const img = decodePNG(pngBuffer);
  const { dist, maxd } = inkDistance(img);
  const n = img.width * img.height;
  const mask = new Uint8Array(n);
  const cut = maxd * inkFraction;
  for (let i = 0; i < n; i++) mask[i] = dist[i] > cut ? 1 : 0;

  let segs = columnSegments(mask, img.width, img.height);
  // Be defensive: touching glyphs can merge into one run, and stray specks can
  // add runs. Force the known 4-character layout by splitting the widest run /
  // dropping the narrowest speck until we have `expect` segments.
  if (expect > 0) {
    while (segs.length < expect) {
      let widest = -1, wi = -1;
      for (let i = 0; i < segs.length; i++) {
        const w = segs[i][1] - segs[i][0];
        if (w > widest) { widest = w; wi = i; }
      }
      if (wi < 0 || widest < 4) break;
      const [a, b] = segs[wi];
      let bestX = a + (widest >> 1), bestV = Infinity;
      for (let x = a + 2; x <= b - 2; x++) {
        let v = 0;
        for (let y = 0; y < img.height; y++) if (mask[y * img.width + x]) v++;
        if (v < bestV) { bestV = v; bestX = x; }
      }
      segs.splice(wi, 1, [a, bestX - 1], [bestX, b]);
    }
    while (segs.length > expect) {
      let narrowest = Infinity, ni = -1;
      for (let i = 0; i < segs.length; i++) {
        const w = segs[i][1] - segs[i][0];
        if (w < narrowest) { narrowest = w; ni = i; }
      }
      if (ni < 0) break;
      segs.splice(ni, 1);
    }
    segs.sort((p, q) => p[0] - q[0]);
  }

  const glyphs = segs.map(([x0, x1]) => {
    const { y0, y1 } = glyphBBox(mask, img.width, img.height, x0, x1);
    return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, vec: normalise(dist, img.width, x0, x1, y0, y1, size) };
  });
  return { width: img.width, height: img.height, mask, glyphs };
}

/** Greedy nearest-template classification. Templates: [{ch, vec}] */
export function classify(vec, templates, { maxDistance = 0.16 } = {}) {
  let best = null, bestD = Infinity, second = Infinity;
  for (const t of templates) {
    const d = vecDistance(vec, t.vec);
    if (d < bestD) { second = bestD; bestD = d; best = t; }
    else if (d < second) second = d;
  }
  if (!best) return { ch: '', distance: Infinity, confidence: 0, ok: false };
  const margin = second === Infinity ? 1 : second - bestD;
  return { ch: best.ch, distance: bestD, margin, ok: bestD <= maxDistance };
}

/**
 * Recognise a captcha image.
 * @returns {{text:string, glyphs:Array<{ch:string,distance:number,margin:number}>, confident:boolean}}
 */
export function recognize(pngBuffer, templateFile, { maxDistance = 0.16, minMargin = 0.02, expect = 4 } = {}) {
  const templates = Array.isArray(templateFile) ? templateFile : templateFile.templates;
  const { glyphs } = extractGlyphs(pngBuffer, { inkFraction: templateFile.inkFraction ?? 0.15, size: templateFile.size ?? SIZE, expect });
  const results = glyphs.map((g) => classify(g.vec, templates, { maxDistance }));
  const text = results.map((r) => r.ch).join('');
  const confident = results.length === expect
    && results.every((r) => r.ok && (r.margin === undefined || r.margin >= minMargin));
  return { text, glyphs: results, count: results.length, confident };
}
