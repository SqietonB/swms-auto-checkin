// Persist the authenticated cookie jar across runs so the script does not have
// to solve a CAPTCHA (and risk a lockout) on every invocation.
import fs from 'node:fs';
import path from 'node:path';
import { Jar } from './cas.mjs';

export function sessionFile(dir, username) {
  const safe = String(username || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `.session-${safe}.json`);
}

/**
 * @returns {{jar:Jar, savedAt:number, username:string, file:string}|null}
 */
export function loadSession(file, { username, maxAgeMs = 0 } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || !raw.cookies || !Object.keys(raw.cookies).length) return null;
  if (username && raw.username && raw.username !== username) return null;
  if (maxAgeMs && raw.savedAt && Date.now() - raw.savedAt > maxAgeMs) return null;

  const jar = new Jar();
  jar.load(raw.cookies);
  return { jar, savedAt: raw.savedAt || 0, username: raw.username, file };
}

export function saveSession(file, jar, { username } = {}) {
  const cookies = jar.toJSON();
  if (!Object.keys(cookies).length) return null;
  const data = { username, savedAt: Date.now(), cookies };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not fatal on Windows */ }
  return data;
}

export function clearSession(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
