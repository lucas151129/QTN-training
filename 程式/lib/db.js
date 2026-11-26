// 数据库：Node 24 内置 node:sqlite，零外部依赖。
// 数据表设计原则：
//   1. roster（老师预先把班级名单导入）是「唯一可信名单」，学生只能在名单内注册；
//   2. 作业的评分点（rubric）结构化存成 JSON，AI 只能按点和分评分，不能自创标准；
//   3. AI 结果与老师结果分开三个字段存放，任何时候都看得出「谁给了这个分」。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,                 -- teacher | student
  login_id TEXT NOT NULL UNIQUE,      -- 老师：用户名；学生：学生证号
  name TEXT NOT NULL,
  class_name TEXT,
  class_no TEXT,
  student_no TEXT,
  password_hash TEXT NOT NULL,
  roster_id INTEGER,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS roster (
  id INTEGER PRIMARY KEY,
  class_name TEXT NOT NULL,
  class_no TEXT NOT NULL,
  name TEXT NOT NULL,
  student_no TEXT NOT NULL UNIQUE,
  claimed_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT,
  class_name TEXT,
  description TEXT,
  questions_json TEXT NOT NULL,
  total_score REAL NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- draft | open | closed
  allow_late INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  status TEXT NOT NULL,                  -- submitted | ai_graded | returned | questioned
  submitted_at TEXT,
  late INTEGER NOT NULL DEFAULT 0,
  ai_json TEXT,
  ai_total REAL,
  ai_confidence REAL,
  ai_model TEXT,
  ai_at TEXT,
  teacher_scores_json TEXT,
  teacher_total REAL,
  teacher_comment TEXT,
  teacher_notes TEXT,
  graded_by INTEGER,
  graded_at TEXT,
  returned_at TEXT,
  question_text TEXT,
  question_at TEXT,
  UNIQUE(assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL,
  q_no TEXT NOT NULL,
  answer_text TEXT,
  UNIQUE(submission_id, q_no)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL,
  q_no TEXT,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

-- 學生「已看過這份作業」的記錄：用來決定登入時要不要彈「你有 N 份新作業」。
-- 存在資料庫而不是 localStorage，因為課室平板多人共用，換機就不準了。
CREATE TABLE IF NOT EXISTS assignment_views (
  student_id INTEGER NOT NULL,
  assignment_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (student_id, assignment_id)
);

-- 一份作業可以派給多個班（4A、4B、4C）。舊資料只有 class_name 一欄，
-- migrate() 會自動把 class_name 補進這張表，所以兩種寫法都讀得到。
CREATE TABLE IF NOT EXISTS assignment_classes (
  assignment_id INTEGER NOT NULL,
  class_name TEXT NOT NULL,
  PRIMARY KEY (assignment_id, class_name)
);

-- 每一次模型呼叫都記一筆：用來追成本、追慢、追錯。
-- 沒有這張表，你不知道「智能化」花了幾多錢。
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- transcribe | grade | comment | suggest | insight | ask
  model TEXT,
  ok INTEGER NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  ms INTEGER DEFAULT 0,
  target TEXT,                   -- 例如 submission:12
  error TEXT,
  created_at TEXT NOT NULL
);

-- 把分數由 JSON 拆成明細：學情分析（進步／退步／薄弱點）靠這張表，
-- 否則每次都要 json_extract，又慢又容易寫錯。
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL,
  assignment_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  q_no TEXT,
  point_id TEXT,                 -- 現階段以整題計分，留空
  tag TEXT,                      -- 知識點
  score REAL,
  max REAL,
  source TEXT NOT NULL DEFAULT 'teacher',   -- teacher | ai
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_student ON scores (student_id, source);
CREATE INDEX IF NOT EXISTS idx_scores_tag ON scores (student_id, tag);

-- 錯題精煉：針對弱點自動生成的練習題與作答記錄
CREATE TABLE IF NOT EXISTS practice_items (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL,
  tag TEXT,
  batch TEXT,
  source_assignment_id INTEGER,
  source_q_no TEXT,
  prompt TEXT NOT NULL,
  expected_json TEXT,
  model_answer TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practice_attempts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  answer TEXT,
  verdict TEXT,                  -- correct | partial | wrong
  feedback TEXT,
  created_at TEXT NOT NULL
);
`;

export function openDb(cfg) {
  fs.mkdirSync(cfg.dataPath, { recursive: true });
  fs.mkdirSync(cfg.uploadPath, { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  backfillScores(db);
  return db;
}

// 舊資料升級：已批改的提交要補寫入 scores 明細，否則學情分析看不到歷史。
// 只在「該提交還沒有明細」時做，可以重複執行。
function backfillScores(db) {
  const rows = db.prepare(`SELECT s.id, s.assignment_id, s.student_id, s.teacher_scores_json, a.questions_json
    FROM submissions s JOIN assignments a ON a.id = s.assignment_id
    WHERE s.teacher_scores_json IS NOT NULL`).all();
  const has = db.prepare("SELECT COUNT(*) n FROM scores WHERE submission_id = ? AND source = 'teacher'");
  const ins = db.prepare(`INSERT INTO scores (submission_id, assignment_id, student_id, q_no, tag, score, max, source, created_at)
                          VALUES (?,?,?,?,?,?,?, 'teacher', ?)`);
  for (const r of rows) {
    if (has.get(r.id).n > 0) continue;
    let ts, qs;
    try { ts = JSON.parse(r.teacher_scores_json); qs = JSON.parse(r.questions_json); } catch { continue; }
    const tags = new Map(qs.map((q) => [String(q.no), q.tag || '未分類']));
    for (const g of ts.questions || []) {
      ins.run(r.id, r.assignment_id, r.student_id, String(g.no), tags.get(String(g.no)) || '未分類',
        Number(g.score) || 0, Number(g.max) || 0, new Date().toISOString());
    }
  }
}

// 舊資料庫升級：SQLite 的 ALTER TABLE ADD COLUMN 很便宜，不用重建資料表。
// 這樣「已經開了學、資料不能刪」的情況也可以直接更新程式。
function migrate(db) {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const add = (table, name, def) => {
    if (!cols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  // 手寫轉寫（作文拍照通道）
  add('answers', 'mode', "TEXT DEFAULT 'typed'");        // typed | photo
  add('answers', 'transcript', 'TEXT');                   // AI 轉寫原稿
  add('answers', 'transcript_confidence', 'REAL');
  add('answers', 'transcript_notes', 'TEXT');
  add('answers', 'transcript_uncertain', 'TEXT');         // JSON 陣列
  add('answers', 'corrected_text', 'TEXT');               // 老師修正版（評分用）
  add('answers', 'transcript_at', 'TEXT');
  // 學期（學情分析要用）
  add('assignments', 'term', 'TEXT');
  add('assignments', 'level', 'TEXT');
  add('submissions', 'ai_usage', 'TEXT');                 // 每次 AI 的 token 與耗時

  syncAssignmentClasses(db);
}

// 舊作業（包括種子資料）的 class_name 補進 assignment_classes。
// 可重複執行；seedIfEmpty 之後也要再跑一次。
export function syncAssignmentClasses(db) {
  const rows = db.prepare(`SELECT id, class_name FROM assignments
    WHERE class_name IS NOT NULL AND class_name != ''
      AND NOT EXISTS (SELECT 1 FROM assignment_classes ac WHERE ac.assignment_id = assignments.id)`).all();
  const ins = db.prepare('INSERT OR IGNORE INTO assignment_classes (assignment_id, class_name) VALUES (?,?)');
  for (const r of rows) ins.run(r.id, String(r.class_name).toUpperCase());
  return rows.length;
}

export function nowIso() {
  return new Date().toISOString();
}

export function audit(db, actorId, action, target, detail) {
  db.prepare('INSERT INTO audit (actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?)')
    .run(actorId ?? null, action, target ?? null, detail ? JSON.stringify(detail) : null, nowIso());
}

// 記錄一次模型呼叫（成本與健康度）
export function logAiCall(db, { kind, model, ok, usage, ms, target, error }) {
  const u = usage || {};
  db.prepare(`INSERT INTO ai_calls (kind, model, ok, prompt_tokens, completion_tokens, reasoning_tokens, ms, target, error, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(kind, model || null, ok ? 1 : 0, u.prompt_tokens || 0, u.completion_tokens || 0,
      u.completion_tokens_details?.reasoning_tokens || 0, ms || 0, target || null,
      error ? String(error).slice(0, 300) : null, nowIso());
}

// ---------- 内置示范数据 ----------
// 一份「五年级科学 · 单元一 物质的变化」的示范作业 + 12 人名单 + 2 个已注册学生。
// 评分点写成可数的「点」，是这套系统的核心：AI 只能逐点给分，老师逐点覆核。

export const DEMO_QUESTIONS = [
  {
    no: '1', tag: '內容與細節', type: 'essay', max: 6,
    prompt: 'Write a paragraph (about 60 words) describing your favourite place in Hong Kong. Use at least three adjectives and one simile.',
    points: [
      { id: '1-1', desc: '描述一個具體地點，並有至少兩個細節（看到的、聽到的或聞到的）', score: 3 },
      { id: '1-2', desc: '正確使用至少三個形容詞', score: 2 },
      { id: '1-3', desc: '使用至少一個比喻（like … 或 as … as …）', score: 1 }
    ]
  },
  {
    no: '2', tag: '語言運用', type: 'text', max: 3,
    prompt: 'Rewrite ONE sentence from your paragraph to make it more vivid. Explain what you changed.',
    points: [
      { id: '2-1', desc: '改寫了一句，並保留原本意思', score: 2 },
      { id: '2-2', desc: '說明改了甚麼，以及為甚麼會更好', score: 1 }
    ]
  },
  {
    no: '3', tag: '反思', type: 'text', max: 3,
    prompt: 'Which part of your paragraph are you least happy with? What would you change if you wrote it again?',
    points: [
      { id: '3-1', desc: '指出一個具體的部分（句子或詞語）', score: 1 },
      { id: '3-2', desc: '提出具體的改法', score: 2 }
    ]
  }
];
const DEMO_ROSTER = [
  ['6A', '01', '陳嘉欣', '2025001'], ['6A', '02', '陳子朗', '2025002'],
  ['6A', '03', '周詠彤', '2025003'], ['6A', '04', '鄭浩然', '2025004'],
  ['6A', '05', '何思穎', '2025005'], ['6A', '06', '許俊熙', '2025006'],
  ['6A', '07', '江欣霖', '2025007'], ['6A', '08', '李卓謙', '2025008'],
  ['6A', '09', '梁凱婷', '2025009'], ['6A', '10', '麥梓柔', '2025010'],
  ['6A', '11', '吳朗然', '2025011'], ['6A', '12', '黃琛悅', '2025012']
];

export function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const t = nowIso();
  // 老师账号：teacher / 1234（第一次登录后请立即改密码，见 README）
  db.prepare(`INSERT INTO users (role, login_id, name, password_hash, created_at) VALUES (?,?,?,?,?)`)
    .run('teacher', 'teacher', '盧老師', hashPassword('1234'), t);

  const insRoster = db.prepare('INSERT INTO roster (class_name, class_no, name, student_no, created_at) VALUES (?,?,?,?,?)');
  for (const [cls, no, name, sid] of DEMO_ROSTER) insRoster.run(cls, no, name, sid, t);

  // 头两个学生预先注册好，方便一开机就能演示「学生视角」
  for (const [cls, no, name, sid] of DEMO_ROSTER.slice(0, 2)) {
    const r = db.prepare('SELECT id FROM roster WHERE student_no = ?').get(sid);
    db.prepare(`INSERT INTO users (role, login_id, name, class_name, class_no, student_no, password_hash, roster_id, created_at)
                VALUES ('student', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sid, name, cls, no, sid, hashPassword('1234'), r.id, t);
    db.prepare('UPDATE roster SET claimed_by = (SELECT id FROM users WHERE login_id = ?) WHERE student_no = ?').run(sid, sid);
  }

  const total = DEMO_QUESTIONS.reduce((s, q) => s + q.max, 0);
  const due = new Date(Date.now() + 7 * 864e5).toISOString();
  db.prepare(`INSERT INTO assignments (title, subject, class_name, description, questions_json, total_score, due_at, status, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('Writing Task 1 · A Descriptive Paragraph', '小學英文', '6A',
      '第 1 題可以選擇「打字」或「拍照」提交：把寫在紙上的作文拍下來，系統會先把手寫字轉成文字，老師批改時就可以直接引用你的句子。第 2、3 題請打字作答。',
      JSON.stringify(DEMO_QUESTIONS), total, due, 'open', 1, t);

  db.prepare('INSERT INTO settings (k, v) VALUES (?,?) ON CONFLICT(k) DO NOTHING').run('seed_version', '1');

  // 種子作業也要進 assignment_classes，否則會顯示「未指定班別」而變成全校可見
  syncAssignmentClasses(db);
}
