// 端對端測試：真的開一個伺服器、真的走完整流程（不 mock HTTP）。
// 執行：node test/e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(HERE, '.tmp-data');

// 1x1 PNG，用來測試相片上載
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const sleeps = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

async function call(method, p, body, cookie) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, AI_MODE: 'mock' },
  stdio: 'ignore'
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 未啟動 */ }
    await sleeps(200);
  }
  return false;
}

function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
  setTimeout(() => {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(fail ? 1 : 0);
  }, 400);
}

try {
  console.log('\n啟動測試伺服器（port ' + PORT + '，資料放在 test/.tmp-data）…');
  if (!await waitReady()) throw new Error('伺服器 3 秒內沒有啟動');

  console.log('\n[1] 健康檢查與靜態檔');
  const h = await call('GET', '/api/health');
  ok('health 回傳 ok', h.status === 200 && h.data.ok === true, JSON.stringify(h.data));
  ok('模式為 mock（未配置 key）', h.data.aiMode === 'mock');
  const page = await fetch(BASE + '/');
  ok('首頁 HTML 可載入', page.status === 200 && (await page.text()).includes('AI 批改作業平臺'));

  console.log('\n[2] 老師登入與作業');
  const tLogin = await call('POST', '/api/login', { login_id: 'teacher', password: '1234' });
  ok('老師登入成功', tLogin.status === 200 && tLogin.data.user.role === 'teacher', JSON.stringify(tLogin.data));
  const tCookie = tLogin.cookie;
  ok('錯誤密碼被拒', (await call('POST', '/api/login', { login_id: 'teacher', password: 'wrong' })).status === 401);

  const list = await call('GET', '/api/assignments', undefined, tCookie);
  ok('種子作業存在（1 份）', list.data.assignments?.length === 1, JSON.stringify(list.data).slice(0, 120));
  const asg = list.data.assignments[0];
  ok('作業總分 12', asg.total_score === 12, String(asg.total_score));
  ok('示範作業指定了 6A（不是全校可見）', JSON.stringify(asg.class_names) === JSON.stringify(['6A']), JSON.stringify(asg.class_names));

  console.log('\n[3] 學生註冊（名單核對）');
  const look = await call('POST', '/api/lookup', { student_no: '2025003' });
  ok('查名回傳 6A / 03', look.data.class_name === '6A' && look.data.class_no === '03');
  const badReg = await call('POST', '/api/register', { student_no: '2025004', name: '錯名', class_name: '6A', password: 'abcd' });
  ok('姓名不符 → 拒絕註冊', badReg.status === 400, JSON.stringify(badReg.data));
  const badReg2 = await call('POST', '/api/register', { student_no: '9999999', name: '外人', class_name: '6A', password: 'abcd' });
  ok('名單外號碼 → 拒絕註冊', badReg2.status === 400);
  const reg = await call('POST', '/api/register', { student_no: '2025003', name: '周詠彤', class_name: '6a', password: 'abcd' });
  ok('名單內學生註冊成功（班別大小寫不拘）', reg.status === 200 && reg.data.user.class_no === '03', JSON.stringify(reg.data));
  const sCookie = reg.cookie;
  const dup = await call('POST', '/api/register', { student_no: '2025003', name: '周詠彤', class_name: '6A', password: 'abcd' });
  ok('重複註冊 → 409', dup.status === 409);

  console.log('\n[4] 學生提交作業（文字＋相片）');
  const sList = await call('GET', '/api/assignments', undefined, sCookie);
  ok('學生看到 1 份作業', sList.data.assignments?.length === 1);
  const detail = await call('GET', '/api/assignments/' + asg.id, undefined, sCookie);
  ok('題目 3 題', detail.data.assignment.questions.length === 3);
  ok('作答前沒有提交記錄', detail.data.my === null);
  const sub = await call('POST', `/api/assignments/${asg.id}/submit`, {
    answers: [
      { no: '1', mode: 'photo', text: '', images: [PNG] },
      { no: '2', mode: 'typed', text: 'I rewrote "hot" to "burning", because it shows the heat more strongly.', images: [] },
      { no: '3', mode: 'typed', text: 'I am least happy with the last sentence. I would add a simile like "the sea was as calm as glass".', images: [] }
    ]
  }, sCookie);
  ok('提交成功', sub.status === 200 && sub.data.submission.status === 'submitted', JSON.stringify(sub.data).slice(0, 160));
  ok('相片已記錄', sub.data.submission.files.length === 1, JSON.stringify(sub.data.submission.files));
  const img = await fetch(BASE + sub.data.submission.files[0].url, { headers: { Cookie: sCookie } });
  ok('學生可以取回自己的相片', img.status === 200 && img.headers.get('content-type') === 'image/png');
  const imgNoAuth = await fetch(BASE + sub.data.submission.files[0].url);
  ok('未登入不能取相片', imgNoAuth.status === 401);

  console.log('\n[5] 權限邊界');
  const forbidden = await call('GET', '/api/roster', undefined, sCookie);
  ok('學生不能看名單 API', forbidden.status === 403);
  const noAuth = await call('GET', '/api/assignments');
  ok('未登入不能看作業 API', noAuth.status === 401);

  console.log('\n[6] AI 預批（模擬模式）');
  const tSubs = await call('GET', `/api/assignments/${asg.id}/submissions`, undefined, tCookie);
  ok('老師看到 1 份提交', tSubs.data.submissions?.length === 1);
  const sid = tSubs.data.submissions[0].id;
  const ai = await call('POST', `/api/submissions/${sid}/ai`, {}, tCookie);
  ok('AI 預批回傳結果', ai.status === 200 && ai.data.submission.ai !== null, JSON.stringify(ai.data).slice(0, 160));
  ok('AI 模式標記為 mock', ai.data.mode === 'mock');
  ok('AI 分數逐點對齊評分點（3 題）', ai.data.submission.ai.questions.length === 3);
  ok('AI 帶有「模擬」警告 flag', JSON.stringify(ai.data.submission.ai.flags).includes('模擬'));

  console.log('\n[7] 老師定分並發還');
  const grade = await call('POST', `/api/submissions/${sid}/grade`, {
    scores: { 1: { score: 5, comment: '三個形容詞和一個比喻都用了' }, 2: { score: 2.5, comment: '改寫合理，解釋清楚' }, 3: { score: 2.5, comment: '反思具體，可再寫出完整句子' } },
    comment: '描述具體，形容詞用得好；第 3 題可以把改寫的句子完整寫出來。',
    notes: '下次課堂跟進溶解概念',
    return: true
  }, tCookie);
  ok('發還成功', grade.status === 200 && grade.data.submission.status === 'returned', JSON.stringify(grade.data).slice(0, 160));
  ok('總分合計 10', grade.data.submission.teacher_total === 10, String(grade.data.submission.teacher_total));
  const over = await call('POST', `/api/submissions/${sid}/grade`, {
    scores: { 1: { score: 99 }, 2: { score: 2.5 }, 3: { score: 2.5 } },
    return: false
  }, tCookie);
  ok('超額分數被夾到滿分', over.data.submission.teacher_scores.questions[0].score === 6, JSON.stringify(over.data.submission.teacher_scores.questions[0]));
  ok('只改分數不會清掉評語', String(over.data.submission.teacher_comment).includes('描述具體'));

  console.log('\n[8] 學生看結果與提問');
  const mine = await call('GET', `/api/assignments/${asg.id}/my`, undefined, sCookie);
  ok('學生看到已發還狀態', mine.data.submission.status === 'returned');
  ok('學生看到總分', mine.data.submission.teacher_total !== null);
  ok('學生看到老師評語', String(mine.data.submission.teacher_comment).includes('描述具體'));
  ok('學生看不到老師的內部備註', mine.data.submission.teacher_notes === undefined);
  const q = await call('POST', `/api/submissions/${sid}/question`, { text: '第 2 題我寫了理由，為甚麼只得 2.5 分？' }, sCookie);
  ok('學生可以提問', q.status === 200);
  const after = await call('GET', `/api/assignments/${asg.id}/my`, undefined, sCookie);
  ok('狀態轉為已提問', after.data.submission.status === 'questioned');
  const reply = await call('POST', `/api/submissions/${sid}/reply`, { reply: '你寫了理由，但未寫出改寫後的效果，補上就滿分。' }, tCookie);
  ok('老師可以回覆', reply.status === 200);

  console.log('\n[9] 重新提交（覆蓋舊版本）');
  const resub = await call('POST', `/api/assignments/${asg.id}/submit`, {
    answers: [{ no: '1', mode: 'typed', text: 'Salt disappeared.', images: [] }]
  }, sCookie);
  ok('已發還的作業不能直接重交', resub.status === 400, JSON.stringify(resub.data));

  console.log('\n[10] 統計與匯出');
  const stats = await call('GET', `/api/assignments/${asg.id}/stats`, undefined, tCookie);
  ok('統計回傳 1 份提交', stats.data.submitted === 1);
  ok('統計有平均分', stats.data.avg !== null, String(stats.data.avg));
  ok('統計有知識點分析', stats.data.perTag.length >= 3);
  ok('AI 與老師分差有計算', stats.data.ai.compared === 1);
  const csv = await fetch(BASE + `/api/assignments/${asg.id}/export.csv`, { headers: { Cookie: tCookie } });
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  const csvText = new TextDecoder('utf-8').decode(csvBytes);
  // Excel 需要 UTF-8 BOM 才不會把中文變成亂碼，這裡在 byte 層驗
  ok('CSV 可匯出且含 UTF-8 BOM', csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF);
  ok('CSV 含學生姓名與分數欄', csvText.includes('周詠彤') && csvText.includes('第1題'));
  console.log('\n      CSV 表頭：' + csvText.split('\r\n')[0].replace(/^\uFEFF/, ''));

  console.log('\n[11] 老師管理功能');
  const imp = await call('POST', '/api/roster/import', { csv: '班別,學號,姓名,學生證號碼\n6A,13,測試新同學,2025099' }, tCookie);
  ok('名單匯入（自動略過表頭）', imp.data.added === 1 && imp.data.skipped === 1, JSON.stringify(imp.data));
  const roster = await call('GET', '/api/roster', undefined, tCookie);
  const target = roster.data.roster.find((r) => r.student_no === '2025003');
  ok('名單標記 2025003 已註冊', target.claimed === true);
  const reset = await call('POST', `/api/roster/${target.id}/reset-password`, {}, tCookie);
  ok('可以重設學生密碼', reset.status === 200 && /^[0-9]{4}a$/.test(reset.data.temp_password), JSON.stringify(reset.data));
  const relogin = await call('POST', '/api/login', { login_id: '2025003', password: reset.data.temp_password });
  ok('用臨時密碼可以登入', relogin.status === 200);
  const change = await call('POST', '/api/change-password', { old_password: reset.data.temp_password, new_password: 'newpass' }, relogin.cookie);
  ok('學生可以自行改密碼', change.status === 200);

  console.log('\n[12] 作業建立與校驗');
  const badAsg = await call('POST', '/api/assignments', { title: '空作業', questions: [] }, tCookie);
  ok('沒有題目 → 拒絕', badAsg.status === 400);
  const badPoint = await call('POST', '/api/assignments', { title: '壞評分點', questions: [{ prompt: 'x', points: [{ desc: '', score: 0 }] }] }, tCookie);
  ok('評分點分數 0 → 拒絕', badPoint.status === 400);
  const newAsg = await call('POST', '/api/assignments', {
    title: '測試作業', class_name: '6A', due_at: new Date(Date.now() + 864e5).toISOString(),
    questions: [{ no: '1', tag: '科學解釋', type: 'text', prompt: '水是甚麼？', points: [{ id: '1-1', desc: '說出水的形態', score: 2 }, { id: '1-2', desc: '舉出一個例子', score: 2 }] }]
  }, tCookie);
  ok('建立作業成功且總分自動計算', newAsg.status === 200 && newAsg.data.id > 0);
  const getNew = await call('GET', '/api/assignments/' + newAsg.data.id, undefined, tCookie);
  ok('新作業總分 4', getNew.data.assignment.total_score === 4);
  const del = await call('DELETE', '/api/assignments/' + newAsg.data.id, undefined, tCookie);
  ok('沒有提交的作業可以刪除', del.status === 200);
  const delSeed = await call('DELETE', '/api/assignments/' + asg.id, undefined, tCookie);
  ok('已有提交的作業不能刪除', delSeed.status === 400);

  console.log('\n[13] 作文雙通道與 AI 端點（模擬模式下的行為）');
  const subDetail = await call('GET', '/api/submissions/' + sid, undefined, tCookie);
  const ans1 = subDetail.data.submission.answers.find((x) => String(x.q_no) === '1');
  ok('第 1 題記錄為「拍照」通道', ans1.mode === 'photo', JSON.stringify({ mode: ans1.mode }));
  ok('拍照題有轉寫欄位（模擬模式為空）', ans1.transcript === '' || ans1.transcript === null);
  ok('轉寫記錄了信心值', typeof ans1.transcript_confidence === 'number');
  const tr = await call('POST', `/api/submissions/${sid}/transcribe`, { q_no: '1' }, tCookie);
  ok('可以重新觸發轉寫', tr.status === 200, JSON.stringify(tr.data).slice(0, 120));
  const corr = await call('POST', `/api/submissions/${sid}/correct`, { q_no: '1', text: 'My Favourite Place\nLast summer I went to Cheung Chau.' }, tCookie);
  ok('老師可以修正轉寫稿', corr.status === 200);
  const afterCorr = await call('GET', '/api/submissions/' + sid, undefined, tCookie);
  const a1b = afterCorr.data.submission.answers.find((x) => String(x.q_no) === '1');
  ok('修正後 final_text 採用修正稿', String(a1b.final_text).includes('Cheung Chau'), a1b.final_text);
  const noFile = await call('POST', `/api/submissions/${sid}/transcribe`, { q_no: '2' }, tCookie);
  ok('沒有相片的題目不能轉寫', noFile.status === 400);

  const cd = await call('POST', `/api/submissions/${sid}/comment-draft`, { scores: { 1: { score: 5 }, 2: { score: 2.5 }, 3: { score: 2.5 } } }, tCookie);
  ok('評語草稿端點可用（模擬模式回示範文字）', cd.status === 200 && typeof cd.data.comment === 'string');
  const ask = await call('POST', `/api/submissions/${sid}/ask`, { q_no: '1' }, sCookie);
  ok('學生提問端點存在（模擬模式回 502 並說明）', ask.status === 502, JSON.stringify(ask.data).slice(0, 120));
  const askOther = await call('POST', `/api/submissions/${sid}/ask`, { q_no: '1' }, tCookie);
  ok('老師不能用學生的提問端點（非本人）', askOther.status === 403);
  const insightRes = await call('GET', `/api/assignments/${asg.id}/insight`, undefined, tCookie);
  ok('班級分析端點存在（模擬模式回 502）', insightRes.status === 502);
  const sug = await call('POST', '/api/ai/suggest', { subject: '小學英文', level: '小六', topic: 'A Descriptive Paragraph' }, tCookie);
  ok('出題助手端點存在（模擬模式回 502）', sug.status === 502);
  const sugStudent = await call('POST', '/api/ai/suggest', { topic: 'x' }, sCookie);
  ok('學生不能使用出題助手', sugStudent.status === 403);
  const usage = await call('GET', '/api/ai/usage', undefined, tCookie);
  ok('AI 用量端點可用', usage.status === 200 && Array.isArray(usage.data.byKind));
  console.log('\n[14] 學習畫像與錯題精煉');
  const prog = await call('GET', `/api/students/${(await call('GET', '/api/me', undefined, sCookie)).data.user.id}/progress`, undefined, sCookie);
  ok('學生可以看自己的學習記錄', prog.status === 200 && Array.isArray(prog.data.tags), JSON.stringify(prog.data).slice(0, 150));
  ok('知識點有得分率', prog.data.tags.every((t) => t.avg === null || typeof t.avg === 'number'));
  ok('資料不足時會標明', prog.data.enoughData === false, '作業次數 ' + prog.data.overall.n);
  const progTeacher = await call('GET', `/api/students/${(await call('GET', '/api/me', undefined, sCookie)).data.user.id}/progress`, undefined, tCookie);
  ok('老師可以看指定學生的學習記錄', progTeacher.status === 200);
  const progOther = await call('GET', '/api/students/1/progress', undefined, sCookie);
  ok('學生不能看別人的學習記錄', progOther.status === 403);

  const mis = await call('GET', '/api/practice/mistakes', undefined, sCookie);
  ok('錯題清單可用', mis.status === 200 && Array.isArray(mis.data.tags), JSON.stringify(mis.data).slice(0, 150));
  ok('錯題有累計失分', mis.data.tags.length === 0 || mis.data.tags.every((t) => typeof t.lost === 'number'));
  const misTeacher = await call('GET', '/api/practice/mistakes', undefined, tCookie);
  ok('老師不能使用學生錯題清單', misTeacher.status === 403);

  if (mis.data.tags.length) {
    const tag = mis.data.tags[0].tag;
    const gen = await call('POST', '/api/practice/generate', { tag, count: 3 }, sCookie);
    ok('生成練習（模擬模式回 502 並說明）', gen.status === 502, JSON.stringify(gen.data).slice(0, 120));
    ok('生成練習需要登入', (await call('POST', '/api/practice/generate', { tag })).status === 401);
  } else {
    ok('（沒有扣分記錄，跳過生成練習測試）', true);
  }
  const pracList = await call('GET', '/api/practice', undefined, sCookie);
  ok('練習列表可用', pracList.status === 200 && Array.isArray(pracList.data.items));
  const pracTeacher = await call('GET', '/api/practice', undefined, tCookie);
  ok('老師不能使用學生練習列表', pracTeacher.status === 403);
  console.log('\n[15] 一個老師帶三個班（4A／4B／4C）');
  const imp2 = await call('POST', '/api/roster/import', {
    csv: '班別,學號,姓名,學生證號碼\n4A,01,李小明,2026001\n4A,02,陳大文,2026002\n4B,01,黃小玲,2026003\n4B,02,張家希,2026004\n4C,01,吳映彤,2026005'
  }, tCookie);
  ok('可以一次匯入多個班別的名单', imp2.status === 200 && imp2.data.added === 5, JSON.stringify(imp2.data));

  const cls = await call('GET', '/api/classes', undefined, tCookie);
  ok('班別清單包含 4A/4B/4C', ['4A', '4B', '4C'].every((c) => cls.data.classes.some((x) => x.class_name === c)),
    JSON.stringify(cls.data.classes.map((x) => x.class_name)));
  const c4a = cls.data.classes.find((x) => x.class_name === '4A');
  ok('班別有姓名單人數', c4a.roster === 2 && c4a.registered === 0, JSON.stringify(c4a));

  // 註冊 4A 與 4C 各一個學生
  const regA = await call('POST', '/api/register', { student_no: '2026001', name: '李小明', class_name: '4A', password: 'abcd' });
  const regC = await call('POST', '/api/register', { student_no: '2026005', name: '吳映彤', class_name: '4C', password: 'abcd' });
  ok('4A 與 4C 學生各自註冊', regA.status === 200 && regC.status === 200);

  // 一份作業同時派給 4A + 4B
  const multi = await call('POST', '/api/assignments', {
    title: '多班測試作業', subject: '小學英文', class_names: ['4A', '4B'],
    due_at: new Date(Date.now() + 864e5).toISOString(),
    questions: [{ no: '1', tag: '測試', type: 'text', prompt: '寫一句英文。', points: [{ id: '1-1', desc: '有動詞', score: 2 }] }]
  }, tCookie);
  ok('可以建立「一份作業派多個班」', multi.status === 200 && multi.data.class_names.length === 2, JSON.stringify(multi.data));

  const listA = await call('GET', '/api/assignments', undefined, regA.cookie);
  const listC = await call('GET', '/api/assignments', undefined, regC.cookie);
  ok('4A 學生看到這份作業', listA.data.assignments.some((a) => a.id === multi.data.id));
  ok('4C 學生看不到（未派給 4C）', !listC.data.assignments.some((a) => a.id === multi.data.id));

  const tList = await call('GET', '/api/assignments', undefined, tCookie);
  const multiRow = tList.data.assignments.find((a) => a.id === multi.data.id);
  ok('老師列表回傳兩個班', JSON.stringify(multiRow.class_names) === '["4A","4B"]', JSON.stringify(multiRow.class_names));
  ok('分母是兩班人數合計', multiRow.class_size === 4, String(multiRow.class_size));

  const noPerm = await call('GET', '/api/assignments/' + multi.data.id, undefined, regC.cookie);
  ok('4C 學生直接開這份作業被拒', noPerm.status === 403);
  const submitC = await call('POST', `/api/assignments/${multi.data.id}/submit`, { answers: [{ no: '1', text: 'x', images: [] }] }, regC.cookie);
  ok('4C 學生不能提交這份作業', submitC.status === 403);

  const submitA = await call('POST', `/api/assignments/${multi.data.id}/submit`, { answers: [{ no: '1', text: 'The cat sat.', images: [] }] }, regA.cookie);
  ok('4A 學生可以提交', submitA.status === 200);
  await call('POST', `/api/submissions/${submitA.data.submission.id}/grade`, { scores: { 1: { score: 2 } }, comment: '好', return: true }, tCookie);

  const mstats = await call('GET', `/api/assignments/${multi.data.id}/stats`, undefined, tCookie);
  ok('統計有逐班比較', Array.isArray(mstats.data.per_class) && mstats.data.per_class.length === 2, JSON.stringify(mstats.data.per_class));
  ok('逐班比較有各自平均分', mstats.data.per_class.find((c) => c.class_name === '4A').avg === 2);
  ok('學生成績帶班別', mstats.data.students[0].class_name === '4A', JSON.stringify(mstats.data.students[0]));

  const patch = await call('PATCH', '/api/assignments/' + multi.data.id, { class_names: ['4C'] }, tCookie);
  ok('可以改派給另一班', patch.status === 200);
  const listC2 = await call('GET', '/api/assignments', undefined, regC.cookie);
  ok('改派後 4C 學生看到了', listC2.data.assignments.some((a) => a.id === multi.data.id));
  const listA2 = await call('GET', '/api/assignments', undefined, regA.cookie);
  ok('改派後 4A 學生看不到了', !listA2.data.assignments.some((a) => a.id === multi.data.id));
  console.log('\n[16] 新作業提示與截止提醒');
  const regNew = await call('POST', '/api/register', { student_no: '2025005', name: '何思穎', class_name: '6A', password: 'abcd' });
  ok('新學生註冊（用來測提示）', regNew.status === 200);
  const sNew = regNew.cookie;

  const n1 = await call('GET', '/api/notices', undefined, sNew);
  ok('未看過就有新作業提示', n1.status === 200 && n1.data.new.length >= 1, JSON.stringify(n1.data).slice(0, 160));
  ok('提示帶作業標題與截止', n1.data.new[0].title && 'due_at' in n1.data.new[0]);

  const nTeacher = await call('GET', '/api/notices', undefined, tCookie);
  ok('老師不會收到學生提示', nTeacher.status === 200 && nTeacher.data.new.length === 0);

  const ack = await call('POST', '/api/notices/ack', { ids: n1.data.new.map((x) => x.id) }, sNew);
  ok('可以按「知道了」記下已讀', ack.status === 200 && ack.data.acked === n1.data.new.length);
  const n2 = await call('GET', '/api/notices', undefined, sNew);
  ok('已讀後不再彈同一份', n2.data.new.length === 0, JSON.stringify(n2.data.new));

  // 24 小時內截止
  const soon = await call('POST', '/api/assignments', {
    title: '快截止作業', subject: '小學英文', class_names: ['6A'],
    due_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    questions: [{ no: '1', tag: '測試', type: 'text', prompt: 'x', points: [{ id: '1-1', desc: 'y', score: 2 }] }]
  }, tCookie);
  const n3 = await call('GET', '/api/notices', undefined, sNew);
  ok('24 小時內截止會出現提醒', n3.data.due_soon.some((x) => x.id === soon.data.id), JSON.stringify(n3.data.due_soon));
  ok('同一份也算新作業', n3.data.new.some((x) => x.id === soon.data.id));
  ok('提醒有小時數', n3.data.due_soon.find((x) => x.id === soon.data.id).hours > 0);

  // 打開作業＝已看過
  await call('GET', '/api/assignments/' + soon.data.id, undefined, sNew);
  const n4 = await call('GET', '/api/notices', undefined, sNew);
  ok('打開作業後不再算新', !n4.data.new.some((x) => x.id === soon.data.id), JSON.stringify(n4.data.new));
  ok('但仍然會提醒快截止', n4.data.due_soon.some((x) => x.id === soon.data.id));

  // 已逾期
  const late = await call('POST', '/api/assignments', {
    title: '已逾期作業', subject: '小學英文', class_names: ['6A'],
    due_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), allow_late: true,
    questions: [{ no: '1', tag: '測試', type: 'text', prompt: 'x', points: [{ id: '1-1', desc: 'y', score: 2 }] }]
  }, tCookie);
  const n5 = await call('GET', '/api/notices', undefined, sNew);
  ok('逾期未交會標示出來', n5.data.overdue.some((x) => x.id === late.data.id), JSON.stringify(n5.data.overdue));
  ok('逾期有小時數', n5.data.overdue.find((x) => x.id === late.data.id).hours >= 1);

  // 交了就不再提醒
  await call('POST', `/api/assignments/${late.data.id}/submit`, { answers: [{ no: '1', text: 'done', images: [] }] }, sNew);
  const n6 = await call('GET', '/api/notices', undefined, sNew);
  ok('提交後不再提醒同一份', !n6.data.overdue.some((x) => x.id === late.data.id), JSON.stringify(n6.data.overdue));
  console.log(`\n${'='.repeat(52)}`);
  console.log(`  通過 ${pass} 項，失敗 ${fail} 項`);
  console.log('='.repeat(52) + '\n');
} catch (e) {
  fail++;
  console.error('\n測試過程出錯：', e);
} finally {
  cleanup();
}
