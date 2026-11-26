#!/usr/bin/env node
// 備份：把資料庫與相片複製到一個帶時間戳的資料夾。
// 用 SQLite 的 VACUUM INTO 做熱備份（不必關伺服器，拿到的檔案也一定完整）。
//
// 用法：node scripts/backup.mjs [輸出資料夾]
//   預設輸出到 ../../備份與匯出/
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, ROOT } from '../lib/config.js';

const cfg = loadConfig();
const outRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(ROOT, '..', '備份與匯出');

const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').replace(/-(\d{3})$/, '');
const dir = path.join(outRoot, 'backup-' + stamp);

fs.mkdirSync(dir, { recursive: true });

// 1) 資料庫：VACUUM INTO 會產生一個乾淨、一致的副本（含尚未合併的 WAL）
const dbTarget = path.join(dir, 'app.db').replace(/\\/g, '/');
let dbRows = 0;
if (fs.existsSync(cfg.dbPath)) {
  const db = new DatabaseSync(cfg.dbPath);
  try {
    db.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
    dbRows = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  } finally {
    db.close();
  }
} else {
  console.warn('找不到資料庫：' + cfg.dbPath + '（可能未啟動過）');
}

// 2) 相片
const upTarget = path.join(dir, 'uploads');
let fileCount = 0;
if (fs.existsSync(cfg.uploadPath)) {
  fs.cpSync(cfg.uploadPath, upTarget, { recursive: true });
  const walk = (p) => fs.readdirSync(p, { withFileTypes: true })
    .forEach((d) => d.isDirectory() ? walk(path.join(p, d.name)) : fileCount++);
  walk(upTarget);
}

// 3) 清單
const manifest = {
  createdAt: new Date().toISOString(),
  source: { db: cfg.dbPath, uploads: cfg.uploadPath },
  dbBytes: fs.existsSync(path.join(dir, 'app.db')) ? fs.statSync(path.join(dir, 'app.db')).size : 0,
  photos: fileCount,
  students: dbRows,
  note: '還原方法：把 app.db 與 uploads/ 覆蓋回 程式/data/ 即可。'
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log('備份完成：' + dir);
console.log(`  資料庫 ${(manifest.dbBytes / 1024).toFixed(0)} KB｜相片 ${fileCount} 張｜已註冊/名單 ${dbRows} 人`);
