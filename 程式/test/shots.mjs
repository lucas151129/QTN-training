// 用 Chrome DevTools Protocol 截圖。需要在 live 模式的伺服器上跑（要真實轉寫與分析）。
// 用法：node test/shots.mjs http://127.0.0.1:8896 <輸出資料夾>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8896';
const OUT = process.argv[3] || path.join(process.cwd(), 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9300 + Math.floor(Math.random() * 300);
const PROFILE = path.join(process.env.TEMP || '.', 'dsh-shots-' + Date.now());
const SAMPLE = path.join(process.cwd(), 'test', 'sample-essay.png');
const IMG = 'data:image/png;base64,' + fs.readFileSync(SAMPLE).toString('base64');

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--disable-gpu', '--force-device-scale-factor=1', '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(pathname, opts) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, opts);
  return r.json();
}
async function connect() {
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
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

const { ws, send } = await connect();
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
let nonce = 0;
async function goto(hash, wait = 700) {
  nonce++;
  await send('Page.navigate', { url: `${BASE}/?_=${nonce}${hash}` });
  await sleep(wait);
  for (let i = 0; i < 60; i++) {
    const txt = await evaluate("document.querySelector('main')?.innerText || ''");
    if (txt && !txt.includes('載入中')) break;
    await sleep(150);
  }
  await sleep(250);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('  📸 ' + name + '.png');
}
const api = (p, body) => `fetch('${p}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`;

try {
  // 1) 登入頁
  await goto('/#/login', 900);
  await shot('01_登入頁');

  // 2) 老師登入 → 作業列表
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: 'teacher', password: '1234' }));
  await goto('/#/', 1100);
  await shot('02_老師作業列表');

  const asgId = await evaluate("fetch('/api/assignments').then(r=>r.json()).then(d=>d.assignments[0].id)");

  // 3) 學生登入 → 作答頁（作文：打字／拍照兩條通道）
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: '2025001', password: '1234' }));
  await goto('/#/', 900);
  await shot('03_學生作業列表');
  await goto('/#/a/' + asgId, 1200);
  await evaluate(`(() => {
    const ta = document.querySelector('textarea[data-text]');
    if (ta) { ta.value = 'My favourite place is Cheung Chau. The ferry ride was bumpy but exciting...'; ta.dispatchEvent(new Event('input',{bubbles:true})); }
  })()`);
  await shot('04_學作答題_打字通道');
  // 切到「拍照」通道
  await evaluate(`(() => { const b = document.querySelector('[data-ch="photo"]'); if (b) b.click(); })()`);
  await sleep(400);
  await shot('05_學作答題_拍照通道');

  // 4) 用 API 以「拍照」通道提交（帶真實示範相片）
  const sub = await evaluate(`fetch('/api/assignments/${asgId}/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:[
    {no:'1',mode:'photo',text:'',images:[${JSON.stringify(IMG)}]},
    {no:'2',mode:'typed',text:'I changed "hot" to "burning" because it sounds stronger and shows how hot the fish ball was.',images:[]},
    {no:'3',mode:'typed',text:'I am least happy with the last sentence. I would add a simile: the sea was as calm as a mirror.',images:[]}
  ]})}).then(r=>r.json())`);
  const sid = sub?.submission?.id;
  console.log('  提交完成，submission =', sid, '，已轉寫：', JSON.stringify(sub?.transcribed));

  // 5) 老師看提交 → AI 預批 → 批改頁（含轉寫稿）
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: 'teacher', password: '1234' }));
  await goto('/#/a/' + asgId, 1100);
  await shot('06_老師作業詳情');
  await evaluate(api(`/api/submissions/${sid}/ai`, {}));
  await goto('/#/g/' + sid, 1400);
  await shot('07_老師批改頁_AI建議與轉寫稿');

  // 6) 評語草稿
  await evaluate(`(async () => {
    const box = document.querySelector('#overall');
    const scores = {};
    document.querySelectorAll('[data-score]').forEach(i => { scores[i.dataset.score] = { score: Number(i.value) }; });
    const r = await fetch('/api/submissions/${sid}/comment-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scores})}).then(x=>x.json());
    if (r.comment) { box.value = r.comment; }
  })()`);
  await sleep(600);
  await shot('08_評語草稿');

  // 7) 發還 → 學生成績頁
  await evaluate(`fetch('/api/submissions/${sid}/grade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scores:{1:{score:6,comment:'三個形容詞和一個比喻都用得好'},2:{score:2,comment:'理由清楚，但未寫出完整改寫句'},3:{score:2.5,comment:'改法具體'}},comment:document.querySelector('#overall').value,notes:'',return:true})}).then(r=>r.json())`);
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: '2025001', password: '1234' }));
  await goto('/#/a/' + asgId, 1300);
  await shot('09_學生成績頁');
  // 學生問 AI
  await evaluate(`(() => { const b = document.querySelector('[data-askq]'); if (b) b.click(); })()`);
  await sleep(4000);
  await shot('10_學生追問');

  // 8) 統計 + AI 教學分析
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: 'teacher', password: '1234' }));
  await goto('/#/s/' + asgId, 1300);
  await shot('11_統計分析');
  await evaluate(`(() => { const b = document.querySelector('#gen-insight'); if (b) b.click(); })()`);
  for (let i = 0; i < 40; i++) {
    const html = await evaluate("document.querySelector('#insight-box')?.innerText || ''");
    if (html.length > 40) break;
    await sleep(500);
  }
  await sleep(400);
  await shot('12_AI教學分析');

  // 9) 出題助手
  await goto('/#/new', 1100);
  await shot('13_新增作業_出題助手');
  await evaluate(`(() => { document.querySelector('#gen-topic').value = 'A Diary Entry (past tense, feelings)'; })()`);
  await evaluate(`(() => { const b = document.querySelector('#gen-go'); if (b) b.click(); })()`);
  for (let i = 0; i < 60; i++) {
    const q = await evaluate("(document.querySelectorAll('[data-qi]').length)");
    const status = await evaluate("document.querySelector('#gen-status')?.innerText || ''");
    if (q && !status.includes('草擬')) break;
    await sleep(600);
  }
  await sleep(500);
  await shot('14_出題助手_生成結果');

  // 10) 學生：我的學習 + 錯題精煉
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: '2025001', password: '1234' }));
  const myId = await evaluate("fetch('/api/me').then(r=>r.json()).then(d=>d.user.id)");
  await goto('/#/learn', 1500);
  await shot('17_我的學習');
  const weakTag = await evaluate("(() => { const b = document.querySelector('[data-prac]'); return b ? b.dataset.prac : ''; })()");
  await goto('/#/learn/' + encodeURIComponent(weakTag || ''), 3000);
  for (let i = 0; i < 40; i++) {
    const n = await evaluate("document.querySelectorAll('[data-item]').length");
    if (n > 0) break;
    await sleep(600);
  }
  await sleep(500);
  await shot('18_錯題精煉');
  await evaluate(`(() => {
    const ta = document.querySelector('[data-item] textarea');
    ta.value = 'I like it.';
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    const b = document.querySelector('[data-submit]');
    if (b) b.click();
  })()`);
  for (let i = 0; i < 40; i++) {
    const has = await evaluate("!!document.querySelector('[data-feedback] .flag')");
    if (has) break;
    await sleep(400);
  }
  await sleep(400);
  await shot('19_練習即時回饋');

  // 11) 老師看某個學生的學習記錄
  await goto('/#/login', 400);
  await evaluate(api('/api/login', { login_id: 'teacher', password: '1234' }));
  await goto('/#/p/' + myId, 1400);
  await shot('20_老師看學情');
  // 10) 名單 / 用量
  await goto('/#/roster', 1000);
  await shot('15_學生名單');
  await goto('/#/account', 1200);
  await shot('16_AI用量');
} catch (e) {
  console.error('截圖失敗：', e.message);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
}
