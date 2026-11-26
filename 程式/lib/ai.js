// AI 層。
//
// 實測結論（2026-11-26，用真實 key）：
//   deepseek-flash     → 看得見圖片，手寫英文轉寫逐字準確（保留原拼寫錯誤），2–3 秒
//   deepseek-v4-pro    → 看不到圖片，只適合純文字任務
// 兩者都是推理模型：內容分 message.content 與 message.reasoning_content，
// reasoning 也計 token，所以 max_tokens 要給得夠（本檔預設 4000）。
//
// 所有函式都回傳 {ok:true, ...} 或 {ok:false, error}，不拋例外——
// 老師的批改頁不應該因為 API 出錯而白屏。
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 核心呼叫

export function makeClient(cfg) {
  const ai = cfg.ai;

  async function chat({ messages, maxTokens, temperature, jsonMode = true, model, tag = '' }) {
    if (ai.effectiveMode === 'mock') return { ok: false, error: 'MOCK', mock: true };
    const body = {
      model: model || ai.model,
      messages,
      max_tokens: maxTokens || ai.maxTokens,
      temperature: temperature ?? ai.temperature,
      stream: false
    };
    if (jsonMode && ai.jsonMode !== false) body.response_format = { type: 'json_object' };

    const url = ai.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    let lastError = '';
    const started = Date.now();

    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        const text = await resp.text();
        if (resp.status === 429 || resp.status >= 500) {
          lastError = `AI 接口返回 ${resp.status}`;
          await sleep(600 * (attempt + 1));
          continue;
        }
        if (!resp.ok) {
          return { ok: false, error: `AI 接口返回 ${resp.status}：${text.slice(0, 300)}`, ms: Date.now() - started };
        }
        const j = JSON.parse(text);
        const msg = j.choices?.[0]?.message || {};
        const content = String(msg.content || '');
        const usage = j.usage || {};
        if (!content.trim()) {
          const reason = j.choices?.[0]?.finish_reason;
          return {
            ok: false,
            error: reason === 'length'
              ? '模型把 token 用盡在推理上，沒有輸出結果（可調高 maxTokens）'
              : '模型沒有輸出內容',
            model: j.model, usage, ms: Date.now() - started
          };
        }
        return { ok: true, content, model: j.model || body.model, usage, ms: Date.now() - started, tag };
      } catch (e) {
        lastError = e.name === 'AbortError' ? 'AI 接口超時' : e.message;
        if (attempt === 2) break;
        await sleep(500);
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: `呼叫 AI 失敗：${lastError}`, ms: Date.now() - started };
  }

  // 取 JSON：模型偶爾會包代碼框或前後加字，這裡做容錯；
  // 推理模型還有一個坑——reasoning 用盡 max_tokens 時 content 會是空的，
  // 所以遇到「length」就自動加倍再試一次。
  async function chatJson(opts) {
    let r = await chat(opts);
    if (!r.ok && /token 用盡|length/i.test(r.error || '')) {
      r = await chat({ ...opts, maxTokens: Math.min(16000, (opts.maxTokens || ai.maxTokens) * 2) });
    }
    if (!r.ok) return r;
    const parsed = extractJson(r.content);
    if (!parsed) {
      return { ok: false, error: 'AI 回覆不是合法 JSON', raw: r.content.slice(0, 600), usage: r.usage, ms: r.ms };
    }
    return { ...r, data: parsed };
  }

  return { chat, chatJson, ai };
}

export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 繼續 */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch { /* 放棄 */ }
  }
  return null;
}

