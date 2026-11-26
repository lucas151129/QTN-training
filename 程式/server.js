// 入口：一个 node 进程同时做 API 和静态文件，零外部依赖。
// 启动：node server.js  （或在 Windows 双击 start.bat）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, ROOT } from './lib/config.js';
import { openDb, seedIfEmpty } from './lib/db.js';
import { handleApi } from './lib/api.js';

const cfg = loadConfig();
const db = openDb(cfg);
seedIfEmpty(db);

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    // SPA：未知路径一律回到 index.html
    const index = path.join(PUBLIC, 'index.html');
    const buf = fs.readFileSync(index);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    res.end(buf);
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const buf = fs.readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60'
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi({ req, res, url, db, cfg });
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('伺服器錯誤：' + e.message);
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(cfg.port, '0.0.0.0', () => {
  const line = '='.repeat(64);
  console.log(line);
  console.log(`  ${cfg.siteName}`);
  console.log(line);
  console.log(`  本機：      http://127.0.0.1:${cfg.port}`);
  for (const ip of lanAddresses()) console.log(`  同一個 WiFi：http://${ip}:${cfg.port}`);
  console.log(`  資料庫：     ${cfg.dbPath}`);
  console.log(`  相片存放：   ${cfg.uploadPath}`);
  console.log(`  AI 模式：    ${cfg.ai.effectiveMode === 'live' ? '真實模型 ' + cfg.ai.modelLabel : '本地模擬（未配置 API Key）'}`);
  if (cfg.ai.effectiveMode === 'mock') {
    console.log('  ⚠ 現在是模擬模式：分數只為演示流程，不代表真實評分。');
    console.log('    要接入真實模型：複製 config.example.json 為 config.json，填入 apiKey。');
  }
  console.log(line);
  console.log('  老師帳號：teacher / 1234（請登入後立即改密碼）');
  console.log('  示範學生：2025001 / 1234 、 2025002 / 1234');
  console.log(line);
  console.log('  按 Ctrl+C 停止');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在關閉…');
    server.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  });
}
