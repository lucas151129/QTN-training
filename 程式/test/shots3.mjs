// 第二批截圖：承接 shots.mjs 已建立的資料，只跑剩下的畫面。
// 每一步獨立容錯；任何一步失敗都不會拖死整輪。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8896';
const OUT = process.argv[3] || path.join(process.cwd(), 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9600 + Math.floor(Math.random() * 200);
const PROFILE = path.join(process.env.TEMP || '.', 'dsh-shots3-' + Date.now());

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(pathname, opts) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, opts);
  return r.json();
}
for (let i = 0; i < 80; i++) { try { await cdp('/json/version'); break; } catch { await sleep(200); } }
const target = await cdp('/json/new?about:blank', { method: 'PUT' });
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');

async function evaluate(expr) {
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(25000).then(() => null)
    ]);
    return r?.result?.result?.value;
  } catch { return null; }
}
let nonce = 0;
async function goto(hash, wait = 1000) {
  nonce++;
  await Promise.race([send('Page.navigate', { url: `${BASE}/?n=${nonce}${hash}` }), sleep(20000)]);
  await sleep(wait);
  for (let i = 0; i < 40; i++) {
    const txt = await evaluate("document.querySelector('main')?.innerText || ''");
    if (txt && !txt.includes('載入中')) break;
    await sleep(150);
  }
  await sleep(200);
}
async function shot(name) {
  try {
    const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(20000)]);
    if (!r?.result?.data) { console.log('  ⚠ 跳過 ' + name); return false; }
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('  📸 ' + name + '.png');
    return true;
  } catch (e) {
    console.log('  ⚠ ' + name + ' 失敗：' + e.message);
    return false;
  }
}
const doLogin = (uid, pw) => evaluate(
  `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:'${uid}',password:'${pw}'})}).then(r=>r.json()).then(d=>d.user?d.user.id:null)`
);

try {
  await goto('/#/login', 1400);
  const myId = await doLogin('2025001', '1234');
  console.log('  student id =', myId);
  const asgId = await evaluate("fetch('/api/assignments').then(r=>r.json()).then(d=>d.assignments?.[0]?.id)");
  console.log('  assignment =', asgId);

  if (asgId) {
    await goto('/#/a/' + asgId, 1500);
    await evaluate("(() => { const b = document.querySelector('[data-askq]'); if (b) b.click(); })()");
    await sleep(5000);
    await shot('10_學生追問');
  }

  await goto('/#/learn', 1700);
  await shot('17_我的學習');
  const weakTag = await evaluate("(() => { const b = document.querySelector('[data-prac]'); return b ? b.dataset.prac : ''; })()");
  console.log('  weakest tag =', weakTag);
  if (weakTag) {
    await goto('/#/learn/' + encodeURIComponent(weakTag), 2500);
    for (let i = 0; i < 40; i++) {
      if (await evaluate("document.querySelectorAll('[data-item]').length")) break;
      await sleep(700);
    }
    await shot('18_錯題精煉');
    await evaluate("(() => { const ta = document.querySelector('[data-item] textarea'); if(!ta) return; ta.value='I like it.'; ta.dispatchEvent(new Event('input',{bubbles:true})); const b=document.querySelector('[data-submit]'); if(b) b.click(); })()");
    for (let i = 0; i < 30; i++) {
      if (await evaluate("!!document.querySelector('[data-feedback] .flag')")) break;
      await sleep(500);
    }
    await shot('19_練習即時回饋');
  }

  await goto('/#/login', 600);
  await doLogin('teacher', '1234');
  if (asgId) {
    await goto('/#/s/' + asgId, 1600);
    await shot('11_統計分析');
    await evaluate("(() => { const b = document.querySelector('#gen-insight'); if (b) b.click(); })()");
    for (let i = 0; i < 40; i++) {
      const t = await evaluate("document.querySelector('#insight-box')?.innerText || ''");
      if (t.length > 40) break;
      await sleep(700);
    }
    await shot('12_AI教學分析');
  }

  await goto('/#/new', 1400);
  await shot('13_新增作業_出題助手');
  await evaluate("(() => { const el = document.querySelector('#gen-topic'); if (el) el.value = 'A Diary Entry (past tense, feelings)'; })()");
  await evaluate("(() => { const b = document.querySelector('#gen-go'); if (b) b.click(); })()");
  for (let i = 0; i < 50; i++) {
    const n = await evaluate("document.querySelectorAll('[data-qi]').length");
    const s = await evaluate("document.querySelector('#gen-status')?.innerText || ''");
    if (n && !s.includes('草擬')) break;
    await sleep(800);
  }
  await shot('14_出題助手_生成結果');

  await goto('/#/roster', 1300);
  await shot('15_學生名單');
  await goto('/#/account', 1600);
  await shot('16_AI用量');
  if (myId) {
    await goto('/#/p/' + myId, 1600);
    await shot('20_老師看學情');
  }
  console.log('  完成');
} catch (e) {
  console.error('中斷：', e.message);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}
