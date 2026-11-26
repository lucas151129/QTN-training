// 真實模型測試：用真 key 跑一次完整流程，驗證「不只是通，而且準」。
// 這是唯一會花錢的測試（每次約 HK$0.1 以內）。
// 執行：node test/live.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(HERE, '.live-data');
const SAMPLE = path.join(HERE, 'sample-essay.png');

// 圖片裡的原文（用來核對轉寫準確度）
const GROUND_TRUTH = 'Last summer I went to Cheung Chau with my family. '
  + 'The ferry ride was bumpy but exciting. When we arrived, the streets were full of tiny shops '
  + 'and the smell of dried fish filled the air. I bought a big fish ball and it was so hot that '
  + 'I almost droped it. The beach was quiet and the sea looked like a huge blue mirror. '
  + 'I felt very relax there. I hope I can go again next year.';

const PNG = 'data:image/png;base64,' + fs.readFileSync(SAMPLE).toString('base64');
const sleeps = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '\n      → ' + extra : ''}`); }
};
const line = (t) => console.log('\n\x1b[36m' + t + '\x1b[0m');

async function call(method, p, body, cookie) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
}
function overlap(a, b) {
  const A = words(a), B = new Set(words(b));
  if (!A.length) return 0;
  return A.filter((w) => B.has(w)).length / A.length;
}

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, AI_MODE: 'live' },
  stdio: 'ignore'
});
const cleanup = () => {
  try { child.kill(); } catch { /* ignore */ }
  setTimeout(() => {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(fail ? 1 : 0);
  }, 400);
};

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* 未啟動 */ }
    await sleeps(200);
  }
  const health = await call('GET', '/api/health');
  line('[0] 連線');
  ok('模型已接上（live 模式）', health.data.aiMode === 'live', JSON.stringify(health.data));

  const tLogin = await call('POST', '/api/login', { login_id: 'teacher', password: '1234' });
  const tCookie = tLogin.cookie;
  const sLogin = await call('POST', '/api/login', { login_id: '2025001', password: '1234' });
  const sCookie = sLogin.cookie;
  ok('老師與學生登入', tLogin.status === 200 && sLogin.status === 200);

  const list = await call('GET', '/api/assignments', undefined, tCookie);
  const asg = list.data.assignments[0];
  ok('種子作業為英文作文', asg.subject === '小學英文' && asg.total_score === 12, JSON.stringify(asg.subject));

  // ---------- 1. 拍照提交 + 自動轉寫 ----------
  line('[1] 拍照通道：手寫轉寫（這是整個方案的關鍵一步）');
  const t0 = Date.now();
  const sub = await call('POST', `/api/assignments/${asg.id}/submit`, {
    answers: [
      { no: '1', mode: 'photo', text: '', images: [PNG] },
      { no: '2', mode: 'typed', text: 'I changed "hot" to "burning" because it sounds stronger and shows how hot the fish ball was.', images: [] },
      { no: '3', mode: 'typed', text: 'I am least happy with the last sentence. I would add a simile: the sea was as calm as a mirror.', images: [] }
    ]
  }, sCookie);
  const submitMs = Date.now() - t0;
  ok('提交成功並觸發轉寫', sub.status === 200 && Array.isArray(sub.data.transcribed) && sub.data.transcribed.includes('1'), JSON.stringify(sub.data).slice(0, 200));
  const ans1 = sub.data.submission.answers.find((x) => String(x.q_no) === '1');
  console.log('\n  ── 轉寫結果（信心 ' + Math.round((ans1.transcript_confidence || 0) * 100) + '%，耗時 ' + submitMs + 'ms）──');
  console.log('  ' + String(ans1.transcript || '(空)').split('\n').join('\n  '));
  if (ans1.uncertain?.length) console.log('  不確定：' + ans1.uncertain.join('、'));

  const ov = overlap(GROUND_TRUTH, ans1.transcript);
  ok('轉寫與原文詞彙重疊 ≥ 95%', ov >= 0.95, '重疊 ' + Math.round(ov * 100) + '%');
  ok('保留了學生的拼寫錯誤 "droped"（沒有偷偷改正）', /droped/i.test(ans1.transcript || ''));
  ok('保留了 "relax"（沒有改成 relaxed）', /\brelax\b/i.test(ans1.transcript || ''));
  ok('有信心值', (ans1.transcript_confidence || 0) > 0.5);

  // ---------- 2. AI 逐點預批 ----------
  line('[2] AI 逐點預批（第 1 題應該拿滿分：三個形容詞 + 一個比喻 + 兩個細節）');
  const sid = sub.data.submission.id;
  const ai = await call('POST', `/api/submissions/${sid}/ai`, {}, tCookie);
  ok('預批成功', ai.status === 200 && ai.data.submission.ai, JSON.stringify(ai.data).slice(0, 1200));
  const ai1 = ai.data.submission.ai.questions.find((q) => q.no === '1');
  console.log(`\n  第 1 題：${ai1.score}/${ai1.max}（信心 ${Math.round(ai1.confidence * 100)}%）`);
  for (const p of ai1.points) {
    console.log(`   • ${p.awarded}/${p.max}  ${p.desc}`);
    console.log(`     依據：${p.evidence}`);
  }
  console.log('  評語：' + ai1.comment);
  ok('第 1 題評分合理（4–6 分）', ai1.score >= 4 && ai1.score <= 6, 'AI 給 ' + ai1.score);
  ok('每個評分點都有依據', ai1.points.every((p) => p.evidence && p.evidence.length > 4));
  ok('依據引用了學生原文', ai1.points.some((p) => /「|"|droped|mirror|ferry|Cheung/i.test(p.evidence)));
  const ai2 = ai.data.submission.ai.questions.find((q) => q.no === '2');
  console.log(`\n  第 2 題：${ai2.score}/${ai2.max}　評語：${ai2.comment}`);
  ok('AI 總分在合理範圍', ai.data.submission.ai.total >= 5 && ai.data.submission.ai.total <= 12, '總分 ' + ai.data.submission.ai.total);
  console.log('\n  全份總結：' + (ai.data.submission.ai.summary || ''));
  console.log('  flags：' + JSON.stringify(ai.data.submission.ai.flags));

  // ---------- 3. 評語草稿 ----------
  line('[3] 評語草稿（老師一鍵，再自己改）');
  const scores = {};
  for (const q of ai.data.submission.ai.questions) scores[q.no] = { score: q.score, comment: q.comment };
  const cd = await call('POST', `/api/submissions/${sid}/comment-draft`, { scores }, tCookie);
  ok('評語生成成功', cd.status === 200 && cd.data.comment.length > 30, JSON.stringify(cd.data).slice(0, 200));
  console.log('  ' + cd.data.comment);

  // ---------- 4. 定分發還 → 學生提問 ----------
  line('[4] 發還與學生追問（只能按老師評語回答，不能改分）');
  const graded = await call('POST', `/api/submissions/${sid}/grade`, {
    scores, comment: cd.data.comment, notes: '', return: true
  }, tCookie);
  ok('發還成功', graded.status === 200 && graded.data.submission.status === 'returned');
  const ask = await call('POST', `/api/submissions/${sid}/ask`, { q_no: '1' }, sCookie);
  ok('學生可以問「為甚麼是這個分數」', ask.status === 200, JSON.stringify(ask.data).slice(0, 200));
  console.log('  ' + (ask.data.answer || ask.data.error || '(沒有回應)'));

  // ---------- 5. 出題助手 ----------
  line('[5] 出題助手（老師輸入課題，草擬題目與評分點）');
  const sug = await call('POST', '/api/ai/suggest', {
    subject: '小學英文', level: '小六', topic: 'A Diary Entry (past tense, feelings)', count: 4
  }, tCookie);
  ok('出題成功', sug.status === 200 && sug.data.questions.length >= 3, JSON.stringify(sug.data).slice(0, 300));
  console.log('  標題：' + sug.data.title + '（總分 ' + sug.data.total + '）');
  for (const q of sug.data.questions) {
    console.log(`   ${q.no}. [${q.tag}] ${q.type} － ${q.prompt.slice(0, 70)}`);
    for (const p of q.points) console.log(`      · ${p.desc}（${p.score} 分）`);
  }
  ok('產生的評分點都有分數', sug.data.questions.every((q) => q.points.length >= 1 && q.points.every((p) => p.score > 0)));

  // ---------- 6. 班級洞察 ----------
  line('[6] 班級洞察（把統計變成「下一堂怎樣補」）');
  const ins = await call('GET', `/api/assignments/${asg.id}/insight`, undefined, tCookie);
  ok('分析成功', ins.status === 200 && ins.data.insight.length > 50, JSON.stringify(ins.data).slice(0, 200));
  console.log('  ' + ins.data.insight.split('\n').join('\n  '));
  if (ins.data.focus) console.log('  → 建議重教：' + ins.data.focus);

  // ---------- 7. 學習畫像 + 錯題精煉 ----------
  line('[7] 學習畫像與錯題精煉（用剛才批改的分數）');
  const me = await call('GET', '/api/me', undefined, sCookie);
  const prog = await call('GET', `/api/students/${me.data.user.id}/progress`, undefined, sCookie);
  ok('學習記錄可讀', prog.status === 200 && prog.data.tags.length > 0, JSON.stringify(prog.data).slice(0, 200));
  console.log('  平均得分率 ' + prog.data.overall.avg + '%，知識點：');
  for (const t of prog.data.tags) console.log(`   • ${t.tag}　${t.avg}%（${t.n} 次）換算 ${t.delta === null ? '—' : t.delta}`);

  const mis = await call('GET', '/api/practice/mistakes', undefined, sCookie);
  ok('錯題清單有扣分記錄', mis.status === 200 && mis.data.tags.length > 0, JSON.stringify(mis.data).slice(0, 200));
  const target = mis.data.tags[0];
  console.log(`\n  最需要練：${target.tag}（累計失分 ${target.lost} 分）`);
  for (const it of target.items) console.log(`   - 第 ${it.q_no} 題 ${it.score}/${it.max}：未做到 ${it.missed.join('、')}`);

  const gen = await call('POST', '/api/practice/generate', { tag: target.tag, count: 3 }, sCookie);
  ok('生成針對弱點的練習', gen.status === 200 && gen.data.items.length >= 2, JSON.stringify(gen.data).slice(0, 300));
  for (const [i, it] of (gen.data.items || []).entries()) {
    console.log(`\n   練習 ${i + 1}：${it.prompt}`);
    console.log(`   要達到：${(it.expected || []).join('｜')}`);
  }

  const item = gen.data.items[0];
  const bad = await call('POST', `/api/practice/${item.id}/answer`, { answer: 'I like it.' }, sCookie);
  ok('作答後有判斷與回饋', bad.status === 200 && ['correct', 'partial', 'wrong'].includes(bad.data.verdict), JSON.stringify(bad.data).slice(0, 200));
  console.log(`\n   弱答案「I like it.」→ ${bad.data.verdict}：${bad.data.feedback}`);

  // 示範答案在第一次作答之後才回傳（避免學生未答先看答案）
  ok('作答後才給示範答案', Boolean(bad.data.model_answer), JSON.stringify(bad.data).slice(0, 150));
  const good = await call('POST', `/api/practice/${item.id}/answer`, { answer: bad.data.model_answer }, sCookie);
  ok('示範答案會被判為正確', good.status === 200 && good.data.verdict === 'correct', JSON.stringify(good.data).slice(0, 250));
  console.log(`   示範答案 → ${good.data.verdict}：${good.data.feedback}`);
  ok('答錯與答對的判斷有分別', good.data.verdict !== bad.data.verdict, `bad=${bad.data.verdict} good=${good.data.verdict}`);
  // ---------- 7. 用量 ----------
  line('[7] 用量與成本');
  const usage = await call('GET', '/api/ai/usage', undefined, tCookie);
  let tokens = 0;
  for (const k of usage.data.byKind) {
    tokens += k.p + k.c;
    console.log(`  ${k.kind.padEnd(11)} ${String(k.n).padStart(3)} 次　${String(k.p + k.c).padStart(6)} tokens　平均 ${k.avg_ms} ms`);
  }
  ok('有記錄用量', tokens > 0);
  console.log(`  合計 ${tokens.toLocaleString()} tokens（以 DeepSeek 價格粗算，這次測試約 HK$0.0x 級）`);

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  真實模型測試：通過 ${pass} 項，失敗 ${fail} 項`);
  console.log('='.repeat(56) + '\n');
} catch (e) {
  fail++;
  console.error('\n測試過程出錯：', e);
} finally {
  cleanup();
}
