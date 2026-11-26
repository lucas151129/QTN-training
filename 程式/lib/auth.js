// 口令与会话。试用级的实现：scrypt 加盐哈希 + 随机 token 存 DB。
// 之所以不搞 JWT，是因为只有一台服务器，DB 会话更容易「老师一键踢掉某学生」。
import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [scheme, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(pw), salt, 64);
    const want = Buffer.from(hash, 'hex');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch {
    return false;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSession(db, userId) {
  const token = newToken();
  const now = new Date();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
  return token;
}

export function getSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(row.user_id);
  return user || null;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
