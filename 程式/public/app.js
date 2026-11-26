// 前端：無框架、無 build step，一個檔案。介面文字用繁體（香港小學生／老師用）。
const SITE = 'AI 批改作業平臺';
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');

let ME = null;
let META = { aiMode: 'mock', model: '', vision: false };
let DRAFT = null;          // 新建／編輯作業時的草稿
let ANSWERS = null;        // 學生作答中的暫存
let TEACHER_SCORES = null; // 批改中的暫存

// ------------------------------------------------------------------ 工具
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast ' + kind; }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || '請求失敗（' + res.status + '）');
    err.data = data;
    throw err;
  }
  return data;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-HK', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-HK', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const STATUS = { submitted: '已提交', ai_graded: 'AI 已預批', returned: '已發還', questioned: '已提問' };
const badge = (s) => `<span class="badge ${s}">${STATUS[s] || s}</span>`;
const qTypeLabel = (t) => ({ text: '文字作答', photo: '只需拍照', text_photo: '文字＋拍照' }[t] || t);

async function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('讀取檔案失敗'));
    r.readAsDataURL(file);
  });
}

// 上載前先在瀏覽器壓縮：學校 WiFi 上傳 8MB 原圖會很慢，1600px 已足夠看手寫字
async function prepareImage(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 4 * 1024 * 1024) throw new Error('PDF 檔案過大（上限 4MB）');
    return fileToDataURL(file);
  }
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    const raw = await fileToDataURL(file);
    if (raw.length > 7 * 1024 * 1024) throw new Error('這張相片無法壓縮（可能是 HEIC 格式），請用 JPG 或 PNG');
    return raw;
  }
}

