// 單張截圖工具（可指定要捲到哪個元素），方便補拍。
// 用法：node test/shot-one.mjs <base> <outDir> <名稱> <hash> [捲到的選擇器]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [BASE, OUT, NAME, HASH, SCROLL_TO] = process.argv.slice(2);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9800 + Math.floor(Math.random() * 150);
const PROFILE = path.join(process.env.TEMP || '.', 'dsh-shot1-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
  '--no-sandbox', '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore' });

for (let i = 0; i < 80; i++) {
  try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); }
}
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

// 先登入（沿用測試帳號），再開目標頁
await send('Page.navigate', { url: BASE + '/?s=1#/login' });
await sleep(1500);
const USER_ID = process.env.SHOT_USER || '2025001';
const USER_PW = process.env.SHOT_PW || '1234';
await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:'${USER_ID}',password:'${USER_PW}'})}).then(r=>r.json())`);
await send('Page.navigate', { url: BASE + '/?s=2' + (HASH || '#/') });
await sleep(3000);
for (let i = 0; i < 50; i++) {
  const t = await evaluate("document.querySelector('main')?.innerText || ''");
  if (t && !t.includes('載入中')) break;
  await sleep(200);
}
// 等練習生成 / AI 回應
for (let i = 0; i < 40; i++) {
  const n = await evaluate("document.querySelectorAll('[data-item]').length");
  const f = await evaluate("!!document.querySelector('[data-feedback] .flag')");
  if (n && !HASH.includes('practice')) break;
  if (f) break;
  await sleep(700);
}
const PRE_FILE = process.argv[7];
if (PRE_FILE && fs.existsSync(PRE_FILE)) {
  await evaluate(fs.readFileSync(PRE_FILE, 'utf8'));
  for (let i = 0; i < 40; i++) {
    if (await evaluate("!!document.querySelector('[data-feedback] .flag')")) break;
    await sleep(500);
  }
  await sleep(400);
}
if (SCROLL_TO) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(SCROLL_TO)}); if (el) el.scrollIntoView({block:'start'}); })()`);
  await sleep(700);
}
const r = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, NAME + '.png'), Buffer.from(r.result.data, 'base64'));
console.log('📸 ' + NAME + '.png');
ws.close();
chrome.kill();
await sleep(300);
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