function imagePart(absPath, mime) {
  const buf = fs.readFileSync(absPath);
  return { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}` } };
}

// ------------------------------------------------------------------ 1. 手寫轉寫

const TRANSCRIBE_SYSTEM = `你是手寫轉寫員，只做一件事：把學生手寫的內容逐字轉寫成文字。

最重要的一條：學生寫錯的地方，你要照樣寫錯。
- 原文寫 "droped"，你就寫 "droped"，不可以寫成 "dropped"。
- 原文寫 "I very happy"，你就寫 "I very happy"，不可以改成 "I am very happy"。
- 原文漏了標點、大小寫錯了，一律照原樣。
你的工作不是幫學生改作業，是把他寫的字如實記錄下來。改正了，老師就看不到他真正的錯處。

其他規則：
1. 不要加入任何評價、說明或額外標題，只輸出學生寫的字。
2. 保留原本的換行。
3. 看不清楚的字寫成 [?]，並在 uncertain 列出你猜是甚麼。
4. 圖片空白或看不到文字時，transcript 留空，並在 notes 說明。
5. notes 只用來描述影像問題（陰影、裁切、反光），不是評價。

輸出前自我檢查一次：我的轉寫是否與圖片逐字一致？有沒有不小心把某個錯字改對了？如果有，改回去。

只輸出 JSON：{"transcript":"逐字內容","uncertain":["..."],"confidence":0到1,"notes":"影像問題，可留空"}`;

export async function transcribeImage(client, { absPath, mime, subjectHint }) {
  const hint = subjectHint ? `這是一份${subjectHint}作業。` : '';
  const r = await client.chatJson({
    tag: 'transcribe',
    temperature: 0,
    maxTokens: 3000,
    messages: [
      { role: 'system', content: TRANSCRIBE_SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: `${hint}請把圖片中學生手寫的全部內容逐字轉寫。` },
        imagePart(absPath, mime)
      ] }
    ]
  });
  if (r.mock) {
    return { ok: true, mock: true, transcript: '', uncertain: [], confidence: 0, notes: '模擬模式：未連接模型，無法辨識手寫' };
  }
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    transcript: String(d.transcript ?? '').slice(0, 8000),
    uncertain: Array.isArray(d.uncertain) ? d.uncertain.map(String).slice(0, 20) : [],
    confidence: clamp(Number(d.confidence) || 0, 0, 1),
    notes: String(d.notes ?? '').slice(0, 300),
    usage: r.usage, ms: r.ms, model: r.model
  };
}

// ------------------------------------------------------------------ 2. 逐點預批

const GRADE_SYSTEM = `你是一位香港小學老師的批改助手。你的工作只有一件：按老師提供的評分點，為學生作答逐點評分。

規則（必須全部遵守）：
1. 只能使用題目中提供的評分點 id 與該點滿分，不得新增、合併、拆分或改寫評分點。
2. 每點給 0 至該點滿分之間的分數，最小單位 0.5 分。
3. 每點必須寫 evidence：直接引用學生原文（用「」括住），或描述你在圖片中看見的具體內容。給不出依據就給 0，並在 flags 說明。
4. 若學生以手寫相片提交，你會同時收到轉寫稿與圖片。若轉寫稿註明「老師已修正」，以修正稿為準；若轉寫稿與圖片明顯不符，以圖片為準並在 flags 指出。
5. 字跡或圖片模糊、答案有兩種解讀、或你不確定時，把該題 confidence 設為 0.5 或以下，並在 flags 寫「需老師覆核：第X題 —— 原因」。
6. 不要因為字數多就給高分，不要憑印象加分，不要寫「很好」「繼續努力」這類空泛評語。
7. 遇到拼寫／文法類的評分點，只在該點範圍內指出問題，不要順便改正全文。
8. 注意：系統的轉寫稿偶爾會無意中把學生的錯字改對。凡涉及拼寫的評分點，一律以圖片為準，不要單憑轉寫稿判定「拼寫正確」。
9. comment 用繁體中文、香港小學用語，具體寫出「做到甚麼／未做到甚麼」，每題不超過 70 字。
10. 只輸出 JSON，不要 markdown 代碼框。

JSON 結構：
{"questions":[{"no":"題號","confidence":0到1,"comment":"...","points":[{"id":"評分點id","awarded":數字,"evidence":"..."}]}],"flags":["..."],"summary":"全份 1-2 句總結（繁體）"}`;

// 把模型輸出對齊到老師的評分點。
// 模型不一定完全照格式：可能用 question/qno 代替 no、用物件代替陣列、
// 用 score/marks 代替 awarded。這裡全部容忍，但只接受老師定義過的 id，
// 分數一律夾在 0..該點滿分。真的對不上就報錯，不會靜默給 0 分。
export function normalizeResult(raw, questions) {
  const flags = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(src.flags)) flags.push(...src.flags.map(String));
  const norm = (v) => String(v ?? '').replace(/[^0-9A-Za-z-]/g, '');

  // questions 可能是陣列，也可能是 {"1": {...}} 這種物件
  let list = [];
  if (Array.isArray(src.questions)) list = src.questions;
  else if (Array.isArray(src)) list = src;
  else if (src.questions && typeof src.questions === 'object') {
    list = Object.entries(src.questions).map(([k, v]) => ({ no: k, ...(v && typeof v === 'object' ? v : {}) }));
  }

  const byNo = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = norm(item.no ?? item.question ?? item.qno ?? item.number ?? item.q);
    if (key) byNo.set(key, item);
  }

  const pointEntries = (q) => {
    const p = q?.points ?? q?.point ?? q?.items ?? q?.rubric;
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') {
      return Object.entries(p).map(([k, v]) => (v && typeof v === 'object' ? { id: k, ...v } : { id: k, awarded: v }));
    }
    return [];
  };

  const out = [];
  let total = 0;
  let maxTotal = 0;
  let matchedAny = false;
  const confidences = [];

  for (const q of questions) {
    const key = norm(q.no);
    const rq = byNo.get(key) || {};
    if (byNo.has(key)) matchedAny = true;
    const rpoints = new Map();
    for (const p of pointEntries(rq)) {
      const pid = norm(p.id ?? p.point ?? p.point_id ?? p.pointId ?? p.name);
      if (pid) rpoints.set(pid, p);
    }
    const points = [];
    let qScore = 0;
    for (const p of q.points || []) {
      const rp = rpoints.get(norm(p.id));
      if (!rp) flags.push(`需老師覆核：第${q.no}題 評分點 ${p.id} 模型沒有給出結果，已暫記 0 分`);
      const raw = rp ? (rp.awarded ?? rp.score ?? rp.marks ?? rp.given ?? rp.value) : 0;
      const awarded = rp ? roundHalf(clamp(Number(raw) || 0, 0, p.score)) : 0;
      qScore += awarded;
      points.push({
        id: p.id, desc: p.desc, max: p.score, awarded,
        evidence: rp ? (String(rp.evidence ?? rp.reason ?? rp.ev ?? '').slice(0, 400) || '（模型沒有寫依據）') : '（模型未提供依據）'
      });
    }
    maxTotal += q.max;
    total += qScore;
    const conf = clamp(Number(rq.confidence ?? rq.conf ?? 0.6), 0, 1);
    confidences.push(conf);
    if (conf < 0.5) flags.push(`需老師覆核：第${q.no}題 模型自評信心偏低（${conf}）`);
    out.push({
      no: q.no, tag: q.tag || '', max: q.max, score: roundHalf(qScore), confidence: conf,
      comment: String(rq.comment ?? rq.note ?? '').slice(0, 300), points
    });
  }

  if (!matchedAny) {
    const err = new Error('模型回覆的結構與評分點對不上（找不到任何題號）');
    err.structureMismatch = true;
    throw err;
  }

  return {
    questions: out,
    total: roundHalf(total),
    max: maxTotal,
    confidence: confidences.length ? Math.min(...confidences) : 0,
    flags: [...new Set(flags)],
    summary: String(src.summary ?? src.overall ?? '').slice(0, 500)
  };
}
export async function gradeSubmission(client, { assignment, studentName, className, answers, filesByQ, questions }) {
  const lines = [];
  lines.push(`【作業】${assignment.title}（${assignment.subject || ''} ${assignment.class_name || ''}）`);
  if (assignment.description) lines.push(`【老師說明】${assignment.description}`);
  lines.push(`【學生】${className || ''} ${studentName}`);
  lines.push('');
  lines.push('【題目與評分點】');
  for (const q of questions) {
    lines.push(`第 ${q.no} 題（滿分 ${q.max} 分，知識點：${q.tag || '未分類'}）`);
    lines.push(`  題目：${q.prompt}`);
    for (const p of q.points || []) lines.push(`  ${p.id}（${p.score} 分）：${p.desc}`);
  }
  lines.push('');
  lines.push('【學生作答】');
  for (const q of questions) {
    const a = answers.find((x) => String(x.q_no) === String(q.no));
    const text = (a?.final_text || a?.answer_text || '').trim();
    const imgs = filesByQ.get(String(q.no)) || [];
    lines.push(`第 ${q.no} 題：${text ? text : '（學生沒有提供文字）'}${a?.transcript_note ? `（${a.transcript_note}）` : ''}`);
    if (imgs.length) lines.push(`  （另有 ${imgs.length} 張學生手寫／作品照片，見下）`);
  }

  const parts = [{ type: 'text', text: lines.join('\n') }];
  for (const q of questions) {
    for (const f of (filesByQ.get(String(q.no)) || []).slice(0, 3)) {
      if (f.mime === 'application/pdf') continue;
      try {
        parts.push({ type: 'text', text: `↑ 第 ${q.no} 題的學生照片` });
        parts.push(imagePart(f.absPath, f.mime));
      } catch { /* 讀不到就跳過 */ }
    }
  }

  const r = await client.chatJson({
    tag: 'grade',
    temperature: 0,
    maxTokens: 6000,
    messages: [
      { role: 'system', content: GRADE_SYSTEM },
      { role: 'user', content: parts }
    ]
  });
  if (r.mock) return { ok: true, mode: 'mock', mock: true, result: mockGrade({ questions, answers }) };
  if (!r.ok) return r;

  let result;
  try {
    result = normalizeResult(r.data, questions);
  } catch (e) {
    // 對不上就不要硬給 0 分——那是最壞的結果（老師會以為 AI 覺得學生全錯）
    return {
      ok: false,
      error: e.message + '，請重試一次',
      raw: r.content.slice(0, 1500),
      usage: r.usage, ms: r.ms
    };
  }
  return {
    ok: true, mode: 'live', model: r.model, usage: r.usage, ms: r.ms,
    result, raw: r.content.slice(0, 1200)
  };
}

// ------------------------------------------------------------------ 3. 寫評語

const COMMENT_SYSTEM = `你是一位香港小學老師，正在寫作業評語給學生看。

規則：
1. 繁體中文、香港小學用語，語氣溫和而具體。
2. 80 至 120 字，一段過，不要分段。
3. 結構：先講一件做得好的事（要具體，引用學生寫過的內容或做法）→ 指出一個最值得改進的地方（要具體、可行動）→ 一句鼓勵（不要空泛）。
4. 不要逐題重複，要綜合整份作業。
5. 不要用「尚可」「有待改善」「繼續努力」這類空話。
6. 不要提「AI」「系統」「模型」。
7. 直接輸出評語本身，不要 JSON、不要標題、不要引號。`;

export async function draftComment(client, { assignment, studentName, gradedQuestions, scores }) {
  const lines = [`作業：${assignment.title}（${assignment.subject || ''}）`, `學生：${studentName}`];
  lines.push(`總分：${scores.total} / ${scores.max}`);
  for (const q of gradedQuestions) {
    const pts = (q.points || []).map((p) => `${p.awarded}/${p.max} ${p.desc}`).join('；');
    lines.push(`第 ${q.no} 題 ${q.score}/${q.max}：${pts}${q.comment ? `｜短評：${q.comment}` : ''}`);
  }
  // 評語是純文字，不強制 JSON：曾經因為推理佔用 token 導致 JSON 被截斷而失敗
  const r = await client.chat({
    tag: 'comment',
    temperature: 0.3,
    maxTokens: 2200,
    jsonMode: false,
    messages: [
      { role: 'system', content: COMMENT_SYSTEM },
      { role: 'user', content: lines.join('\n') + '\n\n請寫一段整體評語。' }
    ]
  });
  if (r.mock) return { ok: true, mock: true, comment: '（模擬模式：未連接模型。老師請自行撰寫評語。）' };
  if (!r.ok) return r;
  const text = String(r.content || '').trim().replace(/^["「]|["」]$/g, '').trim();
  if (!text) return { ok: false, error: '模型沒有輸出評語' };
  return { ok: true, comment: text.slice(0, 1200), usage: r.usage, ms: r.ms };
}

// ------------------------------------------------------------------ 4. 出題助手

const SUGGEST_SYSTEM = `你是香港小學老師的備課助手。根據老師給的課題，草擬一份作業。

規則：
1. 用繁體中文（英文科則用英文出題，評分點仍用繁體）。
2. 每題 2 至 4 個評分點，全份總分 15 至 20 分。
3. 每個評分點必須「可判斷」——做到就得分，做不到就 0 分。不要用「完整」「清楚」「正確」這類沒有標準的詞，要寫出構成完整的要素。
4. 題型要多樣：概念解釋、應用、分析、反思，至少一題要學生動手或舉例。
5. tag 用簡短知識點名稱（4 至 8 字），同一份作業內不要重複超過兩次。
6. type 只可以是 "text"（打字）、"text_photo"（文字＋拍照）、"photo"（只需拍照）、"essay"（作文，學生可選打字或拍照）。
7. 難度要符合老師指定的年級。

只輸出 JSON：
{"title":"作業名稱","description":"給學生看的說明（2 句）","questions":[{"no":"1","tag":"知識點","type":"text","prompt":"題目","points":[{"id":"1-1","desc":"評分點","score":2}]}]}`;

export async function suggestAssignment(client, { subject, level, topic, notes, count = 4 }) {
  const r = await client.chatJson({
    tag: 'suggest',
    temperature: 0.5,
    maxTokens: 5000,
    messages: [
      { role: 'system', content: SUGGEST_SYSTEM },
      { role: 'user', content: `科目：${subject}\n年級：${level}\n課題：${topic}\n題數：${count} 題\n${notes ? '老師補充：' + notes : ''}\n\n請草擬這份作業。` }
    ]
  });
  if (r.mock) return { ok: false, error: '未配置 API Key，無法使用出題助手' };
  if (!r.ok) return r;
  return { ok: true, data: r.data, usage: r.usage, ms: r.ms };
}

// ------------------------------------------------------------------ 5. 班級洞察

const INSIGHT_SYSTEM = `你是教學分析助手，正在幫香港小學老師看一份作業的班級數據。

規則：
1. 繁體中文，150 至 220 字，寫成三段（每段之間換行），不要標題。
2. 第一段：指出最弱的知識點，引用具體數字（得分率）。
3. 第二段：推測原因，要結合題目與評分點具體說明，不要泛泛而談。
4. 第三段：提出下一堂 10 至 15 分鐘可以做的具體補救活動（講明老師做甚麼、學生做甚麼）。
5. 不要重複表格已有的數字清單，不要說「整體表現理想」這類空話。
6. 三段之後，另起一行寫「建議重教：」後面接一個 8 字以內的重點。
7. 直接輸出文字，不要 JSON。`;

export async function classInsight(client, { assignment, stats }) {
  const lines = [
    `作業：${assignment.title}（${assignment.subject || ''} ${assignment.class_name || ''}，滿分 ${assignment.total_score}）`,
    `提交 ${stats.submitted} 人，已批 ${stats.graded} 人，平均 ${stats.avg} 分。`
  ];
  for (const q of stats.perQuestion) {
    lines.push(`第 ${q.no} 題（${q.tag}，滿分 ${q.max}）：平均 ${q.avg}，得分率 ${q.rate}%`);
  }
  lines.push('知識點得分率：' + stats.perTag.map((t) => `${t.tag} ${t.rate}%`).join('、'));
  const r = await client.chat({
    tag: 'insight',
    temperature: 0.3,
    maxTokens: 3000,
    jsonMode: false,
    messages: [
      { role: 'system', content: INSIGHT_SYSTEM },
      { role: 'user', content: lines.join('\n') + '\n\n請寫出分析。' }
    ]
  });
  if (r.mock) return { ok: false, error: '未配置 API Key' };
  if (!r.ok) return r;
  const text = String(r.content || '').trim();
  if (!text) return { ok: false, error: '模型沒有輸出分析' };
  const m = text.match(/建議重教[：:]\s*(.+)/);
  const focus = m ? m[1].trim().split('\n')[0].slice(0, 20) : '';
  const insight = m ? text.replace(m[0], '').trim() : text;
  return { ok: true, insight, focus, usage: r.usage, ms: r.ms };
}

// ------------------------------------------------------------------ 6. 學生追問（嚴格有據）

const ASK_SYSTEM = `你是協助小學生理解評分的助手。你只能根據提供的資料回答。

規則：
1. 只根據「老師評語」「該題評分點」「學生自己的答案」「老師給的分數」回答。
2. 不可以改分，不可以批評老師的判斷。如果學生認為分數有誤，提醒他按「向老師提問」。
3. 資料不足以回答時，直接說「這一點要問老師」，不要猜。
4. 繁體中文，語氣溫和，像老師對小學生講話，100 字內。
5. 直接輸出回答，不要 JSON、不要標題。`;

export async function askAboutFeedback(client, { assignment, question, studentAnswer, teacherComment, score, max, points }) {
  const lines = [
    `作業：${assignment.title}`,
    `題目：${question.prompt}`,
    `學生答案：${studentAnswer || '（沒有文字）'}`,
    `老師給分：${score} / ${max}`,
    `評分點：${(points || []).map((p) => `${p.desc}（${p.max} 分）`).join('；')}`,
    `老師評語：${teacherComment || '（沒有）'}`
  ];
  const r = await client.chat({
    tag: 'ask',
    temperature: 0.2,
    maxTokens: 2000,
    jsonMode: false,
    messages: [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: lines.join('\n') + '\n\n學生問：為甚麼這題是這個分數？' }
    ]
  });
  if (r.mock) return { ok: false, error: '未配置 API Key' };
  if (!r.ok) return r;
  const answer = String(r.content || '').trim();
  if (!answer) return { ok: false, error: '模型沒有輸出回答' };
  return { ok: true, answer: answer.slice(0, 600), usage: r.usage, ms: r.ms };
}

// ------------------------------------------------------------------ 7. 錯題精煉

const PRACTICE_GEN_SYSTEM = `你是香港小學老師，正在為一個學生設計「針對弱點」的練習。

規則：
1. 只針對提供的弱點與知識點出題，不要出其他範圍。
2. 每題只有一個明確答案，學生 1 分鐘內可以完成（短答一句、填空、改寫句子）。
3. 情境要與原題不同，不要照抄原題；但考核的能力要一樣。
4. expected 寫出「做到甚麼才算對」，1 至 3 點，必須可判斷。
5. model_answer 給一個示範答案（不是唯一答案）。
6. 難度由淺入深：第 1 題最直接，第 3 題要應用。
7. 指示用繁體中文；英文科的題目本身用英文。
只輸出 JSON：{"items":[{"prompt":"...","expected":["..."],"model_answer":"...","hint":"一句提示"}]}`;

export async function generatePractice(client, { subject, level, tag, weakPoints, sourceQuestions, studentAnswer, count = 3 }) {
  const lines = [
    `科目：${subject || '小學英文'}　年級：${level || '小六'}`,
    `知識點：${tag}`,
    '',
    '【學生未做到的評分點】'
  ];
  for (const w of weakPoints) lines.push(`- ${w.desc}（${w.max} 分，實得 ${w.awarded ?? 0}）`);
  if (sourceQuestions?.length) {
    lines.push('', '【原題（只作參考，不要照抄）】');
    for (const q of sourceQuestions.slice(0, 2)) lines.push(`- ${q.prompt}`);
  }
  if (studentAnswer) lines.push('', '【學生原本的答案（看得出弱在哪裡）】', String(studentAnswer).slice(0, 600));
  lines.push('', `請出 ${count} 題針對這個弱點的練習。`);

  const r = await client.chatJson({
    tag: 'practice-gen',
    temperature: 0.5,
    maxTokens: 3000,
    messages: [
      { role: 'system', content: PRACTICE_GEN_SYSTEM },
      { role: 'user', content: lines.join('\n') }
    ]
  });
  if (r.mock) return { ok: false, error: '未配置 API Key，無法生成練習' };
  if (!r.ok) return r;
  const items = (Array.isArray(r.data.items) ? r.data.items : [])
    .filter((x) => x && x.prompt)
    .slice(0, count)
    .map((x) => ({
      prompt: String(x.prompt).slice(0, 600),
      expected: (Array.isArray(x.expected) ? x.expected : []).map(String).slice(0, 4),
      model_answer: String(x.model_answer ?? '').slice(0, 600),
      hint: String(x.hint ?? '').slice(0, 200)
    }));
  if (!items.length) return { ok: false, error: '模型沒有生成有效題目' };
  return { ok: true, items, usage: r.usage, ms: r.ms };
}

const PRACTICE_JUDGE_SYSTEM = `你是小學老師，判斷學生這道練習是否做到。

規則：
1. 按 expected 逐點判斷；做到大部分要點就算 correct。
2. 拼寫／文法小錯，除非題目本身考這一點，否則不當錯。
3. feedback 用繁體中文、具體寫出「你做到了甚麼／還欠甚麼」，60 字內，語氣溫和。
4. verdict 只可以是 correct / partial / wrong。
5. tip 是一句下次要記住的話（可留空）。
只輸出 JSON：{"verdict":"correct","feedback":"...","tip":"..."}`;

export async function judgePractice(client, { item, answer }) {
  const lines = [
    `題目：${item.prompt}`,
    `要達到的（expected）：${(item.expected || []).join('；')}`,
    `示範答案：${item.model_answer || '（無）'}`,
    `學生答案：${answer}`
  ];
  const r = await client.chatJson({
    tag: 'practice-check',
    temperature: 0,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: PRACTICE_JUDGE_SYSTEM },
      { role: 'user', content: lines.join('\n') + '\n\n請判斷。' }
    ]
  });
  if (r.mock) return { ok: false, error: '未配置 API Key' };
  if (!r.ok) return r;
  const v = String(r.data.verdict || '').toLowerCase();
  return {
    ok: true,
    verdict: ['correct', 'partial', 'wrong'].includes(v) ? v : 'partial',
    feedback: String(r.data.feedback ?? '').slice(0, 400),
    tip: String(r.data.tip ?? '').slice(0, 200),
    usage: r.usage, ms: r.ms
  };
}

// ------------------------------------------------------------------ 工具

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function roundHalf(n) { return Math.round(n * 2) / 2; }

export function mockGrade({ questions, answers }) {
  const flags = ['模擬模式：未連接 AI 模型，以下分數只為演示流程，不可用作真實評分'];
  const out = questions.map((q) => {
    const a = answers.find((x) => String(x.q_no) === String(q.no));
    const len = (a?.final_text || a?.answer_text || '').trim().length;
    const ratio = len === 0 ? 0 : clamp(0.4 + Math.min(len, 160) / 400, 0.4, 0.8);
    const points = (q.points || []).map((p) => ({
      id: p.id, desc: p.desc, max: p.score,
      awarded: roundHalf(p.score * ratio),
      evidence: len ? '（模擬模式：僅依作答字數粗略給分，未理解內容）' : '（學生未作答）'
    }));
    return {
      no: q.no, tag: q.tag || '', max: q.max,
      score: roundHalf(points.reduce((s, p) => s + p.awarded, 0)),
      confidence: 0.2, comment: '模擬評分，請老師自行批改。', points
    };
  });
  return {
    questions: out,
    total: roundHalf(out.reduce((s, q) => s + q.score, 0)),
    max: out.reduce((s, q) => s + q.max, 0),
    confidence: 0.2, flags, summary: '模擬模式輸出：未連接 AI 模型。'
  };
}
