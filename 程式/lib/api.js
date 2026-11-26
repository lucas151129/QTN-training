// HTTP API 层。没有用框架，路由就是一张显式的 if 表——文件小、好读、好改。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createSession, getSession, destroySession, hashPassword, verifyPassword, parseCookies, SESSION_TTL_MS
} from './auth.js';
import { audit, nowIso, DEMO_QUESTIONS, logAiCall } from './db.js';
import { ROOT } from './config.js';
import {
  makeClient, gradeSubmission, transcribeImage, draftComment, suggestAssignment, classInsight, askAboutFeedback,
  generatePractice, judgePractice
} from './ai.js';

// 每個伺服器進程只需要一個 client（只是閉包，很輕）
let _client = null;
let _clientKey = '';
function getClient(cfg) {
  const key = [cfg.ai.baseUrl, cfg.ai.apiKey, cfg.ai.model, cfg.ai.visionModel, cfg.ai.effectiveMode].join('|');
  if (!_client || _clientKey !== key) { _client = makeClient(cfg); _clientKey = key; }
  return _client;
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '上傳內容過大，請減少相片數量或降低解析度'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '請求內容不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, role: u.role, login_id: u.login_id, name: u.name,
    class_name: u.class_name, class_no: u.class_no, student_no: u.student_no
  };
}

function parseQuestions(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : []);
  if (!list.length) throw new HttpError(400, '至少需要一題');
  const out = [];
  let total = 0;
  list.forEach((q, i) => {
    const no = str(q.no, 10) || String(i + 1);
    const prompt = str(q.prompt, 1000);
    if (!prompt) throw new HttpError(400, `第 ${no} 題缺少題目文字`);
    const type = ['text', 'photo', 'text_photo', 'essay'].includes(q.type) ? q.type : 'text';
    const points = (Array.isArray(q.points) ? q.points : []).map((p, j) => {
      const score = Number(p.score);
      if (!Number.isFinite(score) || score <= 0) throw new HttpError(400, `第 ${no} 題第 ${j + 1} 個評分點分數不正確`);
      return { id: str(p.id, 20) || `${no}-${j + 1}`, desc: str(p.desc, 300), score };
    });
    if (!points.length) throw new HttpError(400, `第 ${no} 題至少需要一個評分點`);
    const max = points.reduce((s, p) => s + p.score, 0);
    total += max;
    out.push({ no, tag: str(q.tag, 30) || '未分類', type, prompt, max, points });
  });
  return { questions: out, total };
}

function getAssignment(db, id) {
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, '找不到這份作業');
  row.questions = JSON.parse(row.questions_json);
  return row;
}

// 一份作業派給哪些班（多對多）。舊資料只有 assignments.class_name，
// migrate() 已補進 assignment_classes，所以統一從這張表讀。
function classesOf(db, assignmentId) {
  return db.prepare('SELECT class_name FROM assignment_classes WHERE assignment_id = ? ORDER BY class_name')
    .all(assignmentId).map((r) => r.class_name);
}

function setClasses(db, assignmentId, names, fallback) {
  db.prepare('DELETE FROM assignment_classes WHERE assignment_id = ?').run(assignmentId);
  const raw = Array.isArray(names) && names.length ? names : (fallback ? [fallback] : []);
  const list = [...new Set(raw.map((n) => String(n).trim().toUpperCase()).filter(Boolean))];
  const ins = db.prepare('INSERT OR IGNORE INTO assignment_classes (assignment_id, class_name) VALUES (?,?)');
  for (const c of list) ins.run(assignmentId, c);
  return list;
}

// 沒指定班別 = 全校可見（試用期的舊作業就是這樣）
function visibleToClass(db, assignmentId, className) {
  const list = classesOf(db, assignmentId);
  if (!list.length) return true;
  return list.includes(String(className || '').toUpperCase());
}

function classSizeOf(db, classNames) {
  if (!classNames.length) {
    return db.prepare('SELECT COUNT(*) n FROM roster').get().n
      || db.prepare("SELECT COUNT(*) n FROM users WHERE role='student'").get().n;
  }
  const q = db.prepare('SELECT COUNT(*) n FROM roster WHERE class_name = ?');
  const qu = db.prepare("SELECT COUNT(*) n FROM users WHERE role='student' AND class_name = ?");
  return classNames.reduce((s, c) => s + (q.get(c).n || qu.get(c).n), 0);
}

function assignmentSummary(row, db) {
  const classNames = db ? classesOf(db, row.id) : (row.class_name ? [row.class_name] : []);
  return {
    id: row.id, title: row.title, subject: row.subject,
    class_name: row.class_name,            // 舊欄位，仍然回傳（顯示用）
    class_names: classNames,               // 新：實際派給哪幾班
    description: row.description, total_score: row.total_score, due_at: row.due_at,
    status: row.status, allow_late: row.allow_late, created_at: row.created_at, term: row.term,
    question_count: (row.questions || []).length
  };
}

function filesBySubmission(db, submissionId) {
  return db.prepare('SELECT * FROM files WHERE submission_id = ? ORDER BY id').all(submissionId);
}

function serializeSubmission(db, sub, { forTeacher }) {
  const files = filesBySubmission(db, sub.id).map((f) => ({
    id: f.id, q_no: f.q_no, filename: f.filename, mime: f.mime, size: f.size, url: `/api/files/${f.id}`
  }));
  const reveal = forTeacher || sub.status === 'returned' || sub.status === 'questioned';
  const answers = db.prepare('SELECT * FROM answers WHERE submission_id = ? ORDER BY q_no').all(sub.id).map((a) => ({
    q_no: a.q_no,
    answer_text: a.answer_text,
    mode: a.mode || 'typed',
    transcript: a.transcript || null,
    transcript_confidence: a.transcript_confidence,
    transcript_notes: a.transcript_notes,
    uncertain: a.transcript_uncertain ? JSON.parse(a.transcript_uncertain) : [],
    corrected_text: reveal ? (a.corrected_text || null) : null,
    // 「用來評分的那份文字」：老師修正 > AI 轉寫 > 學生打的
    final_text: reveal ? (a.corrected_text || a.transcript || a.answer_text || '') : null
  }));
  const student = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.student_id);
  const out = {
    id: sub.id, assignment_id: sub.assignment_id, status: sub.status,
    submitted_at: sub.submitted_at, late: Boolean(sub.late),
    answers, files,
    student: student ? publicUser(student) : null
  };
  if (forTeacher) {
    out.ai = sub.ai_json ? JSON.parse(sub.ai_json) : null;
    out.ai_model = sub.ai_model;
    out.ai_at = sub.ai_at;
    out.ai_total = sub.ai_total;
    out.teacher_scores = sub.teacher_scores_json ? JSON.parse(sub.teacher_scores_json) : null;
    out.teacher_total = sub.teacher_total;
    out.teacher_comment = sub.teacher_comment;
    out.teacher_notes = sub.teacher_notes;
    out.graded_at = sub.graded_at;
    out.returned_at = sub.returned_at;
    out.question_text = sub.question_text;
    out.question_at = sub.question_at;
  } else if (sub.status === 'returned' || sub.status === 'questioned') {
    out.teacher_scores = sub.teacher_scores_json ? JSON.parse(sub.teacher_scores_json) : null;
    out.teacher_total = sub.teacher_total;
    out.teacher_comment = sub.teacher_comment;
    out.returned_at = sub.returned_at;
    out.question_text = sub.question_text;
  }
  return out;
}

function saveDataUrlImage(db, cfg, submissionId, qNo, dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, '相片格式不正確');
  const mime = m[1].toLowerCase();
  const okMime = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
  if (!okMime.includes(mime)) throw new HttpError(400, '只接受 JPG／PNG／WEBP／PDF 檔案');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > cfg.ai.maxImageBytes) throw new HttpError(400, '單一相片過大，請壓縮後再上載');
  const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const dir = path.join(cfg.uploadPath, String(submissionId));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${sha.slice(0, 12)}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  db.prepare('INSERT INTO files (submission_id, q_no, filename, mime, size, sha256, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(submissionId, String(qNo ?? ''), filename, mime, buf.length, sha, nowIso());
}