// ------------------------------------------------------------------ 頂欄
function renderTop() {
  if (!ME) { topbar.innerHTML = ''; return; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const at = (k) => (parts[0] === k ? 'active' : '');
  const nav = ME.role === 'teacher'
    ? `<a href="#/" class="${at('') || (parts.length === 0 ? 'active' : '')}">作業</a>
       <a href="#/roster" class="${at('roster')}">學生名單</a>
       <a href="#/account" class="${at('account')}">帳戶</a>`
    : `<a href="#/" class="${parts.length === 0 ? 'active' : ''}">我的作業</a>
       <a href="#/learn" class="${at('learn')}">我的學習</a>
       <a href="#/account" class="${at('account')}">帳戶</a>`;
  topbar.innerHTML = `
    <div class="brand">${esc(SITE)}<small>試用版</small></div>
    <nav>${nav}</nav>
    <span class="who">${esc(ME.name)}${ME.class_name ? ' · ' + esc(ME.class_name) : ''}</span>
    <button class="small ghost" id="logout" style="color:#fff;border-color:rgba(255,255,255,.4);background:transparent">登出</button>`;
  $('#logout').onclick = async () => {
    await api('/api/logout', { method: 'POST', body: '{}' });
    ME = null;
    location.hash = '#/login';
    render();
  };
}

// ------------------------------------------------------------------ 登入
function viewLogin(tab = 'student') {
  topbar.innerHTML = '';
  app.innerHTML = `
  <div class="auth">
    <div class="auth-card">
      <h1>${esc(SITE)}</h1>
      <p class="muted small">小學英文 · 校內試用版</p>
      <div class="tabs">
        <button class="tab ${tab === 'student' ? 'active' : ''}" data-tab="student">學生登入</button>
        <button class="tab ${tab === 'teacher' ? 'active' : ''}" data-tab="teacher">老師登入</button>
        <button class="tab ${tab === 'register' ? 'active' : ''}" data-tab="register">首次註冊</button>
      </div>
      <div id="auth-panel"></div>
    </div>
  </div>`;
  $$('.tab').forEach((b) => { b.onclick = () => viewLogin(b.dataset.tab); });
  const panel = $('#auth-panel');

  if (tab === 'student' || tab === 'teacher') {
    const isStudent = tab === 'student';
    panel.innerHTML = `
      <label class="field"><span>${isStudent ? '學生證號碼' : '老師用戶名'}</span>
        <input type="text" id="login-id" autocomplete="username" placeholder="${isStudent ? '例如 2025001' : 'teacher'}"></label>
      <label class="field"><span>密碼</span>
        <input type="password" id="login-pw" autocomplete="current-password"></label>
      <button class="primary" id="do-login" style="width:100%">登入</button>
      ${isStudent ? '<p class="small muted" style="margin-top:14px">忘記密碼？請找老師在「學生名單」替你重設。</p>' : ''}`;
    const go = async () => {
      try {
        const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ login_id: $('#login-id').value.trim(), password: $('#login-pw').value }) });
        ME = r.user;
        await refreshMeta();
        location.hash = '#/';
        render();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#do-login').onclick = go;
    panel.querySelectorAll('input').forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') go(); }; });
    return;
  }

  // 註冊
  panel.innerHTML = `
    <p class="small muted">輸入學生證號碼，系統會核對老師匯入的名單。不需要電郵。</p>
    <label class="field"><span>學生證號碼</span>
      <input type="text" id="reg-sid" placeholder="例如 2025001"></label>
    <div id="reg-info" class="small" style="margin:-4px 0 12px"></div>
    <label class="field"><span>姓名（與名單相同）</span><input type="text" id="reg-name"></label>
    <div class="grid two" style="gap:12px">
      <label class="field"><span>班別</span><input type="text" id="reg-class" placeholder="例如 5B"></label>
      <label class="field"><span>學號</span><input type="text" id="reg-no" placeholder="例如 01"></label>
    </div>
    <label class="field"><span>設定密碼（最少 4 個字元）</span><input type="password" id="reg-pw"></label>
    <label class="field"><span>再輸入一次密碼</span><input type="password" id="reg-pw2"></label>
    <button class="primary" id="do-register" style="width:100%">註冊並登入</button>`;

  $('#reg-sid').onblur = async () => {
    const sid = $('#reg-sid').value.trim();
    if (!sid) return;
    try {
      const r = await api('/api/lookup', { method: 'POST', body: JSON.stringify({ student_no: sid }) });
      $('#reg-class').value = r.class_name;
      $('#reg-no').value = r.class_no;
      $('#reg-info').innerHTML = r.claimed
        ? '<span class="badge late">這個號碼已註冊</span> 如為本人，請直接登入；忘記密碼請找老師。'
        : '<span class="badge open">名單核對成功</span> 請輸入姓名並設定密碼。';
    } catch (e) {
      $('#reg-info').innerHTML = '<span class="badge late">' + esc(e.message) + '</span>';
    }
  };

  $('#do-register').onclick = async () => {
    const pw = $('#reg-pw').value, pw2 = $('#reg-pw2').value;
    if (pw !== pw2) return toast('兩次輸入的密碼不相同', 'err');
    try {
      const r = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          student_no: $('#reg-sid').value.trim(), name: $('#reg-name').value.trim(),
          class_name: $('#reg-class').value.trim(), class_no: $('#reg-no').value.trim(), password: pw
        })
      });
      ME = r.user;
      await refreshMeta();
      toast('註冊成功，歡迎 ' + ME.name, 'ok');
      location.hash = '#/';
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function refreshMeta() {
  try {
    const m = await api('/api/me');
    META = { aiMode: m.aiMode, model: m.model, vision: m.vision };
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ 學生：作業列表
// 截止提醒：橙色橫幅（已逾期在前，再來是 24 小時內）
function dueBannerHtml(n) {
  if (!n) return '';
  const items = [
    ...(n.overdue || []).map((x) => ({ ...x, overdue: true })),
    ...(n.due_soon || [])
  ];
  if (!items.length) return '';
  return `<div class="banner due">
    <b>⏰ 要交了</b>
    ${items.map((x) => `<a href="#/a/${x.id}" style="color:inherit"><b>${esc(x.title)}</b></a>${x.overdue
      ? `<span class="due-tag">已逾期 ${x.hours >= 24 ? Math.round(x.hours / 24) + ' 天' : x.hours + ' 小時'}</span>`
      : `<span class="due-tag">還有 ${x.hours < 1 ? Math.round(x.hours * 60) + ' 分鐘' : x.hours + ' 小時'}</span>`}`).join('<br>')}
  </div>`;
}

async function viewStudentHome() {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const [{ assignments }, notices] = await Promise.all([
    api('/api/assignments'),
    api('/api/notices').catch(() => null)
  ]);
  const todo = assignments.filter((a) => !a.my);
  const done = assignments.filter((a) => a.my);
  const card = (a) => `
    <a class="assignment" href="#/a/${a.id}">
      <div class="title">${esc(a.title)}</div>
      <div class="meta">
        <span>${esc(a.subject || '')} · ${esc(a.class_name || '')}</span>
        <span>共 ${a.question_count} 題 · ${a.total_score} 分</span>
        <span>截止：${fmtTime(a.due_at)}</span>
      </div>
      <div class="row" style="margin-top:8px">
        ${a.my ? badge(a.my.status) : (a.late ? '<span class="badge late">已過截止</span>' : '<span class="badge draft">未提交</span>')}
        ${a.my && a.my.teacher_total !== null ? `<span class="badge returned">得分 ${a.my.teacher_total} / ${a.total_score}</span>` : ''}
      </div>
    </a>`;
  app.innerHTML = `
    <div class="page-head"><div class="grow"><h1>我的作業</h1>
      <p class="muted small">${esc(ME.class_name || '')} · ${esc(ME.name)}</p></div></div>
    ${dueBannerHtml(notices)}
    <h2 style="font-size:16px;margin-top:0">待完成（${todo.length}）</h2>
    <div class="grid">${todo.length ? todo.map(card).join('') : '<div class="empty-state"><div class="big">🎉</div>沒有待完成的作業</div>'}</div>
    <h2 style="font-size:16px;margin-top:26px">已提交（${done.length}）</h2>
    <div class="grid">${done.length ? done.map(card).join('') : '<p class="muted small">還沒有提交記錄</p>'}</div>`;
}

// ------------------------------------------------------------------ 學生：作答／看成績
async function viewAssignment(id) {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const { assignment: a, my } = await api('/api/assignments/' + id);
  const qs = a.questions;
  const isStudent = ME.role === 'student';

  if (isStudent && my && (my.status === 'returned' || my.status === 'questioned')) {
    return renderStudentResult(a, my);
  }

  // 已提交但未發還
  if (isStudent && my) {
    const canResubmit = a.status === 'open';
    app.innerHTML = `
      <div class="page-head"><div class="grow">
        <a href="#/" class="small">← 返回</a>
        <h1>${esc(a.title)}</h1>
        <p class="muted small">${esc(a.subject || '')} · ${esc(a.class_name || '')} · 共 ${a.total_score} 分</p>
      </div></div>
      <div class="card">
        <div class="row">${badge(my.status)} <span class="muted small">提交時間：${fmtTime(my.submitted_at)}</span>
          ${my.late ? '<span class="badge late">遲交</span>' : ''}</div>
        <p style="margin-top:14px">功課已交給老師，等老師批改後就會看到分數和評語。</p>
        ${canResubmit ? '<p class="small muted">如果交錯了，可以在截止前重新提交（會覆蓋舊的版本）。</p>' : ''}
        <div class="row" style="margin-top:10px">
          ${canResubmit ? '<button class="ghost" id="resubmit">重新提交</button>' : ''}
        </div>
      </div>`;
    if (canResubmit) {
      $('#resubmit').onclick = () => {
        ANSWERS = {};
        for (const q of qs) {
          const ans = my.answers.find((x) => String(x.q_no) === String(q.no));
          ANSWERS[q.no] = {
            text: ans?.answer_text || '',
            mode: ans?.mode || 'typed',
            images: my.files.filter((f) => String(f.q_no) === String(q.no)).map((f) => ({ url: f.url, existing: true }))
          };
        }
        renderAnswerForm(a, true);
      };
    }
    return;
  }

  ANSWERS = {};
  for (const q of qs) ANSWERS[q.no] = { text: '', mode: 'typed', images: [] };
  renderAnswerForm(a, false);
}

function renderAnswerForm(a, isResubmit) {
  const qs = a.questions;
  const main = document.createElement('div');
  main.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/" class="small">← 返回</a>
      <h1>${esc(a.title)}</h1>
      <p class="muted small">${esc(a.subject || '')} · ${esc(a.class_name || '')} · 共 ${qs.length} 題 ${a.total_score} 分 · 截止 ${fmtTime(a.due_at)}</p>
    </div></div>
    ${a.description ? `<div class="card tight"><b>老師說明</b><p class="small" style="margin-bottom:0">${esc(a.description)}</p></div>` : ''}
    ${a.late ? '<div class="banner">已過截止時間，現在提交會標記為「遲交」。</div>' : ''}
    <div class="card" id="qform"></div>
    <div class="row end"><button class="ghost" onclick="history.back()">取消</button>
      <button class="primary" id="submit-work">${isResubmit ? '重新提交' : '確認提交'}</button></div>`;
  app.innerHTML = '';
  app.appendChild(main);

  const form = $('#qform');
  // 每一題的作答介面。essay（作文）多一條「打字／拍照」通道選擇。
  form.innerHTML = qs.map((q) => {
    const mode = ANSWERS[q.no].mode || 'typed';
    const isEssay = q.type === 'essay';
    const showText = q.type !== 'photo';
    const textHidden = isEssay && mode === 'photo';
    const photoHidden = isEssay && mode === 'typed';
    return `
    <div class="question" data-no="${esc(q.no)}">
      <div class="q-head"><span class="q-no">${esc(q.no)}</span>
        <span class="q-prompt" style="flex:1">${esc(q.prompt)}</span>
        ${isEssay ? '<span class="badge ai">可選打字或拍照</span>' : ''}</div>
      <div class="hints"><b>評分重點（老師會看這些）</b>
        <ul>${(q.points || []).map((p) => `<li>${esc(p.desc)}</li>`).join('')}</ul>
      </div>
      ${isEssay ? `<div class="row" style="gap:6px;margin-bottom:10px" data-channels="${esc(q.no)}">
        <button class="ch ${mode === 'typed' ? 'on' : ''}" data-ch="typed">⌨️ 打字</button>
        <button class="ch ${mode === 'photo' ? 'on' : ''}" data-ch="photo">📷 拍照</button>
        <span class="small muted" style="margin-left:6px">揀一個你方便的</span>
      </div>` : ''}
      ${showText ? `<div data-pane="typed"${textHidden ? ' style="display:none"' : ''}>
        <textarea data-text="${esc(q.no)}" placeholder="在這裡輸入答案…">${esc(ANSWERS[q.no]?.text || '')}</textarea></div>` : ''}
      <div data-pane="photo"${photoHidden ? ' style="display:none"' : ''}>
        ${isEssay ? '<p class="small muted" style="margin:4px 0 8px">把作文寫在紙上，整頁入鏡、光線充足。提交後系統會自動把字讀出來，你可以核對。</p>' : ''}
        ${q.type === 'photo' ? '<p class="small muted" style="margin:4px 0 8px">這一題需要拍照。</p>' : ''}
        <div class="thumbs" data-thumbs="${esc(q.no)}"></div>
      </div>
      <input type="file" accept="image/*,application/pdf" multiple hidden data-file="${esc(q.no)}">
    </div>`;
  }).join('');

  // 相片縮圖（文字題只給一個小按鈕，避免每題都出現一個大虛線框）
  const drawThumbs = (q) => {
    const no = q.no;
    const box = form.querySelector(`[data-thumbs="${no}"]`);
    const list = ANSWERS[no].images;
    const addBtn = (q.type === 'text' && list.length === 0)
      ? `<button class="small ghost" data-add="${no}">＋ 加相片（可選）</button>`
      : `<div class="upload-tile" data-add="${no}"><div style="font-size:22px">📷</div><div>加相片</div></div>`;
    box.innerHTML = list.map((img, i) => `
      <div class="thumb">
        ${img.url ? `<img src="${img.url}" alt="相片">` : `<img src="${img.data}" alt="相片">`}
        <button data-del="${no}:${i}" title="移除">✕</button>
      </div>`).join('') + addBtn;
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        const [qq, i] = b.dataset.del.split(':');
        ANSWERS[qq].images.splice(Number(i), 1);
        drawThumbs(q);
      };
    });
    box.querySelector('[data-add]').onclick = () => form.querySelector(`[data-file="${no}"]`).click();
  };

  // 打字／拍照切換：只改顯示，不動已輸入的內容
  $$('[data-channels]').forEach((box) => {
    const no = box.dataset.channels;
    box.querySelectorAll('[data-ch]').forEach((b) => {
      b.onclick = () => {
        ANSWERS[no].mode = b.dataset.ch;
        box.querySelectorAll('[data-ch]').forEach((x) => x.classList.toggle('on', x.dataset.ch === b.dataset.ch));
        const card = box.closest('.question');
        const paneT = card.querySelector('[data-pane="typed"]');
        const paneP = card.querySelector('[data-pane="photo"]');
        if (paneT) paneT.style.display = b.dataset.ch === 'typed' ? '' : 'none';
        if (paneP) paneP.style.display = b.dataset.ch === 'photo' ? '' : 'none';
      };
    });
  });

  qs.forEach((q) => {
    drawThumbs(q);
    const ta = form.querySelector(`[data-text="${q.no}"]`);
    if (ta) ta.oninput = () => { ANSWERS[q.no].text = ta.value; };
    const file = form.querySelector(`[data-file="${q.no}"]`);
    file.onchange = async () => {
      for (const f of [...file.files]) {
        try {
          if (ANSWERS[q.no].images.length >= 4) { toast('每題最多 4 張相片', 'err'); break; }
          const data = await prepareImage(f);
          ANSWERS[q.no].images.push({ data });
          drawThumbs(q);
        } catch (e) { toast(e.message, 'err'); }
      }
      file.value = '';
    };
  });

  $('#submit-work').onclick = async (ev) => {
    const btn = ev.target;
    const empty = qs.filter((q) => {
      const x = ANSWERS[q.no];
      const mode = q.type === 'essay' ? (x.mode || 'typed') : (q.type === 'photo' ? 'photo' : 'typed');
      if (mode === 'photo') return x.images.length === 0;
      return !(x.text && x.text.trim()) && x.images.length === 0;
    });
    if (empty.length === qs.length) return toast('請至少回答一題', 'err');
    if (empty.length) {
      if (!confirm(`第 ${empty.map((q) => q.no).join('、')} 題還沒有作答，仍然提交？`)) return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>正在上傳…';
    try {
      const payload = {
        answers: qs.map((q) => ({
          no: q.no,
          mode: q.type === 'essay' ? (ANSWERS[q.no].mode || 'typed') : (q.type === 'photo' ? 'photo' : 'typed'),
          text: ANSWERS[q.no].text,
          images: ANSWERS[q.no].images.filter((x) => x.data).map((x) => x.data)
        }))
      };
      const res = await api('/api/assignments/' + a.id + '/submit', { method: 'POST', body: JSON.stringify(payload) });
      toast(res.transcribed?.length ? '已提交，手寫已轉成文字（' + res.transcribed.join('、') + ' 題）' : '已提交，等老師批改', 'ok');
      location.hash = '#/a/' + a.id;
      render();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '確認提交';
    }
  };
}

function renderStudentResult(a, my) {
  const ts = my.teacher_scores;
  const scores = {};
  for (const q of ts?.questions || []) scores[String(q.no)] = q;
  const total = my.teacher_total ?? 0;
  const pct = Math.round((total / a.total_score) * 1000) / 10;

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/" class="small">← 返回</a>
      <h1>${esc(a.title)}</h1>
      <p class="muted small">${esc(a.subject || '')} · ${esc(a.class_name || '')}</p>
    </div></div>

    <div class="card">
      <div class="row" style="align-items:flex-end; gap:18px">
        <div><div class="muted small">我的得分</div>
          <div style="font-size:44px;font-weight:800;color:var(--brand);line-height:1">${total}<span style="font-size:20px;color:var(--muted)"> / ${a.total_score}</span></div></div>
        <div class="spacer"></div>
        <div class="badge returned" style="font-size:14px;padding:6px 14px">${pct}%</div>
      </div>
      ${my.teacher_comment ? `<div style="margin-top:16px;background:#f8fafc;border-radius:12px;padding:14px"><b>老師評語</b><p style="margin:6px 0 0;white-space:pre-wrap">${esc(my.teacher_comment)}</p></div>` : ''}
      ${my.teacher_notes ? `<div style="margin-top:10px;background:var(--warn-light);border-radius:12px;padding:14px"><b>老師回覆</b><p class="small" style="margin:6px 0 0;white-space:pre-wrap">${esc(my.teacher_notes)}</p></div>` : ''}
      <p class="tiny muted" style="margin-top:14px">發還時間：${fmtTime(my.returned_at)}</p>
    </div>

    <div class="card">
      <h2 style="font-size:16px">逐題得分</h2>
      ${a.questions.map((q) => {
        const s = scores[String(q.no)];
        const mine = my.answers.find((x) => String(x.q_no) === String(q.no));
        const imgs = my.files.filter((f) => String(f.q_no) === String(q.no));
        return `<div class="answer-block">
          <div class="row" style="align-items:flex-start"><span class="q-no">${esc(q.no)}</span>
            <span class="q-prompt" style="flex:1">${esc(q.prompt)}</span>
            <b style="color:var(--brand)">${s ? s.score : 0} / ${q.max}</b></div>
          <div class="answer-text" style="margin-top:8px">${mine?.final_text ? esc(mine.final_text) : '<span class="muted">（沒有文字作答）</span>'}</div>
          ${mine?.mode === 'photo' && mine?.transcript ? `<details style="margin-top:6px"><summary>系統讀到的手寫內容</summary>
            <div class="answer-text" style="margin-top:6px;font-size:14px">${esc(mine.transcript)}</div></details>` : ''}
          ${imgs.length ? imgs.map((f) => `<a href="${f.url}" target="_blank"><img class="photo-view" style="max-width:420px" src="${f.url}" alt="我的相片"></a>`).join('') : ''}
          ${s?.comment ? `<div class="flag" style="background:var(--ok-light);color:#166534;margin-top:10px"><b>老師：</b>${esc(s.comment)}</div>` : ''}
          <div style="margin-top:8px"><button class="small ghost" data-askq="${esc(q.no)}">🤔 為甚麼是這個分數？</button>
            ${q.tag ? `<a class="small" href="#/learn/${encodeURIComponent(q.tag)}" style="margin-left:8px">🎯 針對「${esc(q.tag)}」練習 →</a>` : ''}</div>
          <div class="ask-box" data-answer="${esc(q.no)}" style="display:none"></div>
        </div>`;
      }).join('')}
    </div>

    <div class="card">
      <h2 style="font-size:16px">對分數有疑問？</h2>
      ${my.status === 'questioned'
        ? `<div class="banner">已收到你的提問，老師回覆後會顯示在這裡。你的提問：<br><b>${esc(my.question_text || '')}</b></div>`
        : `<p class="small muted">可以告訴老師你覺得哪一題有疑問，老師會回覆。</p>
           <textarea id="q-text" placeholder="例如：第 3 題我寫了步驟，但沒有被計分…"></textarea>
           <div class="row end" style="margin-top:10px"><button class="ghost" id="send-q">送出提問</button></div>`}
    </div>`;

  // 學生問「為甚麼是這個分數」：只按老師評語與評分點回答，不會改分
  $$('[data-askq]').forEach((b) => {
    b.onclick = async () => {
      const no = b.dataset.askq;
      const box = $(`[data-answer="${no}"]`);
      box.style.display = 'block';
      box.innerHTML = '<span class="small muted"><span class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--brand)"></span>正在看你的答案…</span>';
      try {
        const r = await api('/api/submissions/' + my.id + '/ask', { method: 'POST', body: JSON.stringify({ q_no: no }) });
        box.innerHTML = `<div class="ai-box small">${esc(r.answer)}</div>`;
      } catch (e) {
        box.innerHTML = `<div class="flag">${esc(e.message)}</div>`;
      }
    };
  });

  const btn = $('#send-q');
  if (btn) {
    btn.onclick = async () => {
      const text = $('#q-text').value.trim();
      if (!text) return toast('請先輸入問題', 'err');
      try {
        await api('/api/submissions/' + my.id + '/question', { method: 'POST', body: JSON.stringify({ text }) });
        toast('已送出，等老師回覆', 'ok');
        render();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
}

// ------------------------------------------------------------------ 老師：作業列表
let CLASS_FILTER = '';

async function viewTeacherHome() {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const [{ assignments }, { classes }] = await Promise.all([
    api('/api/assignments'),
    api('/api/classes').catch(() => ({ classes: [] }))
  ]);
  const shown = CLASS_FILTER
    ? assignments.filter((a) => (a.class_names || []).includes(CLASS_FILTER))
    : assignments;

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      <h1>作業</h1><p class="muted small">${assignments.length} 份作業${CLASS_FILTER ? ' · 只看 ' + esc(CLASS_FILTER) : ''}</p></div>
      <div class="row"><a class="small" href="#/roster">管理學生名單 →</a>
        <button class="primary" onclick="location.hash='#/new'">+ 新增作業</button></div>
    </div>
    ${classes.length > 1 ? `<div class="row" style="gap:6px;margin-bottom:14px">
      <button class="ch ${CLASS_FILTER === '' ? 'on' : ''}" data-filter="">全部</button>
      ${classes.map((c) => `<button class="ch ${CLASS_FILTER === c.class_name ? 'on' : ''}" data-filter="${esc(c.class_name)}">${esc(c.class_name)}<span class="tiny" style="margin-left:4px;opacity:.7">${c.registered}/${c.roster}</span></button>`).join('')}
    </div>` : ''}
    ${META.aiMode === 'mock' ? '<div class="banner">目前是<strong>模擬模式</strong>（未設定 API Key）：AI 按鈕只會產生示範分數，不會真正理解內容。詳見 README。</div>' : ''}
    <div class="grid">${shown.map((a) => {
      const cls = (a.class_names || []).length ? a.class_names.join('、') : '未指定班別';
      return `
      <div class="card tight">
        <div class="row">
          <div style="flex:1 1 280px">
            <a href="#/a/${a.id}" style="font-weight:700;font-size:17px">${esc(a.title)}</a>
            <div class="meta small muted">${esc(a.subject || '')} · ${esc(cls)} · ${a.question_count} 題 ${a.total_score} 分 · 截止 ${fmtTime(a.due_at)}</div>
          </div>
          <div class="row">
            <span class="badge ${a.status}">${a.status === 'open' ? '進行中' : a.status === 'draft' ? '草稿' : '已關閉'}</span>
            <span class="badge">提交 ${a.submitted}/${a.class_size}</span>
            <span class="badge ${a.graded ? 'returned' : ''}">已批 ${a.graded}</span>
            <a class="small" href="#/a/${a.id}">進入 →</a>
          </div>
        </div>
      </div>`;
    }).join('') || '<div class="empty-state"><div class="big">📋</div>還沒有作業，按「新增作業」開始</div>'}
    </div>`;

  $$('[data-filter]').forEach((b) => {
    b.onclick = () => { CLASS_FILTER = b.dataset.filter; viewTeacherHome(); };
  });
}

// ------------------------------------------------------------------ 老師：作業詳情
async function viewTeacherAssignment(id) {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const { assignment: a, questions, submissions } = await api('/api/assignments/' + id + '/submissions');
  const ungraded = submissions.filter((s) => !s.has_ai);
  const pending = submissions.filter((s) => !s.graded);

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/" class="small">← 返回</a>
      <h1>${esc(a.title)}</h1>
      <p class="muted small">${esc(a.subject || '')} · ${esc(a.class_name || '')} · ${a.question_count} 題 ${a.total_score} 分 · 截止 ${fmtTime(a.due_at)}</p>
    </div>
    <div class="row">
      <button class="ghost small" onclick="location.hash='#/a/${a.id}/edit'">編輯</button>
      <a class="small" href="#/s/${a.id}">統計分析 →</a>
      <a class="small" href="/api/assignments/${a.id}/export.csv">匯出成績 CSV</a>
    </div>
    </div>

    <div class="card">
      <div class="row">
        <div class="stat-grid" style="flex:1">
          <div class="stat"><div class="v">${submissions.length}<span style="font-size:14px;color:var(--muted)">/${a.class_size ?? '?'}</span></div><div class="k">已提交</div></div>
          <div class="stat"><div class="v">${submissions.filter((s) => s.has_ai).length}</div><div class="k">AI 已預批</div></div>
          <div class="stat"><div class="v">${submissions.filter((s) => s.graded).length}</div><div class="k">老師已定分</div></div>
          <div class="stat"><div class="v">${submissions.filter((s) => s.status === 'returned' || s.status === 'questioned').length}</div><div class="k">已發還</div></div>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="ai" id="batch-ai" ${ungraded.length ? '' : 'disabled'}>AI 預批 ${ungraded.length} 份未批的</button>
        <span class="small muted" id="batch-status"></span>
      </div>
      <p class="tiny muted" style="margin-top:8px">AI 只給「建議分」，最終分數由你決定。每一份都可以逐題改。</p>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>學號</th><th>姓名</th><th>狀態</th><th class="num">AI</th><th class="num">我的分</th><th>提交時間</th><th></th></tr></thead>
        <tbody>
        ${submissions.map((s) => `
          <tr>
            <td>${esc(s.student.class_no || '')}</td>
            <td><b>${esc(s.student.name)}</b></td>
            <td>${badge(s.status)}${s.late ? ' <span class="badge late">遲交</span>' : ''}</td>
            <td class="num">${s.ai_total ?? '—'}</td>
            <td class="num">${s.teacher_total ?? '—'}</td>
            <td class="small muted">${fmtTime(s.submitted_at)}</td>
            <td class="num"><a class="small" href="#/g/${s.id}">${s.graded ? '查看／修改' : '批改'} →</a></td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">還沒有學生提交</td></tr>'}
        </tbody>
      </table>
    </div>`;

  const btn = $('#batch-ai');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      const statusEl = $('#batch-status');
      let done = 0;
      for (const s of ungraded) {
        statusEl.innerHTML = `<span class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--ai)"></span>正在處理 ${done + 1}/${ungraded.length}：${esc(s.student.name)}`;
        try {
          await api('/api/submissions/' + s.id + '/ai', { method: 'POST', body: '{}' });
        } catch (e) {
          toast(`${s.student.name}：${e.message}`, 'err');
        }
        done++;
      }
      statusEl.textContent = `完成 ${done} 份`;
      toast('AI 預批完成', 'ok');
      render();
    };
  }
}

// ------------------------------------------------------------------ 老師：批改
async function viewGrade(sid) {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const { submission: s } = await api('/api/submissions/' + sid);
  const { assignment: a } = await api('/api/assignments/' + s.assignment_id);
  const qs = a.questions;
  const ai = s.ai || null;
  const aiQ = new Map((ai?.questions || []).map((q) => [String(q.no), q]));

  // 老師分數初值：優先用自己上次的，沒有就用 AI 的建議
  TEACHER_SCORES = {};
  for (const q of qs) {
    const mine = s.teacher_scores?.questions?.find((x) => String(x.no) === String(q.no));
    const sug = aiQ.get(String(q.no));
    TEACHER_SCORES[q.no] = {
      score: mine ? mine.score : (sug ? sug.score : 0),
      comment: mine ? (mine.comment || '') : ''
    };
  }

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/a/${a.id}" class="small">← 返回作業</a>
      <h1>${esc(s.student.name)} <span class="muted" style="font-size:16px">${esc(s.student.class_no || '')}</span></h1>
      <p class="muted small">${esc(a.title)} · 提交於 ${fmtTime(s.submitted_at)} ${s.late ? '· <span class="badge late">遲交</span>' : ''}</p>
    </div></div>

    ${ai ? `<div class="card" style="background:var(--ai-light);border-color:#e9d5ff">
      <div class="ai-head"><span class="badge ai">AI 預批</span>
        <span class="small">${esc(s.ai_model || '')} · ${fmtTime(s.ai_at)} · 建議 ${ai.total}/${ai.max} 分 · 信心 ${Math.round((ai.confidence || 0) * 100)}%</span></div>
      ${ai.summary ? `<p class="small" style="margin-bottom:6px">${esc(ai.summary)}</p>` : ''}
      ${(ai.flags || []).map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}
      <p class="tiny" style="margin-bottom:0;opacity:.75">AI 只給建議。逐題看它的依據，再決定給幾分。</p>
    </div>` : `<div class="card"><div class="row"><span class="muted small">這份還沒有 AI 建議。</span>
      <button class="ai small" id="run-ai">執行 AI 預批</button></div></div>`}

    <div class="grade-grid">
      <div>
        <div class="card">
          <h2 style="font-size:16px">學生作答</h2>
          ${qs.map((q) => {
            const mine = s.answers.find((x) => String(x.q_no) === String(q.no));
            const imgs = s.files.filter((f) => String(f.q_no) === String(q.no));
            const isPhoto = mine?.mode === 'photo';
            const conf = mine?.transcript_confidence;
            return `<div class="answer-block">
              <div class="row" style="align-items:flex-start"><span class="q-no">${esc(q.no)}</span>
                <span class="q-prompt" style="flex:1">${esc(q.prompt)}</span>
                ${isPhoto ? '<span class="badge ai">拍照</span>' : ''}
                <span class="badge">${q.max} 分</span></div>
              ${imgs.map((f) => (f.mime === 'application/pdf'
                ? `<p><a href="${f.url}" target="_blank">📄 開啟 PDF</a></p>`
                : `<a href="${f.url}" target="_blank"><img class="photo-view" src="${f.url}" alt="學生相片"></a>`)).join('')}
              ${mine?.answer_text ? `<div class="answer-text" style="margin-top:8px">${esc(mine.answer_text)}</div>` : ''}
              ${isPhoto ? `<div style="margin-top:10px">
                <div class="row small" style="gap:8px">
                  <b>📄 手寫轉寫</b>
                  ${mine?.transcript
                    ? `<span class="badge ${(conf || 0) >= 0.9 ? 'open' : 'late'}">信心 ${Math.round((conf || 0) * 100)}%</span>`
                    : '<span class="badge late">未轉寫</span>'}
                  <span class="spacer"></span>
                  <button class="small ghost" data-retry="${esc(q.no)}">重新辨識</button>
                </div>
                ${mine?.uncertain?.length ? `<div class="flag">系統不確定的字：${esc(mine.uncertain.join('、'))}</div>` : ''}
                ${mine?.transcript_notes ? `<div class="flag">${esc(mine.transcript_notes)}</div>` : ''}
                <textarea data-correct="${esc(q.no)}" style="margin-top:8px;font-size:14px" placeholder="系統讀不到文字，可以自己打（評分會用這裡的內容）">${esc(mine?.corrected_text || mine?.transcript || '')}</textarea>
                <p class="tiny muted" style="margin:4px 0 0">可以直接修改。修改後評分會用你改過的版本（原文仍會保留）。</p>
              </div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>

      <div>
        <div class="card sticky">
          <h2 style="font-size:16px">評分</h2>
          ${qs.map((q) => {
            const sug = aiQ.get(String(q.no));
            return `<div class="answer-block" style="margin-top:0;padding-top:12px">
              <div class="row"><span class="q-no">${esc(q.no)}</span>
                <span class="small" style="flex:1">${esc(q.tag || '')} ${sug ? `· AI 信心 ${Math.round((sug.confidence || 0) * 100)}%` : ''}</span>
                <input class="score-input" type="number" min="0" max="${q.max}" step="0.5" value="${TEACHER_SCORES[q.no].score}" data-score="${esc(q.no)}">
                <span class="small muted">/ ${q.max}</span></div>
              ${sug ? `<div style="margin-top:6px">${(sug.points || []).map((p) => `
                <div class="point"><div><div>${esc(p.desc)}</div>
                  <div class="evidence">AI 依據：${esc(p.evidence)}</div></div>
                  <div class="marks">${p.awarded}/${p.max}</div></div>`).join('')}
                <button class="small ghost" data-adopt="${esc(q.no)}" style="margin-top:6px">採用這題 AI 建議（${sug.score} 分）</button>
                ${sug.comment ? `<div class="evidence" style="margin-top:6px">AI 評語：${esc(sug.comment)}</div>` : ''}
                </div>` : '<p class="tiny muted">沒有 AI 建議，請自行評分。</p>'}
              <input type="text" placeholder="這一題的評語（可留空）" data-comment="${esc(q.no)}" value="${esc(TEACHER_SCORES[q.no].comment)}" style="margin-top:8px;font-size:14px">
            </div>`;
          }).join('')}

          <div class="total-bar"><div class="n" id="total">0</div><div class="muted">/ ${a.total_score} 分</div>
            <div class="spacer"></div>
            ${ai ? '<button class="small ghost" id="adopt-all">全部採用 AI 建議</button>' : ''}</div>

          <label class="field"><span>整體評語（會發還給學生）
            <button class="small ai" id="draft-comment" style="float:right;margin-top:-2px">✨ 幫我寫</button></span>
            <textarea id="overall" placeholder="例如：觀察記錄寫得很詳細；第 3 題的步驟可以再具體一點。">${esc(s.teacher_comment || '')}</textarea></label>
          <label class="field"><span>只給自己看的備註（學生看不到）</span>
            <textarea id="notes" style="min-height:56px">${esc(s.teacher_notes || '')}</textarea></label>

          <div class="row end">
            <button class="ghost" id="save">儲存</button>
            <button class="primary" id="save-return">儲存並發還</button>
          </div>
          ${s.status === 'returned' ? `<p class="tiny muted" style="text-align:right;margin-top:8px">已於 ${fmtTime(s.returned_at)} 發還，可再次修改並重新發還。</p>` : ''}
          ${s.question_text ? `<div class="flag" style="margin-top:12px">學生提問：${esc(s.question_text)}
            <div class="row" style="margin-top:8px"><input type="text" id="reply" placeholder="回覆學生…">
            <button class="small ghost" id="send-reply">回覆</button></div></div>` : ''}
        </div>
      </div>
    </div>`;

  const recalc = () => {
    const total = qs.reduce((sum, q) => sum + (Number(TEACHER_SCORES[q.no].score) || 0), 0);
    $('#total').textContent = Math.round(total * 2) / 2;
  };
  $$('[data-score]').forEach((inp) => {
    inp.oninput = () => {
      const q = qs.find((x) => String(x.no) === inp.dataset.score);
      let v = Number(inp.value) || 0;
      v = Math.min(q.max, Math.max(0, Math.round(v * 2) / 2));
      TEACHER_SCORES[inp.dataset.score].score = v;
      recalc();
    };
    inp.onblur = () => { inp.value = TEACHER_SCORES[inp.dataset.score].score; };
  });
  $$('[data-comment]').forEach((inp) => {
    inp.oninput = () => { TEACHER_SCORES[inp.dataset.comment].comment = inp.value; };
  });

  // 老師修正轉寫稿：離開輸入框時自動儲存（不打断批改節奏）
  $$('[data-correct]').forEach((ta) => {
    let saved = ta.value;
    ta.onblur = async () => {
      if (ta.value === saved) return;
      try {
        await api('/api/submissions/' + sid + '/correct', {
          method: 'POST', body: JSON.stringify({ q_no: ta.dataset.correct, text: ta.value })
        });
        saved = ta.value;
        toast('已儲存修正，下次評分會用這段文字', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  });

  // 重新辨識手寫
  $$('[data-retry]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      b.innerHTML = '<span class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--brand)"></span>辨識中';
      try {
        const r = await api('/api/submissions/' + sid + '/transcribe', {
          method: 'POST', body: JSON.stringify({ q_no: b.dataset.retry })
        });
        const ta = $(`[data-correct="${b.dataset.retry}"]`);
        if (ta) { ta.value = r.transcript || ''; ta.onblur = null; }
        toast('已重新辨識（信心 ' + Math.round((r.confidence || 0) * 100) + '%）', 'ok');
        render();
      } catch (e) {
        toast(e.message, 'err');
        b.disabled = false;
        b.textContent = '重新辨識';
      }
    };
  });

  // 幫我寫評語：用目前分數與 AI 依據草擬，老師再改
  const draftBtn = $('#draft-comment');
  if (draftBtn) draftBtn.onclick = async () => {
    draftBtn.disabled = true;
    draftBtn.innerHTML = '<span class="spinner"></span>寫緊…';
    try {
      const scores = {};
      for (const q of qs) scores[q.no] = { score: TEACHER_SCORES[q.no].score, comment: TEACHER_SCORES[q.no].comment };
      const r = await api('/api/submissions/' + sid + '/comment-draft', {
        method: 'POST', body: JSON.stringify({ scores })
      });
      $('#overall').value = r.comment;
      toast('已草擬評語，記得改成你的語氣', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    draftBtn.disabled = false;
    draftBtn.textContent = '✨ 幫我寫';
  };
  $$('[data-adopt]').forEach((b) => {
    b.onclick = () => {
      const no = b.dataset.adopt;
      const sug = aiQ.get(String(no));
      TEACHER_SCORES[no].score = sug.score;
      const inp = $(`[data-score="${no}"]`);
      if (inp) inp.value = sug.score;
      recalc();
      toast('已採用第 ' + no + ' 題的 AI 建議', 'ok');
    };
  });
  const all = $('#adopt-all');
  if (all) all.onclick = () => {
    for (const q of qs) {
      const sug = aiQ.get(String(q.no));
      if (!sug) continue;
      TEACHER_SCORES[q.no].score = sug.score;
      const inp = $(`[data-score="${q.no}"]`);
      if (inp) inp.value = sug.score;
    }
    recalc();
    toast('已採用全部 AI 建議，記得逐題檢查', 'ok');
  };
  recalc();

  const runAi = $('#run-ai');
  if (runAi) runAi.onclick = async () => {
    runAi.disabled = true;
    runAi.innerHTML = '<span class="spinner"></span>AI 正在看…';
    try {
      await api('/api/submissions/' + sid + '/ai', { method: 'POST', body: '{}' });
      render();
    } catch (e) { toast(e.message, 'err'); runAi.disabled = false; runAi.textContent = '執行 AI 預批'; }
  };

  const save = async (doReturn) => {
    const scores = {};
    for (const q of qs) scores[q.no] = { score: TEACHER_SCORES[q.no].score, comment: TEACHER_SCORES[q.no].comment };
    try {
      await api('/api/submissions/' + sid + '/grade', {
        method: 'POST',
        body: JSON.stringify({
          scores,
          comment: $('#overall').value,
          notes: $('#notes').value,
          return: doReturn
        })
      });
      toast(doReturn ? '已發還給學生' : '已儲存', 'ok');
      if (doReturn) { location.hash = '#/a/' + a.id; render(); }
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#save').onclick = () => save(false);
  $('#save-return').onclick = () => {
    if (!confirm('發還後學生就會看到分數和評語。確定？')) return;
    save(true);
  };
  const reply = $('#send-reply');
  if (reply) reply.onclick = async () => {
    const text = $('#reply').value.trim();
    if (!text) return toast('請輸入回覆內容', 'err');
    try {
      await api('/api/submissions/' + sid + '/reply', { method: 'POST', body: JSON.stringify({ reply: text }) });
      toast('已回覆', 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ------------------------------------------------------------------ 老師：新增／編輯作業
function blankQuestion(i) {
  return { no: String(i + 1), tag: '內容與細節', type: 'text', prompt: '', points: [{ id: `${i + 1}-1`, desc: '', score: 2 }] };
}

function viewEditor(existing) {
  if (!DRAFT) {
    DRAFT = existing
      ? { ...existing, questions: existing.questions.map((q) => ({ ...q, points: q.points.map((p) => ({ ...p })) })) }
      : { title: '', subject: '小學英文', class_name: '6A', class_names: ['6A'], description: '', due_at: new Date(Date.now() + 7 * 864e5).toISOString(), allow_late: true, status: 'open', questions: [blankQuestion(0)] };
  }
  const d = DRAFT;

  const totalOf = (qs) => qs.reduce((s, q) => s + q.points.reduce((x, p) => x + (Number(p.score) || 0), 0), 0);

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/" class="small">← 返回</a>
      <h1>${existing ? '編輯作業' : '新增作業'}</h1>
      <p class="muted small">評分點寫得越具體，AI 的預批就越接近你的判斷。</p>
    </div></div>

    ${existing ? '' : `<div class="card" style="background:linear-gradient(180deg,#faf5ff,#fff);border-color:#e9d5ff">
      <div class="row"><b>✨ AI 出題助手</b><span class="small muted">給它一個課題，草擬題目與評分點，你再改</span></div>
      <div class="grid" style="grid-template-columns:1fr 1fr 2fr;gap:12px;margin-top:10px">
        <label class="field" style="margin:0"><span>科目</span><input type="text" id="gen-subject" value="小學英文" style="width:100%"></label>
        <label class="field" style="margin:0"><span>年級</span><input type="text" id="gen-level" value="小六" style="width:100%"></label>
        <label class="field" style="margin:0"><span>課題</span><input type="text" id="gen-topic" placeholder="例如：A Descriptive Paragraph（形容詞與比喻）" style="width:100%"></label>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ai" id="gen-go">生成草稿</button>
        <span class="small muted" id="gen-status"></span>
      </div>
    </div>`}

    <div class="card">
      <label class="field"><span>作業名稱</span><input type="text" id="f-title" value="${esc(d.title)}" placeholder="例如：單元一 物質的變化 · 實驗記錄"></label>      <div class="grid two" style="gap:12px">
        <label class="field"><span>科目</span><input type="text" id="f-subject" value="${esc(d.subject)}"></label>
        <label class="field"><span>派給哪幾班（可多選）</span><div id="f-classes" class="row" style="gap:8px"><span class="small muted">載入班別…</span></div></label>
        <label class="field"><span>截止時間</span><input type="datetime-local" id="f-due" value="${toLocalInput(d.due_at)}"></label>
        <label class="field"><span>狀態</span>
          <select id="f-status">
            <option value="open" ${d.status === 'open' ? 'selected' : ''}>進行中（學生可見）</option>
            <option value="draft" ${d.status === 'draft' ? 'selected' : ''}>草稿（學生看不到）</option>
            <option value="closed" ${d.status === 'closed' ? 'selected' : ''}>已關閉（不接受提交）</option>
          </select></label>
      </div>
      <label class="field"><span>給學生的說明</span><textarea id="f-desc">${esc(d.description || '')}</textarea></label>
      <label class="row small"><input type="checkbox" id="f-late" ${d.allow_late ? 'checked' : ''} style="width:auto"> 允許遲交（會標記「遲交」）</label>
    </div>

    <div class="row" style="margin-bottom:16px">
      <button class="ghost" id="add-q">+ 新增題目</button>
      <select id="tpl-select" style="width:auto;min-width:240px"><option value="">從範本載入…</option></select>
      <div class="spacer"></div>
      <span class="muted small">總分：<b id="total-preview">${totalOf(d.questions)}</b></span>
    </div>

    <div id="qlist">${d.questions.map((q, qi) => `
      <div class="card" data-qi="${qi}">
        <div class="row" style="margin-bottom:8px">
          <span class="q-no">${qi + 1}</span>
          <b>第 ${qi + 1} 題</b>
          <div class="spacer"></div>
          <button class="small danger" data-delq="${qi}">刪除這題</button>
        </div>
        <div class="grid two" style="gap:12px">
          <label class="field"><span>題號</span><input type="text" data-qf="no" value="${esc(q.no)}"></label>
          <label class="field"><span>知識點（用於班級弱點分析）</span>
            <input type="text" data-qf="tag" value="${esc(q.tag || '')}" placeholder="觀察與記錄 / 科學解釋 / 實驗設計 / 反思"></label>
        </div>
        <label class="field"><span>作答形式</span>
          <select data-qf="type">
            <option value="text" ${q.type === 'text' ? 'selected' : ''}>文字作答</option>
            <option value="essay" ${q.type === 'essay' ? 'selected' : ''}>作文（學生可選打字或拍照）</option>
            <option value="text_photo" ${q.type === 'text_photo' ? 'selected' : ''}>文字＋拍照</option>
            <option value="photo" ${q.type === 'photo' ? 'selected' : ''}>只需拍照</option>
          </select></label>
        <label class="field"><span>題目</span><textarea data-qf="prompt">${esc(q.prompt)}</textarea></label>
        <div class="small muted" style="margin-bottom:6px;font-weight:600">評分點（AI 只會逐點給分）</div>
        ${q.points.map((p, pi) => `
          <div class="row" style="margin-bottom:8px" data-pi="${pi}">
            <input type="text" data-pf="desc" value="${esc(p.desc)}" placeholder="例如：指出鹽粒變小／最後看不見" style="flex:1">
            <input type="number" data-pf="score" value="${p.score}" min="0.5" step="0.5" style="width:80px;text-align:center">
            <span class="small muted">分</span>
            <button class="small ghost" data-delp="${qi}:${pi}">✕</button>
          </div>`).join('')}
        <button class="small ghost" data-addp="${qi}">+ 加評分點</button>
      </div>`).join('')}
    </div>

    <div class="row end" style="margin-top:8px">
      <button class="ghost" onclick="history.back()">取消</button>
      <button class="primary" id="save-assignment">${existing ? '儲存變更' : '建立作業'}</button>
    </div>`;

  // 綁定：全部改動都寫回 DRAFT，不重新渲染（避免打字時失焦）
  const bind = () => {
    $('#f-title').oninput = (e) => { d.title = e.target.value; };
    $('#f-subject').oninput = (e) => { d.subject = e.target.value; };
    // 班別：可多選（4A、4B、4C 派同一份作業）
    if (!Array.isArray(d.class_names)) d.class_names = d.class_name ? [d.class_name] : [];
    api('/api/classes').then(({ classes }) => {
      const box = $('#f-classes');
      if (!box) return;
      if (!classes.length) { box.innerHTML = '<span class="small muted">名單還沒有班別，請先到「學生名單」匯入。</span>'; return; }
      box.innerHTML = classes.map((c) => `<label class="ch" style="cursor:pointer;display:inline-flex;gap:6px;align-items:center">
          <input type="checkbox" data-cls="${esc(c.class_name)}" ${d.class_names.includes(c.class_name) ? 'checked' : ''} style="width:auto">
          <span>${esc(c.class_name)}</span><span class="tiny muted">${c.registered}/${c.roster}</span>
        </label>`).join('') +
        '<button class="small ghost" id="cls-all" type="button">全選</button>';
      box.querySelectorAll('[data-cls]').forEach((cb) => {
        cb.onchange = () => {
          const on = [...box.querySelectorAll('[data-cls]')].filter((x) => x.checked).map((x) => x.dataset.cls);
          d.class_names = on;
          d.class_name = on[0] || null;
        };
      });
      $('#cls-all').onclick = () => {
        box.querySelectorAll('[data-cls]').forEach((cb) => { cb.checked = true; });
        d.class_names = classes.map((c) => c.class_name);
        d.class_name = d.class_names[0] || null;
      };
    }).catch(() => { /* 讀不到班別就留空，仍可儲存 */ });
    $('#f-desc').oninput = (e) => { d.description = e.target.value; };
    $('#f-due').onchange = (e) => { d.due_at = e.target.value ? new Date(e.target.value).toISOString() : null; };
    $('#f-status').onchange = (e) => { d.status = e.target.value; };
    $('#f-late').onchange = (e) => { d.allow_late = e.target.checked; };
    $$('[data-qf]').forEach((inp) => {
      inp.oninput = inp.onchange = () => {
        const card = inp.closest('[data-qi]');
        d.questions[Number(card.dataset.qi)][inp.dataset.qf] = inp.value;
      };
    });
    $$('[data-pf]').forEach((inp) => {
      inp.oninput = () => {
        const card = inp.closest('[data-qi]');
        const row = inp.closest('[data-pi]');
        d.questions[Number(card.dataset.qi)].points[Number(row.dataset.pi)][inp.dataset.pf] =
          inp.dataset.pf === 'score' ? Number(inp.value) : inp.value;
        $('#total-preview').textContent = totalOf(d.questions);
      };
    });
    $$('[data-addp]').forEach((b) => {
      b.onclick = () => {
        const qi = Number(b.dataset.addp);
        d.questions[qi].points.push({ id: `${d.questions[qi].no}-${d.questions[qi].points.length + 1}`, desc: '', score: 1 });
        viewEditor(existing);
      };
    });
    $$('[data-delp]').forEach((b) => {
      b.onclick = () => {
        const [qi, pi] = b.dataset.delp.split(':').map(Number);
        d.questions[qi].points.splice(pi, 1);
        if (!d.questions[qi].points.length) d.questions[qi].points.push({ id: `${d.questions[qi].no}-1`, desc: '', score: 1 });
        viewEditor(existing);
      };
    });
    $$('[data-delq]').forEach((b) => {
      b.onclick = () => {
        if (d.questions.length <= 1) return toast('最少要有一題', 'err');
        d.questions.splice(Number(b.dataset.delq), 1);
        viewEditor(existing);
      };
    });
    $('#add-q').onclick = () => { d.questions.push(blankQuestion(d.questions.length)); viewEditor(existing); };

    // AI 出題助手
    const gen = $('#gen-go');
    if (gen) gen.onclick = async () => {
      const topic = $('#gen-topic').value.trim();
      if (!topic) return toast('請輸入課題，例如「A Descriptive Paragraph」', 'err');
      gen.disabled = true;
      $('#gen-status').innerHTML = '<span class="spinner"></span>正在草擬題目與評分點…';
      try {
        const r = await api('/api/ai/suggest', {
          method: 'POST',
          body: JSON.stringify({
            subject: $('#gen-subject').value.trim() || '小學英文',
            level: $('#gen-level').value.trim() || '小六',
            topic, count: 4
          })
        });
        d.title = d.title || r.title;
        d.description = d.description || r.description;
        d.questions = r.questions;
        if (r.subject) d.subject = r.subject;
        if (r.level) d.level = r.level;
        viewEditor(existing);
        toast('已生成 ' + r.questions.length + ' 題（總分 ' + r.total + '），請逐點檢查', 'ok');
      } catch (e) {
        $('#gen-status').textContent = '';
        toast(e.message, 'err');
        gen.disabled = false;
      }
    };

    // 範本下拉：內建一份 + 「評分標準範本」資料夾裡的所有 JSON
    api('/api/templates').then(({ templates }) => {
      const sel = $('#tpl-select');
      if (!sel) return;
      sel.innerHTML = '<option value="">從範本載入…</option>' +
        templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
      sel.onchange = async () => {
        const t = templates.find((x) => x.id === sel.value);
        if (!t) return;
        d.questions = JSON.parse(JSON.stringify(t.questions));
        if (!d.title.trim()) d.title = t.name;
        if (t.description && !d.description) d.description = t.description;
        if (t.subject) d.subject = t.subject;
        if (t.class_name) d.class_name = t.class_name;
        viewEditor(existing);
        toast('已載入範本：' + t.name, 'ok');
      };
    }).catch(() => { /* 範本讀不到不影響手動建立 */ });
    $('#save-assignment').onclick = async (ev) => {
      if (!d.title.trim()) return toast('請填寫作業名稱', 'err');
      for (const q of d.questions) {
        if (!q.prompt.trim()) return toast('第 ' + q.no + ' 題還沒有題目文字', 'err');
        if (q.points.some((p) => !p.desc.trim())) return toast('第 ' + q.no + ' 題有評分點未填寫', 'err');
      }
      ev.target.disabled = true;
      try {
        if (existing) {
          await api('/api/assignments/' + existing.id, { method: 'PATCH', body: JSON.stringify(d) });
          toast('已儲存', 'ok');
          DRAFT = null;
          location.hash = '#/a/' + existing.id;
        } else {
          const r = await api('/api/assignments', { method: 'POST', body: JSON.stringify(d) });
          toast('作業已建立', 'ok');
          DRAFT = null;
          location.hash = '#/a/' + r.id;
        }
        render();
      } catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
    };
    $('#total-preview').textContent = totalOf(d.questions);
  };
  bind();
}

// ------------------------------------------------------------------ 老師：統計
async function viewStats(id) {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const st = await api('/api/assignments/' + id + '/stats');
  const pct = (v) => (v === null || v === undefined ? '—' : v + '%');
  const bars = [
    ['80–100%', st.buckets[0], 'ok'], ['60–79%', st.buckets[1], ''],
    ['40–59%', st.buckets[2], 'warn'], ['20–39%', st.buckets[3], 'warn'], ['0–19%', st.buckets[4], 'warn']
  ];
  const maxBucket = Math.max(1, ...st.buckets);

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/a/${id}" class="small">← 返回作業</a>
      <h1>統計分析</h1>
      <p class="muted small">${esc(st.assignment.title)} · ${esc(st.assignment.class_name || '')}</p>
    </div>
    <a class="small" href="/api/assignments/${id}/export.csv">匯出 CSV</a></div>

    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="v">${st.submitted}/${st.class_size}</div><div class="k">提交</div></div>
        <div class="stat"><div class="v">${st.graded}</div><div class="k">老師已定分</div></div>
        <div class="stat"><div class="v">${st.returned}</div><div class="k">已發還</div></div>
        <div class="stat"><div class="v">${st.avg ?? '—'}</div><div class="k">平均分（/${st.max}）</div></div>
        <div class="stat"><div class="v">${st.avg !== null && st.max ? Math.round((st.avg / st.max) * 1000) / 10 + '%' : '—'}</div><div class="k">平均得分率</div></div>
        <div class="stat"><div class="v">${st.ai.avg_abs_diff ?? '—'}</div><div class="k">AI 與你的平均分差</div></div>
      </div>
      ${st.ai.compared ? `<p class="tiny muted" style="margin-top:10px">比對了 ${st.ai.compared} 份：${st.ai.changed} 份你改動過 AI 的分數。分差越大，說明 AI 的判斷越要收緊（或這份作業的評分點寫得不夠具體）。</p>` : ''}
    </div>

    <div class="card" style="background:linear-gradient(180deg,#faf5ff,#fff);border-color:#e9d5ff">
      <div class="row"><b>✨ AI 教學分析</b>
        <span class="small muted">把上面的數字變成「下一堂怎樣補」</span>
        <span class="spacer"></span>
        <button class="ai small" id="gen-insight" ${st.graded ? '' : 'disabled'}>分析</button></div>
      <div id="insight-box" class="small" style="margin-top:8px"></div>
    </div>

    ${(st.per_class || []).length > 1 ? `<div class="card">
      <h2 style="font-size:16px">逐班比較</h2>
      <p class="tiny muted" style="margin-bottom:10px">同一份作業派給幾個班時，這裡一眼看到哪一班需要跟進。</p>
      <table><thead><tr><th>班別</th><th class="num">提交</th><th class="num">已批</th><th class="num">平均分</th><th class="num">得分率</th><th style="width:26%">　</th></tr></thead>
      <tbody>${(st.per_class || []).map((c) => {
        const rate = c.avg !== null && st.max ? Math.round((c.avg / st.max) * 1000) / 10 : null;
        const graded = st.students.filter((s) => s.teacher_total !== null && (s.class_name || '') === c.class_name).length;
        return `<tr>
          <td><b>${esc(c.class_name)}</b></td>
          <td class="num">${c.submitted}/${c.class_size}</td>
          <td class="num">${graded}</td>
          <td class="num">${c.avg ?? '—'}</td>
          <td class="num">${rate ?? '—'}%</td>
          <td>${rate === null ? '' : `<div class="bar ${rate < 60 ? 'warn' : ''}"><i style="width:${rate}%"></i></div>`}</td>
        </tr>`;
      }).join('')}</tbody></table>
    </div>` : ''}

    <div class="grid two">
      <div class="card">
        <h2 style="font-size:16px">分數分佈</h2>
        ${bars.map(([label, n, cls]) => `
          <div style="margin-bottom:10px">
            <div class="row small"><span>${label}</span><span class="spacer"></span><b>${n} 人</b></div>
            <div class="bar ${cls}"><i style="width:${(n / maxBucket) * 100}%"></i></div>
          </div>`).join('')}
      </div>
      <div class="card">
        <h2 style="font-size:16px">知識點得分率</h2>
        <p class="tiny muted">看清楚「哪個概念全班都沒掌握」，比逐份改更能改變教學。</p>
        ${st.perTag.map((t) => `
          <div style="margin-bottom:10px">
            <div class="row small"><span>${esc(t.tag)}</span><span class="spacer"></span><b>${pct(t.rate)}</b></div>
            <div class="bar ${t.rate !== null && t.rate < 60 ? 'warn' : ''}"><i style="width:${t.rate || 0}%"></i></div>
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2 style="font-size:16px">逐題得分率</h2>
      <table>
        <thead><tr><th>題</th><th>知識點</th><th class="num">滿分</th><th class="num">平均</th><th class="num">得分率</th><th style="width:42%">　</th></tr></thead>
        <tbody>${st.perQuestion.map((q) => `
          <tr><td>${esc(q.no)}</td><td>${esc(q.tag)}</td><td class="num">${q.max}</td>
            <td class="num">${q.avg ?? '—'}</td><td class="num">${pct(q.rate)}</td>
            <td><div class="bar ${q.rate !== null && q.rate < 60 ? 'warn' : ''}"><i style="width:${q.rate || 0}%"></i></div></td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="font-size:16px">學生</h2>
      <table>
        <thead><tr><th>學號</th><th>姓名</th><th>狀態</th><th class="num">AI</th><th class="num">最終</th><th class="num">分差</th><th></th></tr></thead>
        <tbody>${st.students.map((s) => `
          <tr><td>${esc(s.class_no || '')}</td><td><a href="#/p/${s.id}" title="看學習記錄">${esc(s.name)}</a></td>
            <td>${badge(s.status)}${s.late ? ' <span class="badge late">遲交</span>' : ''}</td>
            <td class="num">${s.ai_total ?? '—'}</td>
            <td class="num"><b>${s.teacher_total ?? '—'}</b></td>
            <td class="num">${s.ai_total !== null && s.teacher_total !== null ? (Math.round((s.teacher_total - s.ai_total) * 100) / 100) : '—'}</td>
            <td class="num"><a class="small" href="#/g/${s.id}">批改 →</a></td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const insightBtn = $('#gen-insight');
  if (insightBtn) insightBtn.onclick = async () => {
    insightBtn.disabled = true;
    insightBtn.innerHTML = '<span class="spinner"></span>分析中';
    const box = $('#insight-box');
    try {
      const r = await api('/api/assignments/' + id + '/insight');
      box.innerHTML = `<p style="white-space:pre-wrap;margin:0 0 8px">${esc(r.insight)}</p>
        ${r.focus ? `<span class="badge ai">建議重教：${esc(r.focus)}</span>` : ''}
        <span class="tiny muted" style="margin-left:8px">${r.ms ? Math.round(r.ms / 100) / 10 + ' 秒' : ''}</span>`;
      insightBtn.textContent = '再分析一次';
      insightBtn.disabled = false;
    } catch (e) {
      box.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
      insightBtn.textContent = '分析';
      insightBtn.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ 學習畫像與錯題精煉
// 同一頁給兩種人看：學生看自己（可練），老師看任何學生（只讀）。

function rateBar(rate, warnAt = 60) {
  const v = rate === null || rate === undefined ? 0 : Math.max(0, Math.min(100, rate));
  return `<div class="bar ${v < warnAt ? 'warn' : ''}"><i style="width:${v}%"></i></div>`;
}

function deltaLabel(d) {
  if (d === null || d === undefined) return '<span class="muted small">—</span>';
  if (Math.abs(d) < 2) return '<span class="badge">持平</span>';
  return d > 0
    ? `<span class="badge returned">↑ ${d} 分</span>`
    : `<span class="badge late">↓ ${Math.abs(d)} 分</span>`;
}

async function viewLearn(studentId, autoTag) {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const isTeacher = ME.role === 'teacher';
  const sid = Number(studentId || ME.id);
  const data = await api('/api/students/' + sid + '/progress');
  let mistakes = null;
  if (!isTeacher && sid === ME.id) {
    try { mistakes = await api('/api/practice/mistakes'); } catch { /* 未有批改記錄 */ }
  }
  const p = data;
  const tags = p.tags || [];
  const lostByTag = new Map((mistakes?.tags || []).map((t) => [t.tag, t]));
  const o = p.overall || {};

  app.innerHTML = `
    <div class="page-head"><div class="grow">
      ${isTeacher ? '<a href="#/" class="small">← 返回</a>' : ''}
      <h1>${isTeacher ? esc(data.student.name) + ' 的學習記錄' : '我的學習'}</h1>
      <p class="muted small">${isTeacher ? esc(data.student.class_name || '') + ' · ' + esc(data.student.class_no || '') : '看自己的強項與弱項，弱的可以直接練'}</p>
    </div></div>

    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="v">${o.n ?? 0}</div><div class="k">已批改的作業</div></div>
        <div class="stat"><div class="v">${o.avg ?? '—'}%</div><div class="k">平均得分率</div></div>
        <div class="stat"><div class="v">${o.last ?? '—'}%</div><div class="k">最近一次</div></div>
        <div class="stat"><div class="v">${o.delta === null || o.delta === undefined ? '—' : (o.delta > 0 ? '+' : '') + o.delta}</div><div class="k">首次到最近變化</div></div>
      </div>
      ${!p.enoughData ? `<p class="tiny muted" style="margin-top:10px">只有 ${o.n || 0} 次數據。少於 3 次之前，「進步／退步」只供參考，不要當結論。</p>` : ''}
    </div>

    <div class="card">
      <h2 style="font-size:16px">知識點</h2>
      <p class="tiny muted" style="margin-bottom:12px">由弱到強排列。分數低不代表能力差，可能只是那個單元未教完。</p>
      ${tags.length ? tags.map((t) => {
        const lost = lostByTag.get(t.tag);
        const canPractice = !isTeacher && lost && lost.items.length;
        return `<div style="margin-bottom:14px">
          <div class="row" style="gap:10px">
            <b style="flex:1">${esc(t.tag)}</b>
            <span class="small muted">${t.n} 次</span>
            <b style="width:52px;text-align:right">${t.avg ?? '—'}%</b>
            ${deltaLabel(t.delta)}
            ${canPractice ? `<button class="small ai" data-prac="${esc(t.tag)}">精煉練習</button>` : ''}
          </div>
          <div class="row" style="gap:10px">
            <div style="flex:1">${rateBar(t.avg)}</div>
            <span class="tiny muted" style="width:150px;text-align:right">${lost ? '累計失分 ' + lost.lost + ' 分' : ''}</span>
          </div>
        </div>`;
      }).join('') : '<p class="muted small">還沒有已批改的作業。</p>'}
    </div>

    ${p.assignments.length ? `<div class="card">
      <h2 style="font-size:16px">作業記錄</h2>
      <table><thead><tr><th>作業</th><th>日期</th><th class="num">得分</th><th class="num">得分率</th><th style="width:32%">　</th></tr></thead>
      <tbody>${p.assignments.map((a) => `<tr>
        <td>${esc(a.title)}</td>
        <td class="small muted">${fmtDay(a.date)}</td>
        <td class="num">${a.score} / ${a.max}</td>
        <td class="num">${a.rate}%</td>
        <td>${rateBar(a.rate)}</td></tr>`).join('')}</tbody></table>
    </div>` : ''}

    <div id="practice-area"></div>`;

  if (isTeacher) return;

  const area = $('#practice-area');
  const btns = $$('[data-prac]');
  btns.forEach((b) => { b.onclick = () => startPractice(b.dataset.prac, area, b); });
  if (autoTag) {
    const b = btns.find((x) => x.dataset.prac === autoTag);
    startPractice(autoTag, area, b || null);
  }
}

async function startPractice(tag, area, btn) {
  if (btn) btn.disabled = true;
  area.innerHTML = `<div class="card"><div class="row"><b>「${esc(tag)}」精煉練習</b>
    <span class="spacer"></span><span class="small muted"><span class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--ai)"></span>正在按你的弱點出題…</span></div></div>`;
  area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await api('/api/practice/generate', { method: 'POST', body: JSON.stringify({ tag, count: 3 }) });
    renderPracticeItems(tag, r.items, area);
  } catch (e) {
    area.innerHTML = `<div class="card"><div class="flag">${esc(e.message)}</div></div>`;
  }
  if (btn) btn.disabled = false;
}

function renderPracticeItems(tag, items, area) {
  area.innerHTML = `
    <div class="card">
      <div class="row"><b>「${esc(tag)}」精煉練習</b>
        <span class="badge ai">AI 按你的扣分點出題</span>
        <span class="spacer"></span>
        <span class="small muted">${items.length} 題 · 每題一分鐘內完成</span>
      </div>
      <p class="tiny muted" style="margin-top:6px">練習不計分，目的是把同一個弱點練到會。答完會即時告訴你欠甚麼。</p>
      <div id="prac-list">${items.map((it, i) => `
        <div class="answer-block" data-item="${it.id}">
          <div class="row" style="align-items:flex-start">
            <span class="q-no">${i + 1}</span>
            <span class="q-prompt" style="flex:1">${esc(it.prompt)}</span>
          </div>
          ${it.hint ? `<details style="margin:6px 0"><summary>提示</summary><div class="small muted">${esc(it.hint)}</div></details>` : ''}
          <textarea placeholder="寫你的答案…" style="margin-top:8px"></textarea>
          <div class="row" style="margin-top:8px">
            <button class="primary small" data-submit="${it.id}">交答案</button>
            <span class="small" data-result="${it.id}"></span>
          </div>
          <div data-feedback="${it.id}"></div>
        </div>`).join('')}</div>
    </div>`;

  items.forEach((it) => {
    const box = area.querySelector(`[data-item="${it.id}"]`);
    const ta = box.querySelector('textarea');
    const btn = box.querySelector(`[data-submit="${it.id}"]`);
    const out = box.querySelector(`[data-feedback="${it.id}"]`);
    btn.onclick = async () => {
      const answer = ta.value.trim();
      if (!answer) return toast('請先寫答案', 'err');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>看緊';
      try {
        const r = await api(`/api/practice/${it.id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) });
        const cls = r.verdict === 'correct' ? 'open' : (r.verdict === 'partial' ? 'late' : 'late');
        const label = { correct: '✓ 做對了', partial: '△ 差一點', wrong: '✗ 未做到' }[r.verdict] || r.verdict;
        out.innerHTML = `
          <div class="flag" style="background:${r.verdict === 'correct' ? 'var(--ok-light)' : 'var(--warn-light)'};color:${r.verdict === 'correct' ? '#166534' : 'var(--warn)'}">
            <b>${label}</b> ${esc(r.feedback || '')}
          </div>
          <details style="margin-top:4px"><summary>看示範答案</summary>
            <div class="answer-text" style="margin-top:6px;font-size:14px">${esc(r.model_answer || '（無）')}</div>
            ${(r.expected || []).length ? `<ul class="small muted" style="margin:6px 0 0">${r.expected.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
          </details>
          ${r.verdict === 'correct' ? '' : '<p class="tiny muted" style="margin:6px 0 0">可以改一改再交一次，系統會重新判斷。</p>'}`;
        if (r.verdict !== 'correct') { btn.disabled = false; btn.textContent = '再交一次'; }
        else { btn.textContent = '已完成'; }
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false;
        btn.textContent = '交答案';
      }
    };
  });
}

// ------------------------------------------------------------------ 老師：名單
async function viewRoster() {
  app.innerHTML = '<p class="muted">載入中…</p>';
  const { roster } = await api('/api/roster');
  const claimed = roster.filter((r) => r.claimed).length;

  app.innerHTML = `
    <div class="page-head"><div class="grow"><h1>學生名單</h1>
      <p class="muted small">學生只能用在名單內的學生證號碼註冊。已註冊 ${claimed} / ${roster.length} 人。</p></div></div>

    <div class="card">
      <h2 style="font-size:16px">匯入名單</h2>
      <p class="small muted">每行一筆，格式：<span class="mono">班別,學號,姓名,學生證號碼</span>（逗號或 Tab 分隔，可從 Excel 直接複製貼上）</p>
      <textarea id="csv" style="min-height:120px" placeholder="5B,01,陳嘉欣,2025001
5B,02,陳子朗,2025002"></textarea>
      <div class="row end" style="margin-top:10px"><button class="primary" id="do-import">匯入</button></div>
      <p class="tiny muted" id="import-result"></p>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>班別</th><th>學號</th><th>姓名</th><th>學生證號碼</th><th>狀態</th><th></th></tr></thead>
        <tbody>${roster.map((r) => `
          <tr><td>${esc(r.class_name)}</td><td>${esc(r.class_no)}</td><td>${esc(r.name)}</td>
            <td class="mono">${esc(r.student_no)}</td>
            <td>${r.claimed ? '<span class="badge open">已註冊</span>' : '<span class="badge">未註冊</span>'}</td>
            <td class="num">${r.claimed
              ? `<button class="small ghost" data-reset="${r.id}">重設密碼</button>
                 <button class="small ghost" data-unclaim="${r.id}">解除註冊</button>`
              : ''}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $('#do-import').onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await api('/api/roster/import', { method: 'POST', body: JSON.stringify({ csv: $('#csv').value }) });
      $('#import-result').textContent = `新增 ${r.added} 筆、更新 ${r.updated} 筆、略過 ${r.skipped} 筆`;
      toast('匯入完成', 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); ev.target.disabled = false; }
  };
  $$('[data-reset]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('重設後舊密碼立即失效，確定？')) return;
      try {
        const r = await api('/api/roster/' + b.dataset.reset + '/reset-password', { method: 'POST', body: '{}' });
        alert(`${r.name} 的臨時密碼是：${r.temp_password}\n\n請口頭告知學生，並提醒他登入後自行更改。`);
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $$('[data-unclaim]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('解除後該學生帳號會停用，他需要重新註冊。確定？')) return;
      try {
        await api('/api/roster/' + b.dataset.unclaim + '/unclaim', { method: 'POST', body: '{}' });
        toast('已解除', 'ok');
        render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// ------------------------------------------------------------------ 帳戶
function viewAccount() {
  app.innerHTML = `
    <div class="page-head"><div class="grow"><h1>帳戶</h1></div></div>
    <div class="card" style="max-width:460px">
      <p><b>${esc(ME.name)}</b> <span class="muted small">${ME.role === 'teacher' ? '老師' : esc(ME.class_name || '') + ' · ' + esc(ME.class_no || '')}</span></p>
      <p class="small muted">${ME.role === 'student' ? '學生證號碼：' + esc(ME.student_no || '') : '用戶名：' + esc(ME.login_id)}</p>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
      <label class="field"><span>舊密碼</span><input type="password" id="old-pw"></label>
      <label class="field"><span>新密碼</span><input type="password" id="new-pw"></label>
      <button class="primary" id="do-change">更改密碼</button>
    </div>
    <div class="card" style="max-width:460px">
      <h2 style="font-size:15px">關於這個平臺</h2>
      <p class="small muted">AI 模式：${META.aiMode === 'live' ? '真實模型（' + esc(META.model) + '）' : '模擬模式（未配置 API Key）'}</p>
      <p class="tiny muted">試用版 v0.2 · 校內使用，不對外開放。</p>
    </div>
    ${ME.role === 'teacher' ? '<div class="card" id="usage"><p class="muted small">正在讀取 AI 用量…</p></div>' : ''}`;

  if (ME.role === 'teacher') {
    const KIND = { transcribe: '手寫轉寫', grade: '逐點預批', comment: '評語草稿', suggest: '出題助手', insight: '班級分析', ask: '學生提問' };
    api('/api/ai/usage').then((u) => {
      const rows = (u.byKind || []).map((k) => `<tr>
        <td>${KIND[k.kind] || k.kind}</td>
        <td class="num">${k.n}</td>
        <td class="num">${k.ok}</td>
        <td class="num">${(k.p + k.c).toLocaleString()}</td>
        <td class="num">${k.avg_ms} ms</td></tr>`).join('');
      $('#usage').innerHTML = `
        <h2 style="font-size:15px">AI 用量</h2>
        <p class="small muted">今日 ${u.today.n} 次呼叫、${(u.today.tokens || 0).toLocaleString()} tokens。
          模型：${esc(u.model)}</p>
        <table><thead><tr><th>用途</th><th class="num">次數</th><th class="num">成功</th><th class="num">tokens</th><th class="num">平均耗時</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">還沒有呼叫記錄</td></tr>'}</tbody></table>
        ${u.errors?.length ? `<p class="tiny" style="margin-top:10px;color:var(--danger)">最近錯誤：${u.errors.map((e) => esc(e.kind + '：' + (e.error || ''))).join('；')}</p>` : ''}`;
    }).catch(() => { $('#usage').innerHTML = '<p class="muted small">讀取用量失敗</p>'; });
  }
  $('#do-change').onclick = async () => {
    try {
      await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: $('#old-pw').value, new_password: $('#new-pw').value })
      });
      toast('密碼已更改', 'ok');
      $('#old-pw').value = ''; $('#new-pw').value = '';
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ------------------------------------------------------------------ 登入提示
// 每次開頁只彈一次；按「知道了」會寫入 assignment_views，之後不再為同一份作業彈。
let NOTICES_SHOWN = false;

async function maybeShowNotices() {
  if (NOTICES_SHOWN || !ME || ME.role !== 'student') return;
  NOTICES_SHOWN = true;
  let n;
  try { n = await api('/api/notices'); } catch { return; }
  if (!n.new || !n.new.length) return;

  const ack = () => api('/api/notices/ack', {
    method: 'POST', body: JSON.stringify({ ids: n.new.map((x) => x.id) })
  }).catch(() => {});

  const box = document.createElement('div');
  box.className = 'modal-backdrop';
  box.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div style="font-size:34px;line-height:1">📋</div>
      <h2 style="margin:6px 0 2px">你有 ${n.new.length} 份新作業</h2>
      <p class="small muted" style="margin:0 0 14px">老師剛派給 ${esc(ME.class_name || '你')} 的</p>
      <div class="modal-list">
        ${n.new.map((a) => `<a class="modal-item" href="#/a/${a.id}">
          <b>${esc(a.title)}</b>
          <span class="small muted">${esc(a.subject || '')}${a.due_at ? ' · 截止 ' + fmtTime(a.due_at) : ''}</span>
        </a>`).join('')}
      </div>
      <div class="row end" style="margin-top:16px"><button class="primary" id="notice-ok">知道了</button></div>
    </div>`;
  document.body.appendChild(box);

  const close = () => { box.remove(); ack(); };
  box.querySelector('#notice-ok').onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

// ------------------------------------------------------------------ 路由
async function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!ME) {
    try {
      const m = await api('/api/me');
      if (m.user) { ME = m.user; META = { aiMode: m.aiMode, model: m.model, vision: m.vision }; }
    } catch { /* 未登入 */ }
  }
  if (!ME) return viewLogin(parts[0] === 'login' ? 'student' : 'student');
  renderTop();
  maybeShowNotices();   // 學生登入後彈一次「你有 N 份新作業」
  try {
    if (parts.length === 0) return ME.role === 'teacher' ? viewTeacherHome() : viewStudentHome();
    if (parts[0] === 'login') { location.hash = '#/'; return; }
    if (parts[0] === 'account') return viewAccount();
    if (parts[0] === 'learn') return viewLearn(ME.id, parts[1] ? decodeURIComponent(parts[1]) : null);
    if (parts[0] === 'p') return viewLearn(parts[1]);
    if (parts[0] === 'roster') return ME.role === 'teacher' ? viewRoster() : viewStudentHome();
    if (parts[0] === 'new') return ME.role === 'teacher' ? (DRAFT = null, viewEditor(null)) : viewStudentHome();
    if (parts[0] === 'a' && parts[2] === 'edit') {
      if (ME.role !== 'teacher') return viewAssignment(parts[1]);
      const { assignment } = await api('/api/assignments/' + parts[1]);
      DRAFT = null;
      return viewEditor(assignment);
    }
    if (parts[0] === 'a') return ME.role === 'teacher' ? viewTeacherAssignment(parts[1]) : viewAssignment(parts[1]);
    if (parts[0] === 'g') return ME.role === 'teacher' ? viewGrade(parts[1]) : viewStudentHome();
    if (parts[0] === 's') return ME.role === 'teacher' ? viewStats(parts[1]) : viewStudentHome();
    location.hash = '#/';
  } catch (e) {
    app.innerHTML = `<div class="card"><h2>出錯了</h2><p>${esc(e.message)}</p><button class="ghost" onclick="location.hash='#/';render()">返回</button></div>`;
  }
}

window.addEventListener('hashchange', () => { DRAFT = null; render(); });
render();