export function fileAbsPath(cfg, f) {
  return path.join(cfg.uploadPath, String(f.submission_id), f.filename);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function statusLabel(s) {
  return { submitted: '已提交', ai_graded: 'AI 已預批', returned: '已發還', questioned: '學生有疑問' }[s] || s;
}

// ---------------------------------------------------------------- 學情與錯題

const r1 = (n) => Math.round(n * 10) / 10;

// 把 scores 明細整理成「每個知識點的時間序列」
function buildProgress(db, studentId) {
  const rows = db.prepare(`
    SELECT a.id AS assignment_id, a.title, a.subject, a.created_at, a.due_at,
           s.q_no, s.tag, s.score, s.max
    FROM scores s JOIN assignments a ON a.id = s.assignment_id
    WHERE s.student_id = ? AND s.source = 'teacher'
    ORDER BY a.id, CAST(s.q_no AS INTEGER)`).all(studentId);

  const perAsg = new Map();
  for (const r of rows) {
    if (!perAsg.has(r.assignment_id)) {
      perAsg.set(r.assignment_id, {
        assignment_id: r.assignment_id, title: r.title, subject: r.subject,
        date: r.due_at || r.created_at, perTag: new Map(), score: 0, max: 0
      });
    }
    const g = perAsg.get(r.assignment_id);
    const t = g.perTag.get(r.tag) || { s: 0, m: 0 };
    t.s += r.score || 0; t.m += r.max || 0;
    g.perTag.set(r.tag, t);
    g.score += r.score || 0; g.max += r.max || 0;
  }

  const tagMap = new Map();
  for (const g of perAsg.values()) {
    for (const [tag, t] of g.perTag) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push({
        assignment_id: g.assignment_id, title: g.title, date: g.date,
        score: Math.round(t.s * 2) / 2, max: t.m, rate: t.m ? r1((t.s / t.m) * 100) : null
      });
    }
  }

  const tags = [...tagMap.entries()].map(([tag, points]) => {
    const rates = points.map((p) => p.rate).filter((v) => v !== null);
    const avg = rates.length ? r1(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
    const last = rates.length ? rates[rates.length - 1] : null;
    const prev = rates.length > 1 ? rates[rates.length - 2] : null;
    return {
      tag, points, avg, last, prev,
      delta: last !== null && prev !== null ? r1(last - prev) : null,
      n: rates.length
    };
  }).sort((a, b) => (a.avg ?? 999) - (b.avg ?? 999));

  const subs = [...perAsg.values()].map((g) => ({
    assignment_id: g.assignment_id, title: g.title, subject: g.subject, date: g.date,
    score: Math.round(g.score * 2) / 2, max: g.max,
    rate: g.max ? r1((g.score / g.max) * 100) : null
  })).sort((a, b) => a.assignment_id - b.assignment_id);

  const all = subs.map((s) => s.rate).filter((v) => v !== null);
  return {
    tags,
    assignments: subs,
    overall: {
      n: all.length,
      avg: all.length ? r1(all.reduce((a, b) => a + b, 0) / all.length) : null,
      first: all.length ? all[0] : null,
      last: all.length ? all[all.length - 1] : null,
      delta: all.length > 1 ? r1(all[all.length - 1] - all[0]) : null
    },
    weak: tags.filter((t) => t.avg !== null && t.avg < 60).map((t) => t.tag),
    enoughData: all.length >= 3   // 少於 3 次不要談「趨勢」
  };
}

// 從扣分記錄整理出「可以拿去生成練習」的素材
function collectWeakness(db, studentId, tag) {
  const rows = db.prepare(`
    SELECT s.q_no, s.score, s.max, s.assignment_id, s.submission_id,
           a.title, a.subject, a.questions_json, a.level,
           sub.ai_json, ans.answer_text, ans.transcript, ans.corrected_text
    FROM scores s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN submissions sub ON sub.id = s.submission_id
    LEFT JOIN answers ans ON ans.submission_id = s.submission_id AND ans.q_no = s.q_no
    WHERE s.student_id = ? AND s.source = 'teacher' AND s.score < s.max AND s.tag = ?
    ORDER BY a.id DESC LIMIT 4`).all(studentId, tag);
  if (!rows.length) return null;

  const weakPoints = [];
  const sourceQuestions = [];
  let studentAnswer = '';
  let subject = '';
  let level = '';
  for (const r of rows) {
    subject = subject || r.subject || '';
    level = level || r.level || '';
    const qs = JSON.parse(r.questions_json).find((q) => String(q.no) === String(r.q_no));
    if (!qs) continue;
    sourceQuestions.push({ prompt: qs.prompt });
    let missed = [];
    if (r.ai_json) {
      const aiQ = (JSON.parse(r.ai_json).questions || []).find((x) => String(x.no) === String(r.q_no));
      if (aiQ?.points) missed = aiQ.points.filter((p) => p.awarded < p.max)
        .map((p) => ({ desc: p.desc, max: p.max, awarded: p.awarded }));
    }
    if (!missed.length) missed = (qs.points || []).map((p) => ({ desc: p.desc, max: p.score, awarded: 0 }));
    weakPoints.push(...missed);
    if (!studentAnswer) studentAnswer = r.corrected_text || r.transcript || r.answer_text || '';
  }
  // 去重（同一評分點可能出現兩次）
  const seen = new Set();
  const uniq = weakPoints.filter((p) => {
    const k = p.desc;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { weakPoints: uniq, sourceQuestions, studentAnswer, subject, level };
}

// ---------------------------------------------------------------- 主分发
export async function handleApi(ctx0) {
  const { req, res, url, db, cfg } = ctx0;
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  const cookies = parseCookies(req.headers.cookie);
  const user = getSession(db, cookies.sid);

  const need = () => {
    if (!user) throw new HttpError(401, '請先登入');
    return user;
  };
  const needTeacher = () => {
    const u = need();
    if (u.role !== 'teacher') throw new HttpError(403, '只有老師可以使用這個功能');
    return u;
  };
  const body = () => readBody(req);

  try {
    // ---- 健康检查 / 当前身份 ----
    if (seg[0] === 'health') {
      return json(res, 200, { ok: true, aiMode: cfg.ai.effectiveMode, model: cfg.ai.modelLabel, time: nowIso() });
    }

    if (seg[0] === 'me') {
      return json(res, 200, {
        user: publicUser(user),
        aiMode: cfg.ai.effectiveMode,
        model: cfg.ai.modelLabel,
        vision: Boolean(cfg.ai.visionModel)
      });
    }

    // ---- 登入 / 登出 ----
    if (seg[0] === 'login' && method === 'POST') {
      const b = await body();
      const loginId = str(b.login_id, 60);
      const row = db.prepare('SELECT * FROM users WHERE login_id = ? AND active = 1').get(loginId);
      if (!row || !verifyPassword(b.password, row.password_hash)) {
        throw new HttpError(401, '帳號或密碼不正確');
      }
      const token = createSession(db, row.id);
      audit(db, row.id, 'login', `user:${row.id}`);
      res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
      return json(res, 200, { user: publicUser(row) });
    }

    if (seg[0] === 'logout' && method === 'POST') {
      destroySession(db, cookies.sid);
      res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    // ---- 学生注册：只用学生证号 + 姓名 + 班别 + 密码，且必须在老师导入的名单内 ----
    if (seg[0] === 'register' && method === 'POST') {
      const b = await body();
      const studentNo = str(b.student_no, 40);
      const name = str(b.name, 40);
      const className = str(b.class_name, 20).toUpperCase();
      const classNo = str(b.class_no, 10);
      const password = String(b.password ?? '');
      if (!studentNo || !name || !className) throw new HttpError(400, '請填寫學生證號碼、班別和姓名');
      if (password.length < 4) throw new HttpError(400, '密碼最少 4 個字元');
      if (className.includes(' ') || className.length > 10) throw new HttpError(400, '班別格式不正確，例如 5B');

      const r = db.prepare('SELECT * FROM roster WHERE student_no = ?').get(studentNo);
      if (!r) throw new HttpError(400, '學生證號碼不在名單內，請向老師確認');
      if (r.class_name.toUpperCase() !== className) throw new HttpError(400, '班別與名單不符，請向老師確認');
      if (r.name !== name) throw new HttpError(400, '姓名與名單不符，請向老師確認');
      if (classNo && r.class_no !== classNo) throw new HttpError(400, '學號與名單不符，請向老師確認');
      if (r.claimed_by) throw new HttpError(409, '這個學生證號碼已註冊，請直接登入；忘記密碼請老師重設');

      const id = tx(db, () => {
        const info = db.prepare(`INSERT INTO users (role, login_id, name, class_name, class_no, student_no, password_hash, roster_id, created_at)
                                 VALUES ('student',?,?,?,?,?,?,?,?)`)
          .run(studentNo, r.name, r.class_name, r.class_no, studentNo, hashPassword(password), r.id, nowIso());
        db.prepare('UPDATE roster SET claimed_by = ? WHERE id = ?').run(info.lastInsertRowid, r.id);
        audit(db, info.lastInsertRowid, 'register', `student:${studentNo}`);
        return info.lastInsertRowid;
      });
      const token = createSession(db, Number(id));
      res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
      return json(res, 200, {
        user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)))
      });
    }

    // 注册前的「查名」：输入学生证号就回显名单上的姓名班别，减少打错字
    if (seg[0] === 'lookup' && method === 'POST') {
      const b = await body();
      const r = db.prepare('SELECT class_name, class_no, claimed_by FROM roster WHERE student_no = ?').get(str(b.student_no, 40));
      if (!r) throw new HttpError(404, '名單內找不到這個學生證號碼');
      return json(res, 200, { class_name: r.class_name, class_no: r.class_no, claimed: Boolean(r.claimed_by) });
    }

    if (seg[0] === 'change-password' && method === 'POST') {
      const u = need();
      const b = await body();
      if (!verifyPassword(b.old_password, u.password_hash)) throw new HttpError(400, '舊密碼不正確');
      if (String(b.new_password ?? '').length < 4) throw new HttpError(400, '新密碼最少 4 個字元');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.new_password), u.id);
      audit(db, u.id, 'change-password', `user:${u.id}`);
      return json(res, 200, { ok: true });
    }

    // ---- 文件（相片）下載：老師可看全部，學生只看自己的 ----
    if (seg[0] === 'files' && method === 'GET' && seg[1]) {
      const u = need();
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(seg[1]));
      if (!f) throw new HttpError(404, '找不到檔案');
      const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(f.submission_id);
      if (!sub) throw new HttpError(404, '找不到檔案');
      if (u.role !== 'teacher' && sub.student_id !== u.id) throw new HttpError(403, '不能查看別人的功課');
      const abs = fileAbsPath(cfg, f);
      if (!fs.existsSync(abs)) throw new HttpError(404, '檔案已不存在');
      const buf = fs.readFileSync(abs);
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/octet-stream',
        'Content-Length': buf.length,
        'Content-Disposition': `inline; filename="${encodeURIComponent(f.filename)}"`,
        'Cache-Control': 'private, max-age=600'
      });
      return res.end(buf);
    }

    // ---- 作業 ----
    if (seg[0] === 'assignments' && seg.length === 1 && method === 'GET') {
      const u = need();
      let rows;
      if (u.role === 'teacher') {
        rows = db.prepare('SELECT * FROM assignments ORDER BY id DESC').all();
      } else {
        // 學生：只看到「派給自己班」或「沒有指定班別」的作業
        rows = db.prepare("SELECT * FROM assignments WHERE status != 'draft' ORDER BY id DESC").all()
          .filter((row) => visibleToClass(db, row.id, u.class_name));
      }
      const out = rows.map((row) => {
        row.questions = JSON.parse(row.questions_json);
        const s = assignmentSummary(row, db);
        if (u.role === 'teacher') {
          // 分母用「名單人數」而不是「已註冊人數」：班上 12 人只註冊了 2 個，
          // 顯示「提交 0/2」會讓老師誤以為全班只有 2 人
          s.class_size = classSizeOf(db, s.class_names);
          const stats = db.prepare(`SELECT
              COUNT(*) AS submitted,
              SUM(CASE WHEN status IN ('returned','questioned') THEN 1 ELSE 0 END) AS returned,
              SUM(CASE WHEN teacher_total IS NOT NULL THEN 1 ELSE 0 END) AS graded
            FROM submissions WHERE assignment_id = ?`).get(row.id);
          s.submitted = stats.submitted || 0;
          s.graded = stats.graded || 0;
          s.returned = stats.returned || 0;
          s.registered = db.prepare("SELECT COUNT(*) n FROM users WHERE role='student'").get().n;
        } else {
          const sub = db.prepare('SELECT id, status, submitted_at, teacher_total FROM submissions WHERE assignment_id = ? AND student_id = ?').get(row.id, u.id);
          s.my = sub ? { id: sub.id, status: sub.status, submitted_at: sub.submitted_at, teacher_total: sub.teacher_total } : null;
          s.late = Boolean(row.due_at && Date.now() > new Date(row.due_at).getTime());
        }
        return s;
      });
      return json(res, 200, { assignments: out });
    }

    // ---- 學生提示：新作業 / 快到截止 ----
    if (seg[0] === 'notices' && method === 'GET') {
      const u = need();
      if (u.role !== 'student') return json(res, 200, { new: [], due_soon: [], overdue: [] });
      const rows = db.prepare("SELECT * FROM assignments WHERE status = 'open' ORDER BY id DESC").all()
        .filter((a) => visibleToClass(db, a.id, u.class_name));
      const submitted = new Set(db.prepare('SELECT assignment_id FROM submissions WHERE student_id = ?').all(u.id).map((r) => r.assignment_id));
      const seen = new Set(db.prepare('SELECT assignment_id FROM assignment_views WHERE student_id = ?').all(u.id).map((r) => r.assignment_id));
      const now = Date.now();
      const out = { new: [], due_soon: [], overdue: [] };
      for (const a of rows) {
        if (submitted.has(a.id)) continue;
        const brief = { id: a.id, title: a.title, subject: a.subject, due_at: a.due_at };
        if (!seen.has(a.id)) out.new.push(brief);
        if (a.due_at) {
          const h = (new Date(a.due_at).getTime() - now) / 3600000;
          if (h <= 0) out.overdue.push({ ...brief, hours: Math.max(1, Math.round(-h)) });
          else if (h <= 24) out.due_soon.push({ ...brief, hours: Math.round(h * 10) / 10 });
        }
      }
      return json(res, 200, out);
    }

    // 學生按「知道了」之後記下來，之後不再彈同一份
    if (seg[0] === 'notices' && seg[1] === 'ack' && method === 'POST') {
      const u = need();
      if (u.role !== 'student') throw new HttpError(403, '只有學生');
      const b = await body();
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
      const ins = db.prepare('INSERT OR IGNORE INTO assignment_views (student_id, assignment_id, seen_at) VALUES (?,?,?)');
      const now = nowIso();
      for (const id of ids) ins.run(u.id, id, now);
      return json(res, 200, { ok: true, acked: ids.length });
    }

    // ---- 班別清單（老師建作業、篩選時用） ----
    if (seg[0] === 'classes' && method === 'GET') {
      needTeacher();
      const rows = db.prepare(`SELECT class_name, COUNT(*) n FROM roster GROUP BY class_name ORDER BY class_name`).all();
      const reg = new Map(db.prepare(`SELECT class_name, COUNT(*) n FROM users WHERE role='student' GROUP BY class_name`).all()
        .map((r) => [r.class_name, r.n]));
      return json(res, 200, {
        classes: rows.map((r) => ({ class_name: r.class_name, roster: r.n, registered: reg.get(r.class_name) || 0 }))
      });
    }

    if (seg[0] === 'assignments' && method === 'POST' && seg.length === 1) {
      const u = needTeacher();
      const b = await body();
      const { questions, total } = parseQuestions(b.questions);
      const title = str(b.title, 120);
      if (!title) throw new HttpError(400, '請填寫作業名稱');
      const info = db.prepare(`INSERT INTO assignments (title, subject, class_name, description, questions_json, total_score, due_at, status, allow_late, created_by, created_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(title, str(b.subject, 40) || '小學科學', str(b.class_name, 20).toUpperCase() || null,
          str(b.description, 2000) || null, JSON.stringify(questions), total,
          b.due_at ? new Date(b.due_at).toISOString() : null,
          ['draft', 'open', 'closed'].includes(b.status) ? b.status : 'open',
          b.allow_late === false ? 0 : 1, u.id, nowIso());
      // class_names: ['4A','4B','4C'] 或舊式 class_name: '4A'
      const classNames = setClasses(db, Number(info.lastInsertRowid), b.class_names, str(b.class_name, 20));
      if (classNames.length) {
        db.prepare('UPDATE assignments SET class_name = ? WHERE id = ?').run(classNames[0], Number(info.lastInsertRowid));
      }
      audit(db, u.id, 'assignment-create', `assignment:${info.lastInsertRowid}`, { title, classNames });
      return json(res, 200, { id: Number(info.lastInsertRowid), class_names: classNames });
    }

    if (seg[0] === 'assignments' && seg[1] && seg.length === 2) {
      const a = getAssignment(db, seg[1]);
      const u = need();
      if (method === 'GET') {
        if (u.role !== 'teacher') {
          if (a.status === 'draft') throw new HttpError(404, '找不到這份作業');
          if (!visibleToClass(db, a.id, u.class_name)) throw new HttpError(403, '這份作業不屬於你的班別');
          // 學生打開過就當作「已看過」，下次登入不會再彈新作業提示
          db.prepare('INSERT OR IGNORE INTO assignment_views (student_id, assignment_id, seen_at) VALUES (?,?,?)')
            .run(u.id, a.id, nowIso());
        }
        const sub = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, u.id);
        return json(res, 200, {
          assignment: { ...assignmentSummary(a, db), questions: a.questions },
          my: sub ? serializeSubmission(db, sub, { forTeacher: u.role === 'teacher' }) : null
        });
      }
      if (method === 'PATCH') {
        const t = needTeacher();
        const b = await body();
        let questions = a.questions, total = a.total_score;
        if (b.questions) ({ questions, total } = parseQuestions(b.questions));
        db.prepare(`UPDATE assignments SET title=?, description=?, due_at=?, status=?, allow_late=?, questions_json=?, total_score=?, class_name=? WHERE id=?`)
          .run(str(b.title, 120) || a.title, b.description !== undefined ? str(b.description, 2000) : a.description,
            b.due_at !== undefined ? (b.due_at ? new Date(b.due_at).toISOString() : null) : a.due_at,
            ['draft', 'open', 'closed'].includes(b.status) ? b.status : a.status,
            b.allow_late === undefined ? a.allow_late : (b.allow_late ? 1 : 0),
            JSON.stringify(questions), total,
            b.class_name !== undefined ? (str(b.class_name, 20).toUpperCase() || null) : a.class_name, a.id);
        if (b.class_names !== undefined || b.class_name !== undefined) {
          const cls = setClasses(db, a.id, b.class_names, str(b.class_name, 20));
          db.prepare('UPDATE assignments SET class_name = ? WHERE id = ?').run(cls[0] || null, a.id);
        }
        audit(db, t.id, 'assignment-update', `assignment:${a.id}`);
        return json(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        const t = needTeacher();
        const n = db.prepare('SELECT COUNT(*) n FROM submissions WHERE assignment_id = ?').get(a.id).n;
        if (n > 0) throw new HttpError(400, '已有學生提交，不能刪除；請改為「關閉」');
        db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
        audit(db, t.id, 'assignment-delete', `assignment:${a.id}`);
        return json(res, 200, { ok: true });
      }
    }

    // 老师：某份作业的全部提交
    if (seg[0] === 'assignments' && seg[2] === 'submissions' && method === 'GET') {
      needTeacher();
      const a = getAssignment(db, seg[1]);
      const rows = db.prepare(`SELECT s.*, u.name, u.class_no, u.student_no FROM submissions s
                               JOIN users u ON u.id = s.student_id
                               WHERE s.assignment_id = ? ORDER BY u.class_no`).all(a.id);
      const out = rows.map((r) => ({
        id: r.id, student: { id: r.student_id, name: r.name, class_no: r.class_no, student_no: r.student_no },
        status: r.status, submitted_at: r.submitted_at, late: Boolean(r.late),
        ai_total: r.ai_total, teacher_total: r.teacher_total,
        has_ai: Boolean(r.ai_json), graded: r.teacher_total !== null,
        flags: r.ai_json ? (JSON.parse(r.ai_json).flags || []).length : 0
      }));
      const classSize = classSizeOf(db, classesOf(db, a.id));
      return json(res, 200, {
        assignment: { ...assignmentSummary(a, db), class_size: classSize },
        questions: a.questions, submissions: out
      });
    }

    // 学生：提交作业
    if (seg[0] === 'assignments' && seg[2] === 'submit' && method === 'POST') {
      const u = need();
      if (u.role !== 'student') throw new HttpError(403, '只有學生可以提交作業');
      const a = getAssignment(db, seg[1]);
      if (a.status !== 'open') throw new HttpError(400, '這份作業已關閉，不能再提交');
      if (!visibleToClass(db, a.id, u.class_name)) throw new HttpError(403, '這份作業不屬於你的班別');
      const b = await body();
      const incoming = Array.isArray(b.answers) ? b.answers : [];
      const late = a.due_at && Date.now() > new Date(a.due_at).getTime() ? 1 : 0;
      if (late && !a.allow_late) throw new HttpError(400, '已過截止時間，不接受補交');

      const existing = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, u.id);
      if (existing && existing.status === 'returned') throw new HttpError(400, '這份作業已發還，如需重做請聯絡老師開啟');

      const totalImages = incoming.reduce((s, x) => s + (Array.isArray(x.images) ? x.images.length : 0), 0);
      if (totalImages > 12) throw new HttpError(400, '相片總數過多（上限 12 張）');

      const submissionId = tx(db, () => {
        let sid;
        if (existing) {
          sid = existing.id;
          // 重新提交：清掉旧的答案与图片，状态回到 submitted
          for (const f of filesBySubmission(db, sid)) {
            try { fs.unlinkSync(fileAbsPath(cfg, f)); } catch { /* ignore */ }
          }
          db.prepare('DELETE FROM files WHERE submission_id = ?').run(sid);
          db.prepare('DELETE FROM answers WHERE submission_id = ?').run(sid);
          db.prepare(`UPDATE submissions SET status='submitted', submitted_at=?, late=?, ai_json=NULL, ai_total=NULL,
                      ai_confidence=NULL, ai_model=NULL, ai_at=NULL, teacher_scores_json=NULL, teacher_total=NULL,
                      teacher_comment=NULL, graded_by=NULL, graded_at=NULL, returned_at=NULL WHERE id=?`)
            .run(nowIso(), late, sid);
        } else {
          const info = db.prepare(`INSERT INTO submissions (assignment_id, student_id, status, submitted_at, late)
                                   VALUES (?,?,'submitted',?,?)`).run(a.id, u.id, nowIso(), late);
          sid = Number(info.lastInsertRowid);
        }
        for (const q of a.questions) {
          const ans = incoming.find((x) => String(x.no) === String(q.no));
          const text = str(ans?.text, 8000);
          const mode = ans?.mode === 'photo' ? 'photo' : 'typed';
          db.prepare('INSERT INTO answers (submission_id, q_no, answer_text, mode) VALUES (?,?,?,?)')
            .run(sid, String(q.no), text || null, mode);
          const imgs = Array.isArray(ans?.images) ? ans.images.slice(0, 4) : [];
          for (const d of imgs) saveDataUrlImage(db, cfg, sid, String(q.no), d);
        }
        audit(db, u.id, existing ? 'resubmit' : 'submit', `submission:${sid}`, { assignment: a.id, late });
        return sid;
      });

      // 作文採「拍照」通道：提交後立即轉寫，老師打開時已見文字。
      // 只轉寫 essay 題（其他題由模型直接看圖評分，不需要轉寫）。
      const transcribed = [];
      for (const q of a.questions) {
        if (q.type !== 'essay') continue;
        const ans = incoming.find((x) => String(x.no) === String(q.no));
        if (ans?.mode !== 'photo') continue;
        const f = db.prepare('SELECT * FROM files WHERE submission_id = ? AND q_no = ? ORDER BY id LIMIT 1').get(submissionId, String(q.no));
        if (!f || f.mime === 'application/pdf') continue;
        const r = await transcribeImage(getClient(cfg), {
          absPath: fileAbsPath(cfg, f), mime: f.mime, subjectHint: a.subject
        });
        logAiCall(db, { kind: 'transcribe', model: r.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `submission:${submissionId}`, error: r.error });
        if (r.ok) {
          db.prepare(`UPDATE answers SET transcript=?, transcript_confidence=?, transcript_notes=?,
                      transcript_uncertain=?, transcript_at=? WHERE submission_id=? AND q_no=?`)
            .run(r.transcript, r.confidence, r.notes || null, JSON.stringify(r.uncertain || []), nowIso(), submissionId, String(q.no));
          transcribed.push(q.no);
        } else {
          audit(db, u.id, 'transcribe-error', `submission:${submissionId}`, { q_no: q.no, error: r.error });
        }
      }

      const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
      return json(res, 200, {
        submission: serializeSubmission(db, sub, { forTeacher: false }),
        transcribed
      });
    }

    // 学生：看自己的提交（含已发还的分数与评语）
    if (seg[0] === 'assignments' && seg[2] === 'my' && method === 'GET') {
      const u = need();
      const a = getAssignment(db, seg[1]);
      const sub = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, u.id);
      return json(res, 200, {
        assignment: { ...assignmentSummary(a), questions: a.questions },
        submission: sub ? serializeSubmission(db, sub, { forTeacher: u.role === 'teacher' }) : null
      });
    }

    // ---- 单份提交：详情 / 触发 AI / 老师评分 / 重开 / 学生提问 ----
    if (seg[0] === 'submissions' && seg[1]) {
      const id = Number(seg[1]);
      const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
      if (!sub) throw new HttpError(404, '找不到這份提交');
      const u = need();
      const owner = sub.student_id === u.id;
      const teacher = u.role === 'teacher';
      if (!teacher && !owner) throw new HttpError(403, '不能查看別人的功課');

      if (seg.length === 2 && method === 'GET') {
        return json(res, 200, { submission: serializeSubmission(db, sub, { forTeacher: teacher }) });
      }

      if (seg[2] === 'ai' && method === 'POST') {
        needTeacher();
        const a = getAssignment(db, sub.assignment_id);
        const answers = db.prepare('SELECT * FROM answers WHERE submission_id = ?').all(id).map((x) => ({
          q_no: x.q_no,
          answer_text: x.answer_text,
          final_text: x.corrected_text || x.transcript || x.answer_text || '',
          transcript_note: x.corrected_text ? '老師已修正轉寫稿' : (x.transcript ? '此為手寫轉寫稿' : '')
        }));
        const files = filesBySubmission(db, id).map((f) => ({ ...f, absPath: fileAbsPath(cfg, f) }));
        const filesByQ = new Map();
        for (const f of files) {
          const k = String(f.q_no || '');
          if (!filesByQ.has(k)) filesByQ.set(k, []);
          filesByQ.get(k).push(f);
        }
        const student = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.student_id);
        const r = await gradeSubmission(getClient(cfg), {
          assignment: a, studentName: student?.name || '', className: student?.class_name || '',
          answers, filesByQ, questions: a.questions
        });
        logAiCall(db, { kind: 'grade', model: r.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `submission:${id}`, error: r.error });
        if (!r.ok) {
          audit(db, u.id, 'ai-error', `submission:${id}`, { error: r.error });
          return json(res, 502, { error: r.error, raw: r.raw || null });
        }
        db.prepare(`UPDATE submissions SET ai_json=?, ai_total=?, ai_confidence=?, ai_model=?, ai_at=?, ai_usage=?,
                    status = CASE WHEN status='submitted' THEN 'ai_graded' ELSE status END WHERE id=?`)
          .run(JSON.stringify(r.result), r.result.total, r.result.confidence,
            r.mode === 'mock' ? '模擬模式（未配置 API Key）' : (r.model || cfg.ai.model),
            nowIso(), JSON.stringify(r.usage || null), id);
        audit(db, u.id, 'ai-grade', `submission:${id}`, { mode: r.mode, total: r.result.total, usage: r.usage });
        const fresh = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
        return json(res, 200, {
          submission: serializeSubmission(db, fresh, { forTeacher: true }),
          usage: r.usage || null, mode: r.mode, ms: r.ms
        });
      }

      if (seg[2] === 'grade' && method === 'POST') {
        const t = needTeacher();
        const b = await body();
        const a = getAssignment(db, sub.assignment_id);
        const incoming = b.scores && typeof b.scores === 'object' ? b.scores : {};
        const questions = a.questions.map((q) => {
          const s = incoming[String(q.no)] || {};
          const score = Math.min(q.max, Math.max(0, Number(s.score) || 0));
          return { no: q.no, tag: q.tag, max: q.max, score: Math.round(score * 2) / 2, comment: str(s.comment, 300) };
        });
        const total = Math.round(questions.reduce((s, q) => s + q.score, 0) * 2) / 2;
        const doReturn = Boolean(b.return);
        // 只交分數、不交評語時，不要清掉舊評語（避免「改一題分數，評語消失」）
        const comment = b.comment === undefined ? sub.teacher_comment : (str(b.comment, 2000) || null);
        const notes = b.notes === undefined ? sub.teacher_notes : (str(b.notes, 2000) || null);
        db.prepare(`UPDATE submissions SET teacher_scores_json=?, teacher_total=?, teacher_comment=?, teacher_notes=?,
                    graded_by=?, graded_at=?, status=?, returned_at=? WHERE id=?`)
          .run(JSON.stringify({ questions, total }), total, comment, notes,
            t.id, nowIso(), doReturn ? 'returned' : (sub.status === 'submitted' ? 'ai_graded' : sub.status),
            doReturn ? nowIso() : sub.returned_at, id);
        audit(db, t.id, doReturn ? 'return' : 'grade', `submission:${id}`, { total, ai_total: sub.ai_total });

        // 同步寫入 scores 明細（學情分析與錯題精煉都靠它）
        tx(db, () => {
          db.prepare("DELETE FROM scores WHERE submission_id = ? AND source = 'teacher'").run(id);
          const ins = db.prepare(`INSERT INTO scores (submission_id, assignment_id, student_id, q_no, tag, score, max, source, created_at)
                                  VALUES (?,?,?,?,?,?,?, 'teacher', ?)`);
          const now = nowIso();
          for (const q of questions) ins.run(id, a.id, sub.student_id, String(q.no), q.tag || '未分類', q.score, q.max, now);
        });

        return json(res, 200, { submission: serializeSubmission(db, db.prepare('SELECT * FROM submissions WHERE id = ?').get(id), { forTeacher: true }) });
      }

      if (seg[2] === 'reopen' && method === 'POST') {
        const t = needTeacher();
        db.prepare(`UPDATE submissions SET status='ai_graded', returned_at=NULL WHERE id=?`).run(id);
        audit(db, t.id, 'reopen', `submission:${id}`);
        return json(res, 200, { ok: true });
      }

      if (seg[2] === 'question' && method === 'POST') {
        if (!owner) throw new HttpError(403, '只有本人可以提問');
        if (!['returned', 'questioned'].includes(sub.status)) throw new HttpError(400, '只有已發還的作業可以提問');
        const b = await body();
        const text = str(b.text, 1000);
        if (!text) throw new HttpError(400, '請填寫你的問題');
        db.prepare("UPDATE submissions SET status='questioned', question_text=?, question_at=? WHERE id=?").run(text, nowIso(), id);
        audit(db, u.id, 'question', `submission:${id}`);
        return json(res, 200, { ok: true });
      }

      if (seg[2] === 'reply' && method === 'POST') {
        const t = needTeacher();
        const b = await body();
        const reply = str(b.reply, 1000);
        const prev = sub.teacher_notes || '';
        db.prepare("UPDATE submissions SET teacher_notes=?, status='returned' WHERE id=?")
          .run((prev ? prev + '\n' : '') + `[老師回覆 ${new Date().toLocaleString('zh-HK')}] ${reply}`, id);
        audit(db, t.id, 'reply', `submission:${id}`);
        return json(res, 200, { ok: true });
      }

      // 老師：重新轉寫某一題（學生字太亂、要換更好的相片時）
      if (seg[2] === 'transcribe' && method === 'POST') {
        const t = needTeacher();
        const b = await body();
        const qNo = str(b.q_no, 10);
        const f = db.prepare('SELECT * FROM files WHERE submission_id = ? AND q_no = ? ORDER BY id LIMIT 1').get(id, qNo);
        if (!f) throw new HttpError(400, '這一題沒有相片，無法轉寫');
        if (f.mime === 'application/pdf') throw new HttpError(400, 'PDF 不支援轉寫');
        const a = getAssignment(db, sub.assignment_id);
        const r = await transcribeImage(getClient(cfg), { absPath: fileAbsPath(cfg, f), mime: f.mime, subjectHint: a.subject });
        logAiCall(db, { kind: 'transcribe', model: r.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `submission:${id}`, error: r.error });
        if (!r.ok) return json(res, 502, { error: r.error });
        db.prepare(`UPDATE answers SET transcript=?, transcript_confidence=?, transcript_notes=?,
                    transcript_uncertain=?, transcript_at=? WHERE submission_id=? AND q_no=?`)
          .run(r.transcript, r.confidence, r.notes || null, JSON.stringify(r.uncertain || []), nowIso(), id, qNo);
        audit(db, t.id, 'transcribe', `submission:${id}`, { q_no: qNo, confidence: r.confidence });
        return json(res, 200, { ok: true, transcript: r.transcript, confidence: r.confidence, notes: r.notes, uncertain: r.uncertain, ms: r.ms });
      }

      // 老師：修正轉寫稿（修正後才用來評分）
      if (seg[2] === 'correct' && method === 'POST') {
        const t = needTeacher();
        const b = await body();
        const qNo = str(b.q_no, 10);
        const text = String(b.text ?? '').slice(0, 8000);
        const row = db.prepare('SELECT id FROM answers WHERE submission_id = ? AND q_no = ?').get(id, qNo);
        if (!row) throw new HttpError(404, '找不到這一題');
        db.prepare('UPDATE answers SET corrected_text=? WHERE id=?').run(text.trim() ? text : null, row.id);
        audit(db, t.id, 'correct-transcript', `submission:${id}`, { q_no: qNo, len: text.length });
        return json(res, 200, { ok: true });
      }

      // 老師：用分數與依據草擬整體評語
      if (seg[2] === 'comment-draft' && method === 'POST') {
        const t = needTeacher();
        const b = await body();
        const a = getAssignment(db, sub.assignment_id);
        const student = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.student_id);
        const scores = b.scores && typeof b.scores === 'object' ? b.scores : {};
        const graded = a.questions.map((q) => {
          const sc = scores[String(q.no)] || {};
          const sug = sub.ai_json ? (JSON.parse(sub.ai_json).questions || []).find((x) => String(x.no) === String(q.no)) : null;
          return {
            no: q.no, max: q.max,
            score: Math.min(q.max, Math.max(0, Number(sc.score) || 0)),
            comment: str(sc.comment, 200) || sug?.comment || '',
            points: sug?.points || (q.points || []).map((p) => ({ desc: p.desc, max: p.score, awarded: 0 }))
          };
        });
        const total = Math.round(graded.reduce((s, q) => s + q.score, 0) * 2) / 2;
        const r = await draftComment(getClient(cfg), {
          assignment: a, studentName: student?.name || '', gradedQuestions: graded,
          scores: { total, max: a.total_score }
        });
        logAiCall(db, { kind: 'comment', model: cfg.ai.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `submission:${id}`, error: r.error });
        if (!r.ok) return json(res, 502, { error: r.error });
        return json(res, 200, { comment: r.comment, mode: r.mock ? 'mock' : 'live', ms: r.ms });
      }

      // 學生：問「為甚麼這題是這個分數」，只按老師評語與評分點回答，不改分
      if (seg[2] === 'ask' && method === 'POST') {
        if (!owner) throw new HttpError(403, '只有本人可以問');
        if (!['returned', 'questioned'].includes(sub.status)) throw new HttpError(400, '老師發還之後才可以問');
        const b = await body();
        const qNo = str(b.q_no, 10);
        const a = getAssignment(db, sub.assignment_id);
        const q = a.questions.find((x) => String(x.no) === qNo);
        if (!q) throw new HttpError(404, '找不到這一題');
        const ans = db.prepare('SELECT * FROM answers WHERE submission_id = ? AND q_no = ?').get(id, qNo);
        const ts = sub.teacher_scores_json ? JSON.parse(sub.teacher_scores_json) : null;
        const g = ts?.questions?.find((x) => String(x.no) === qNo);
        const r = await askAboutFeedback(getClient(cfg), {
          assignment: a, question: q,
          studentAnswer: ans?.corrected_text || ans?.transcript || ans?.answer_text || '',
          teacherComment: g?.comment || sub.teacher_comment || '',
          score: g?.score ?? 0, max: q.max, points: q.points
        });
        logAiCall(db, { kind: 'ask', model: cfg.ai.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `submission:${id}`, error: r.error });
        if (!r.ok) return json(res, 502, { error: r.error });
        audit(db, u.id, 'ask-ai', `submission:${id}`, { q_no: qNo });
        return json(res, 200, { answer: r.answer, ms: r.ms });
      }
    }

    // ---- AI 輔助：出題助手 ----
    if (seg[0] === 'ai' && seg[1] === 'suggest' && method === 'POST') {
      const t = needTeacher();
      const b = await body();
      const subject = str(b.subject, 40) || '小學英文';
      const level = str(b.level, 20) || '小五';
      const topic = str(b.topic, 120);
      if (!topic) throw new HttpError(400, '請輸入課題');
      const r = await suggestAssignment(getClient(cfg), {
        subject, level, topic, notes: str(b.notes, 500), count: Math.min(6, Math.max(1, Number(b.count) || 4))
      });
      logAiCall(db, { kind: 'suggest', model: cfg.ai.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `user:${t.id}`, error: r.error });
      if (!r.ok) return json(res, 502, { error: r.error });
      // 模型給的題目仍然要過一次驗證（id、分數、類型），不合格的寧願報錯也不要放進資料庫
      let validated;
      try {
        validated = parseQuestions(r.data.questions);
      } catch (e) {
        return json(res, 502, { error: '出題結果格式不正確，請重試：' + e.message, raw: r.data });
      }
      audit(db, t.id, 'ai-suggest', null, { topic, n: validated.questions.length });
      return json(res, 200, {
        title: str(r.data.title, 120) || topic,
        description: str(r.data.description, 500) || '',
        questions: validated.questions, total: validated.total, ms: r.ms,
        subject, level
      });
    }

    // ---- AI 用量（成本與健康度） ----
    if (seg[0] === 'ai' && seg[1] === 'usage' && method === 'GET') {
      needTeacher();
      const byKind = db.prepare(`SELECT kind, COUNT(*) n, SUM(ok) ok,
          SUM(prompt_tokens) p, SUM(completion_tokens) c, SUM(reasoning_tokens) r,
          CAST(AVG(ms) AS INTEGER) avg_ms
        FROM ai_calls GROUP BY kind ORDER BY n DESC`).all();
      const today = db.prepare(`SELECT COUNT(*) n, SUM(prompt_tokens + completion_tokens) tokens
        FROM ai_calls WHERE date(created_at) = date('now')`).get();
      const errors = db.prepare(`SELECT kind, error, created_at FROM ai_calls WHERE ok = 0 ORDER BY id DESC LIMIT 8`).all();
      return json(res, 200, { byKind, today, errors, mode: cfg.ai.effectiveMode, model: cfg.ai.modelLabel });
    }

    // ---- 學情：知識點趨勢（老師可看任何學生，學生只看自己） ----
    if (seg[0] === 'students' && seg[2] === 'progress' && method === 'GET') {
      const u = need();
      const sid = Number(seg[1]);
      if (u.role !== 'teacher' && u.id !== sid) throw new HttpError(403, '不能查看別人的學習記錄');
      const student = db.prepare('SELECT * FROM users WHERE id = ?').get(sid);
      if (!student) throw new HttpError(404, '找不到學生');
      return json(res, 200, { student: publicUser(student), ...buildProgress(db, sid) });
    }

    // ---- 錯題精煉 ----
    if (seg[0] === 'practice' && seg[1] === 'mistakes' && method === 'GET') {
      const u = need();
      if (u.role !== 'student') throw new HttpError(403, '只有學生可以使用');
      const progress = buildProgress(db, u.id);
      const rows = db.prepare(`
        SELECT s.q_no, s.tag, s.score, s.max, s.assignment_id, s.submission_id,
               a.title, a.questions_json, sub.ai_json
        FROM scores s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN submissions sub ON sub.id = s.submission_id
        WHERE s.student_id = ? AND s.source = 'teacher' AND s.score < s.max
        ORDER BY a.id DESC`).all(u.id);

      const byTag = new Map();
      for (const r of rows) {
        const qs = JSON.parse(r.questions_json).find((q) => String(q.no) === String(r.q_no));
        if (!qs) continue;
        let missed = [];
        if (r.ai_json) {
          const aiQ = (JSON.parse(r.ai_json).questions || []).find((x) => String(x.no) === String(r.q_no));
          if (aiQ?.points) missed = aiQ.points.filter((p) => p.awarded < p.max).map((p) => p.desc);
        }
        if (!missed.length) missed = (qs.points || []).map((p) => p.desc);
        if (!byTag.has(r.tag)) byTag.set(r.tag, { tag: r.tag, items: [], lost: 0 });
        const g = byTag.get(r.tag);
        g.items.push({
          assignment_id: r.assignment_id, title: r.title, q_no: r.q_no,
          prompt: qs.prompt, score: r.score, max: r.max, missed
        });
        g.lost += (r.max - r.score);
      }
      const tagStats = new Map(progress.tags.map((t) => [t.tag, t]));
      const out = [...byTag.values()].map((g) => ({
        ...g,
        avg: tagStats.get(g.tag)?.avg ?? null,
        lost: r1(g.lost),
        practiced: db.prepare('SELECT COUNT(*) n FROM practice_items WHERE student_id = ? AND tag = ?').get(u.id, g.tag).n
      })).sort((a, b) => b.lost - a.lost);
      return json(res, 200, { tags: out, progress });
    }

    if (seg[0] === 'practice' && seg[1] === 'generate' && method === 'POST') {
      const u = need();
      if (u.role !== 'student') throw new HttpError(403, '只有學生可以生成練習');
      const b = await body();
      const tag = str(b.tag, 60);
      if (!tag) throw new HttpError(400, '請指定知識點');
      const ctx = collectWeakness(db, u.id, tag);
      if (!ctx) throw new HttpError(400, '這個知識點沒有扣分記錄，不需要練習');
      const r = await generatePractice(getClient(cfg), {
        subject: ctx.subject, level: ctx.level, tag,
        weakPoints: ctx.weakPoints, sourceQuestions: ctx.sourceQuestions,
        studentAnswer: ctx.studentAnswer, count: Math.min(4, Math.max(1, Number(b.count) || 3))
      });
      logAiCall(db, { kind: 'practice-gen', model: cfg.ai.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `user:${u.id}`, error: r.error });
      if (!r.ok) return json(res, 502, { error: r.error });
      const batch = Date.now().toString(36);
      const ids = tx(db, () => {
        const ins = db.prepare(`INSERT INTO practice_items (student_id, tag, batch, source_assignment_id, source_q_no, prompt, expected_json, model_answer, created_at)
                                VALUES (?,?,?,?,?,?,?,?,?)`);
        const out = [];
        for (const it of r.items) {
          const info = ins.run(u.id, tag, batch, null, null, it.prompt,
            JSON.stringify(it.expected || []), it.model_answer || null, nowIso());
          out.push(Number(info.lastInsertRowid));
        }
        return out;
      });
      audit(db, u.id, 'practice-generate', `user:${u.id}`, { tag, n: ids.length });
      return json(res, 200, {
        batch, tag,
        items: ids.map((id, i) => ({
          id, tag, prompt: r.items[i].prompt, expected: r.items[i].expected,
          hint: r.items[i].hint, attempts: []
        })),
        ms: r.ms
      });
    }

    if (seg[0] === 'practice' && seg.length === 1 && method === 'GET') {
      const u = need();
      if (u.role !== 'student') throw new HttpError(403, '只有學生可以使用');
      const tag = url.searchParams.get('tag');
      const items = tag
        ? db.prepare('SELECT * FROM practice_items WHERE student_id = ? AND tag = ? ORDER BY id DESC LIMIT 40').all(u.id, tag)
        : db.prepare('SELECT * FROM practice_items WHERE student_id = ? ORDER BY id DESC LIMIT 40').all(u.id);
      const out = items.map((it) => ({
        id: it.id, tag: it.tag, prompt: it.prompt,
        expected: it.expected_json ? JSON.parse(it.expected_json) : [],
        hint: it.hint, created_at: it.created_at,
        attempts: db.prepare('SELECT answer, verdict, feedback, created_at FROM practice_attempts WHERE item_id = ? ORDER BY id DESC LIMIT 5').all(it.id)
      }));
      return json(res, 200, { items: out });
    }

    if (seg[0] === 'practice' && seg[2] === 'answer' && method === 'POST') {
      const u = need();
      if (u.role !== 'student') throw new HttpError(403, '只有學生可以作答練習');
      const item = db.prepare('SELECT * FROM practice_items WHERE id = ?').get(Number(seg[1]));
      if (!item || item.student_id !== u.id) throw new HttpError(404, '找不到這道練習');
      const b = await body();
      const answer = str(b.answer, 1000);
      if (!answer) throw new HttpError(400, '請輸入答案');
      const r = await judgePractice(getClient(cfg), {
        item: { prompt: item.prompt, expected: item.expected_json ? JSON.parse(item.expected_json) : [], model_answer: item.model_answer },
        answer
      });
      logAiCall(db, { kind: 'practice-check', model: cfg.ai.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `item:${item.id}`, error: r.error });
      if (!r.ok) return json(res, 502, { error: r.error });
      db.prepare('INSERT INTO practice_attempts (item_id, answer, verdict, feedback, created_at) VALUES (?,?,?,?,?)')
        .run(item.id, answer, r.verdict, r.feedback || null, nowIso());
      const streak = db.prepare(`SELECT verdict FROM practice_attempts WHERE item_id = ? ORDER BY id DESC LIMIT 1`).get(item.id);
      return json(res, 200, {
        verdict: r.verdict, feedback: r.feedback, tip: r.tip,
        model_answer: item.model_answer, expected: item.expected_json ? JSON.parse(item.expected_json) : [],
        correctNow: streak?.verdict === 'correct'
      });
    }

    // ---- 名单 ----
    if (seg[0] === 'roster' && method === 'GET') {
      needTeacher();
      const rows = db.prepare(`SELECT r.*, u.id AS user_id, u.created_at AS registered_at
                               FROM roster r LEFT JOIN users u ON u.id = r.claimed_by
                               ORDER BY r.class_name, r.class_no`).all();
      return json(res, 200, { roster: rows.map((r) => ({ ...r, claimed: Boolean(r.claimed_by) })) });
    }

    if (seg[0] === 'roster' && seg[1] === 'import' && method === 'POST') {
      const t = needTeacher();
      const b = await body();
      const text = String(b.csv ?? '');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let added = 0, updated = 0, skipped = 0;
      tx(db, () => {
        for (const line of lines) {
          const cols = line.split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
          if (cols.length < 4) { skipped++; continue; }
          const [cls, no, name, sid] = cols;
          if (/班別|class/i.test(cls) && /姓名|name/i.test(name)) { skipped++; continue; } // 表头
          if (!cls || !name || !sid) { skipped++; continue; }
          const exist = db.prepare('SELECT id FROM roster WHERE student_no = ?').get(sid);
          if (exist) {
            db.prepare('UPDATE roster SET class_name=?, class_no=?, name=? WHERE id=?').run(cls.toUpperCase(), no, name, exist.id);
            updated++;
          } else {
            db.prepare('INSERT INTO roster (class_name, class_no, name, student_no, created_at) VALUES (?,?,?,?,?)')
              .run(cls.toUpperCase(), no, name, sid, nowIso());
            added++;
          }
        }
      });
      audit(db, t.id, 'roster-import', null, { added, updated, skipped });
      return json(res, 200, { added, updated, skipped });
    }

    if (seg[0] === 'roster' && seg[2] === 'reset-password' && method === 'POST') {
      const t = needTeacher();
      const r = db.prepare('SELECT * FROM roster WHERE id = ?').get(Number(seg[1]));
      if (!r) throw new HttpError(404, '找不到名單記錄');
      if (!r.claimed_by) throw new HttpError(400, '這位學生還未註冊');
      const temp = String(Math.floor(1000 + Math.random() * 9000)) + 'a';
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temp), r.claimed_by);
      audit(db, t.id, 'reset-password', `user:${r.claimed_by}`);
      return json(res, 200, { temp_password: temp, name: r.name });
    }

    if (seg[0] === 'roster' && seg[2] === 'unclaim' && method === 'POST') {
      const t = needTeacher();
      const r = db.prepare('SELECT * FROM roster WHERE id = ?').get(Number(seg[1]));
      if (!r) throw new HttpError(404, '找不到名單記錄');
      if (r.claimed_by) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.claimed_by);
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(r.claimed_by);
        db.prepare('UPDATE roster SET claimed_by = NULL WHERE id = ?').run(r.id);
        audit(db, t.id, 'roster-unclaim', `roster:${r.id}`);
      }
      return json(res, 200, { ok: true });
    }

    // ---- AI 班級洞察：把統計變成「下一堂怎樣補」 ----
    if (seg[0] === 'assignments' && seg[2] === 'insight' && method === 'GET') {
      const t = needTeacher();
      const a = getAssignment(db, seg[1]);
      const rows = db.prepare(`SELECT teacher_scores_json, teacher_total FROM submissions WHERE assignment_id = ?`).all(a.id);
      const graded = rows.filter((r) => r.teacher_total !== null);
      if (!graded.length) throw new HttpError(400, '還沒有人被批改，暫時無法分析');
      const perQ = a.questions.map((q) => {
        const vals = graded.map((r) => {
          const ts = JSON.parse(r.teacher_scores_json || '{"questions":[]}');
          const hit = (ts.questions || []).find((x) => String(x.no) === String(q.no));
          return hit ? Number(hit.score) || 0 : 0;
        });
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
        return { no: q.no, tag: q.tag, max: q.max, n: vals.length, avg: Math.round(avg * 100) / 100, rate: Math.round((avg / q.max) * 1000) / 10 };
      });
      const tagMap = new Map();
      for (const q of perQ) {
        const g = tagMap.get(q.tag) || { tag: q.tag, s: 0, m: 0 };
        g.s += q.avg * q.n; g.m += q.max * q.n;
        tagMap.set(q.tag, g);
      }
      const stats = {
        submitted: rows.length, graded: graded.length,
        avg: Math.round((graded.reduce((s, r) => s + (r.teacher_total || 0), 0) / graded.length) * 100) / 100,
        perQuestion: perQ,
        perTag: [...tagMap.values()].map((g) => ({ tag: g.tag, rate: g.m ? Math.round((g.s / g.m) * 1000) / 10 : null }))
      };
      const r = await classInsight(getClient(cfg), { assignment: a, stats });
      logAiCall(db, { kind: 'insight', model: cfg.ai.model, ok: r.ok, usage: r.usage, ms: r.ms, target: `assignment:${a.id}`, error: r.error });
      if (!r.ok) return json(res, 502, { error: r.error });
      audit(db, t.id, 'ai-insight', `assignment:${a.id}`);
      return json(res, 200, { insight: r.insight, focus: r.focus, ms: r.ms });
    }

    // ---- 统计 ----
    if (seg[0] === 'assignments' && seg[2] === 'stats' && method === 'GET') {
      needTeacher();
      const a = getAssignment(db, seg[1]);
      const rows = db.prepare(`SELECT s.*, u.name, u.class_no, u.class_name FROM submissions s JOIN users u ON u.id = s.student_id
                               WHERE s.assignment_id = ? ORDER BY u.class_name, u.class_no`).all(a.id);
      const classNames = classesOf(db, a.id);
      const classSize = classSizeOf(db, classNames);
      const totalMax = a.total_score;

      const pick = (r) => r.teacher_total !== null && r.teacher_total !== undefined ? r.teacher_total : r.ai_total;
      const scored = rows.map((r) => ({ r, score: pick(r) }));
      const finals = scored.filter((x) => x.score !== null && x.score !== undefined).map((x) => x.score);
      const avg = finals.length ? finals.reduce((s, x) => s + x, 0) / finals.length : null;

      const perQuestion = a.questions.map((q) => {
        const vals = [];
        for (const r of rows) {
          const src = r.teacher_scores_json ? JSON.parse(r.teacher_scores_json) : (r.ai_json ? JSON.parse(r.ai_json) : null);
          if (!src) continue;
          if (src.questions) {
            const hit = src.questions.find((x) => String(x.no) === String(q.no));
            if (hit) vals.push(Number(hit.score) || 0);
          }
        }
        return {
          no: q.no, tag: q.tag, max: q.max, n: vals.length,
          avg: vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100 : null,
          rate: vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length / q.max) * 1000) / 10 : null
        };
      });

      const tagMap = new Map();
      for (const q of perQuestion) {
        if (!tagMap.has(q.tag)) tagMap.set(q.tag, { tag: q.tag, score: 0, max: 0 });
        const g = tagMap.get(q.tag);
        g.score += (q.avg || 0) * q.n;
        g.max += q.max * q.n;
      }
      const perTag = [...tagMap.values()].map((g) => ({
        tag: g.tag, rate: g.max ? Math.round((g.score / g.max) * 1000) / 10 : null
      }));

      const buckets = [0, 0, 0, 0, 0];
      for (const v of finals) {
        const pct = (v / totalMax) * 100;
        const i = pct >= 80 ? 0 : pct >= 60 ? 1 : pct >= 40 ? 2 : pct >= 20 ? 3 : 4;
        buckets[i]++;
      }

      // AI 与老师的分差：这是「AI 到底有没有用」最直接的证据
      const diffs = rows
        .filter((r) => r.ai_total !== null && r.teacher_total !== null)
        .map((r) => Math.abs(r.teacher_total - r.ai_total));
      const aiDiff = diffs.length ? Math.round((diffs.reduce((s, x) => s + x, 0) / diffs.length) * 100) / 100 : null;
      const changed = diffs.filter((d) => d > 0.01).length;

      // 逐班比較：三個班同時做同一份作業時，這一欄才是老師真正想看的
      const perClass = classNames.map((c) => {
        const list = scored.filter((x) => (x.r.class_name || '') === c);
        const vals = list.map((x) => x.score).filter((v) => v !== null && v !== undefined);
        return {
          class_name: c,
          class_size: db.prepare('SELECT COUNT(*) n FROM roster WHERE class_name = ?').get(c).n
            || db.prepare("SELECT COUNT(*) n FROM users WHERE role='student' AND class_name=?").get(c).n,
          submitted: list.length,
          avg: vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100 : null
        };
      });

      return json(res, 200, {
        assignment: assignmentSummary(a, db),
        class_size: classSize,
        per_class: perClass,
        submitted: rows.length,
        graded: rows.filter((r) => r.teacher_total !== null).length,
        returned: rows.filter((r) => ['returned', 'questioned'].includes(r.status)).length,
        avg: avg === null ? null : Math.round(avg * 100) / 100,
        max: totalMax,
        buckets,
        perQuestion, perTag,
        ai: { compared: diffs.length, avg_abs_diff: aiDiff, changed },
        students: scored.map(({ r, score }) => ({
          id: r.id, name: r.name, class_no: r.class_no, class_name: r.class_name, score, status: r.status,
          late: Boolean(r.late), ai_total: r.ai_total, teacher_total: r.teacher_total
        }))
      });
    }

    // ---- 导出成绩 CSV ----
    if (seg[0] === 'assignments' && seg[2] === 'export.csv' && method === 'GET') {
      needTeacher();
      const a = getAssignment(db, seg[1]);
      const rows = db.prepare(`SELECT s.*, u.name, u.class_no, u.student_no FROM submissions s JOIN users u ON u.id = s.student_id
                               WHERE s.assignment_id = ? ORDER BY u.class_no`).all(a.id);
      const head = ['班別', '學號', '姓名', '學生證號碼', '狀態', '提交時間', '遲交',
        ...a.questions.map((q) => `第${q.no}題(${q.max})`), '總分', '滿分', '百分比', 'AI總分', 'AI與老師分差', '老師評語'];
      const lines = [head.join(',')];
      for (const r of rows) {
        const ts = r.teacher_scores_json ? JSON.parse(r.teacher_scores_json) : null;
        const qs = a.questions.map((q) => {
          const hit = ts?.questions?.find((x) => String(x.no) === String(q.no));
          return hit ? hit.score : '';
        });
        const total = r.teacher_total ?? '';
        lines.push([
          r.class_name || a.class_name || '', r.class_no, r.name, r.student_no, statusLabel(r.status),
          r.submitted_at ? new Date(r.submitted_at).toLocaleString('zh-HK') : '', r.late ? '是' : '否',
          ...qs, total, a.total_score,
          total !== '' ? Math.round((total / a.total_score) * 1000) / 10 + '%' : '',
          r.ai_total ?? '', (r.ai_total !== null && r.teacher_total !== null) ? (r.teacher_total - r.ai_total) : '',
          (r.teacher_comment || '').replace(/\n/g, ' ')
        ].map(csvEscape).join(','));
      }
      const csv = '\uFEFF' + lines.join('\r\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="grades-${a.id}.csv"`,
        'Content-Length': Buffer.byteLength(csv)
      });
      return res.end(csv);
    }

    // ---- 评分标准模板（新建作业时可直接载入） ----
    if (seg[0] === 'templates' && method === 'GET') {
      need();
      const templates = [{ id: 'builtin-science-matter', name: '五年級科學 · 物質的變化（內建）', subject: '小學科學', questions: DEMO_QUESTIONS }];
      // 同时读取「評分標準範本」资料夹，老师自己加的 JSON 会立即出现在下拉选单
      const dir = path.resolve(ROOT, '..', '評分標準範本');
      try {
        for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.json')).sort()) {
          try {
            const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (!Array.isArray(t.questions) || !t.questions.length) continue;
            templates.push({
              id: f, name: t.name || f.replace(/\.json$/i, ''),
              subject: t.subject || '', class_name: t.class_name || '',
              description: t.description || '', questions: t.questions, isFile: true
            });
          } catch (e) {
            console.warn('[templates] 略過 ' + f + '：' + e.message);
          }
        }
      } catch { /* 資料夾不存在就只用內建 */ }
      return json(res, 200, { templates });
    }

    throw new HttpError(404, '找不到 API：' + url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[api]', e);
    return json(res, 500, { error: '伺服器內部錯誤：' + e.message });
  }
}
