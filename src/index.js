// 線上測驗後端（Cloudflare Worker + D1）
// 學生 API：/quiz/api/assignment/:code、/quiz/api/start、/quiz/api/answer、/quiz/api/submit
// 老師 API：/quiz/api/teacher/*（需登入）

const API = '/quiz/api';
const MODES = ['instant', 'full'];
const SUBMIT_GRACE_MS = 10 * 60 * 1000; // 截止後 10 分鐘內仍可交卷（給作答中的學生）
const TEACHER_TOKEN_HOURS = 12;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/quiz') return Response.redirect(`${url.origin}/quiz/${url.search}`, 301);
    if (!path.startsWith(API)) return env.ASSETS.fetch(request);

    try {
      return await route(request, env, path.slice(API.length), url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: '伺服器發生錯誤，請稍後再試。' }, 500);
    }
  }
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function body(request) {
  try { return await request.json(); } catch { fail(400, '資料格式錯誤。'); }
}

const nowIso = () => new Date().toISOString();

async function route(request, env, p, url) {
  const m = request.method;
  let match;

  // ---------- 學生端 ----------
  if (m === 'GET' && (match = p.match(/^\/assignment\/([A-Za-z0-9]{6})$/))) {
    return json(await getAssignmentForStudent(env, match[1].toUpperCase()));
  }
  if (m === 'POST' && p === '/start') return json(await startAttempt(env, await body(request)));
  if (m === 'POST' && p === '/answer') return json(await saveAnswer(env, await body(request)));
  if (m === 'POST' && p === '/submit') return json(await submitAttempt(env, await body(request)));

  // ---------- Agent 出題（API 金鑰） ----------
  if (p.startsWith('/agent/')) {
    await requireAgent(request, env);
    if (m === 'POST' && p === '/agent/quizzes') return json(await agentCreateQuiz(env, await body(request), url), 201);
    if (m === 'GET' && p === '/agent/quizzes') return json(await listQuizzes(env));
    if (m === 'POST' && p === '/agent/assignments') {
      const b = await body(request);
      const { code } = await createAssignment(env, { ...b, modes: b.modes || MODES });
      const created = await getAssignment(env, code);
      return json({ ...links(url, code), opensAt: created.opens_at, closesAt: created.closes_at }, 201);
    }
    if (m === 'GET' && (match = p.match(/^\/agent\/assignments\/([A-Z0-9]{6})\/summary$/))) {
      return json(await agentSummary(env, match[1]));
    }
    fail(404, '找不到這個功能。');
  }

  // ---------- 老師端 ----------
  if (m === 'POST' && p === '/teacher/login') return json(await teacherLogin(env, await body(request)));
  if (p.startsWith('/teacher/')) {
    await requireTeacher(request, env);
    if (m === 'GET' && p === '/teacher/quizzes') return json(await listQuizzes(env));
    if (m === 'GET' && p === '/teacher/assignments') return json(await listAssignments(env));
    if (m === 'POST' && p === '/teacher/assignments') return json(await createAssignment(env, await body(request)));
    if ((match = p.match(/^\/teacher\/assignments\/([A-Z0-9]{6})$/))) {
      if (m === 'PATCH') return json(await updateAssignment(env, match[1], await body(request)));
      if (m === 'DELETE') return json(await deleteAssignment(env, match[1]));
    }
    if (m === 'GET' && (match = p.match(/^\/teacher\/assignments\/([A-Z0-9]{6})\/report$/))) {
      return json(await getReport(env, match[1]));
    }
  }
  fail(404, '找不到這個功能。');
}

// =====================================================================
// 共用
// =====================================================================

async function getAssignment(env, code) {
  const a = await env.DB.prepare('SELECT * FROM assignments WHERE code = ?').bind(code).first();
  if (!a) fail(404, '找不到這份考卷，請確認連結是否正確。');
  return a;
}

function assignmentStatus(a, now = Date.now()) {
  if (!a.is_open) return 'closed';
  if (a.opens_at && now < Date.parse(a.opens_at)) return 'not_started';
  if (a.closes_at && now > Date.parse(a.closes_at)) return 'closed';
  return 'open';
}

async function getQuestions(env, quizId) {
  const { results } = await env.DB.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY sort').bind(quizId).all();
  return results.map(q => ({ ...q, options: JSON.parse(q.options) }));
}

const publicQuestion = q => ({ id: q.qid, part: q.part, tag: q.tag, title: q.title, options: q.options });

const scoreOf = (correct, total) => total ? Math.round(correct * 100 / total) : 0;

async function getAttemptByToken(env, token) {
  if (typeof token !== 'string' || token.length < 20) fail(400, '作答憑證無效，請重新進入考卷。');
  const at = await env.DB.prepare('SELECT * FROM attempts WHERE token = ?').bind(token).first();
  if (!at) fail(404, '找不到作答紀錄，請重新進入考卷。');
  return at;
}

function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

// =====================================================================
// 學生端
// =====================================================================

async function getAssignmentForStudent(env, code) {
  const a = await getAssignment(env, code);
  const quiz = await env.DB.prepare('SELECT title FROM quizzes WHERE id = ?').bind(a.quiz_id).first();
  const status = assignmentStatus(a);
  const out = {
    code: a.code, title: a.title, quizTitle: quiz?.title || '', modes: a.modes.split(','),
    opensAt: a.opens_at, closesAt: a.closes_at, status
  };
  if (status === 'open') {
    const qs = await getQuestions(env, a.quiz_id);
    out.questions = qs.map(publicQuestion);
    out.pointsPerQuestion = qs.length ? Math.round(100 / qs.length * 100) / 100 : 0;
  }
  return out;
}

async function startAttempt(env, b) {
  const code = String(b.code || '').toUpperCase();
  const className = cleanText(b.className, 20);
  const name = cleanText(b.name, 20);
  const seat = Number.parseInt(b.seat, 10);
  if (!className) fail(400, '請填寫班級。');
  if (!Number.isInteger(seat) || seat < 1 || seat > 99) fail(400, '座號請填 1～99 的數字。');
  if (!name) fail(400, '請填寫作答代號。');

  const a = await getAssignment(env, code);
  const status = assignmentStatus(a);
  if (status === 'not_started') fail(403, '這份考卷還沒開放作答。');
  if (status === 'closed') fail(403, '這份考卷已經截止。');
  const modes = a.modes.split(',');
  let mode = MODES.includes(b.mode) ? b.mode : modes[0];
  if (!modes.includes(mode)) fail(400, '老師沒有開放這個作答模式。');

  const { results: prev } = await env.DB.prepare(
    'SELECT * FROM attempts WHERE assignment_code = ? AND class_name = ? AND seat = ? ORDER BY attempt_no'
  ).bind(code, className, seat).all();

  const latest = prev.at(-1);
  if (latest && (latest.token !== b.resumeToken || latest.student_name !== name)) {
    fail(409, '此班級代碼與座號已有作答紀錄，請使用原瀏覽器與作答代號繼續。');
  }
  const first = prev.find(x => x.attempt_no === 1);
  const firstInfo = first?.submitted_at ? { score: first.score, submittedAt: first.submitted_at } : null;

  // 尚未交卷的作答 → 接續作答（不另開新卷，避免同時開兩份卷查答案）
  const open = prev.find(x => !x.submitted_at);
  if (open) {
    return { ...(await attemptState(env, open, a)), resumed: true, first: firstInfo };
  }

  const attemptNo = (latest?.attempt_no || 0) + 1;
  const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
  await env.DB.prepare(
    'INSERT INTO attempts (assignment_code, class_name, seat, student_name, mode, attempt_no, token, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(code, className, seat, name, mode, attemptNo, token, nowIso()).run();
  const at = await getAttemptByToken(env, token);
  return { ...(await attemptState(env, at, a)), resumed: false, first: firstInfo };
}

async function attemptState(env, at, a) {
  const qs = await getQuestions(env, a.quiz_id);
  const byId = new Map(qs.map(q => [q.qid, q]));
  const { results } = await env.DB.prepare('SELECT qid, choice, is_correct FROM answers WHERE attempt_id = ?').bind(at.id).all();
  const answers = {};
  for (const r of results) {
    if (r.choice == null) continue;
    const q = byId.get(r.qid);
    answers[r.qid] = at.mode === 'instant'
      ? { choice: r.choice, correct: !!r.is_correct, answer: q?.answer, explanation: q?.explanation }
      : { choice: r.choice };
  }
  return {
    token: at.token, mode: at.mode, attemptNo: at.attempt_no, counted: at.attempt_no === 1,
    className: at.class_name, seat: at.seat, name: at.student_name, answers
  };
}

async function saveAnswer(env, b) {
  const at = await getAttemptByToken(env, b.token);
  if (at.submitted_at) fail(409, '這份試卷已經交卷。');
  const a = await getAssignment(env, at.assignment_code);
  if (assignmentStatus(a) !== 'open') fail(403, '考卷已截止，無法再作答。');

  const qid = Number.parseInt(b.qid, 10);
  const choice = Number.parseInt(b.choice, 10);
  if (![0, 1, 2, 3].includes(choice)) fail(400, '選項不正確。');
  const q = await env.DB.prepare('SELECT answer, explanation FROM questions WHERE quiz_id = ? AND qid = ?').bind(a.quiz_id, qid).first();
  if (!q) fail(400, '題號不正確。');
  const isCorrect = choice === q.answer ? 1 : 0;

  if (at.mode === 'instant') {
    // 即時核對：第一次選擇即鎖定
    await env.DB.prepare(
      'INSERT OR IGNORE INTO answers (attempt_id, qid, choice, is_correct, answered_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(at.id, qid, choice, isCorrect, nowIso()).run();
    const saved = await env.DB.prepare('SELECT choice, is_correct FROM answers WHERE attempt_id = ? AND qid = ?').bind(at.id, qid).first();
    return { locked: true, choice: saved.choice, correct: !!saved.is_correct, answer: q.answer, explanation: q.explanation };
  }

  // 全部做完再核對：可改答案，只回報已儲存，不透露對錯
  await env.DB.prepare(
    `INSERT INTO answers (attempt_id, qid, choice, is_correct, answered_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, qid) DO UPDATE SET choice = excluded.choice, is_correct = excluded.is_correct, answered_at = excluded.answered_at`
  ).bind(at.id, qid, choice, isCorrect, nowIso()).run();
  return { saved: true };
}

async function submitAttempt(env, b) {
  const at = await getAttemptByToken(env, b.token);
  const a = await getAssignment(env, at.assignment_code);
  const qs = await getQuestions(env, a.quiz_id);

  if (!at.submitted_at) {
    if (!a.is_open) fail(403, '老師已關閉這份考卷，無法交卷。');
    if (a.closes_at && Date.now() > Date.parse(a.closes_at) + SUBMIT_GRACE_MS) fail(403, '已超過交卷時間。');

    const stmts = [];
    const now = nowIso();
    // 全部做完再核對：以交卷時送來的答案為準
    if (at.mode === 'full' && b.answers && typeof b.answers === 'object') {
      for (const q of qs) {
        const c = Number.parseInt(b.answers[q.qid], 10);
        if (![0, 1, 2, 3].includes(c)) continue;
        stmts.push(env.DB.prepare(
          `INSERT INTO answers (attempt_id, qid, choice, is_correct, answered_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (attempt_id, qid) DO UPDATE SET choice = excluded.choice, is_correct = excluded.is_correct, answered_at = excluded.answered_at`
        ).bind(at.id, q.qid, c, c === q.answer ? 1 : 0, now));
      }
    }
    if (stmts.length) await env.DB.batch(stmts);

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM answers WHERE attempt_id = ? AND is_correct = 1').bind(at.id).first();
    const correct = row.n;
    // 條件式更新，避免重複送出時重算
    await env.DB.prepare(
      'UPDATE attempts SET submitted_at = ?, score = ?, correct_count = ? WHERE id = ? AND submitted_at IS NULL'
    ).bind(now, scoreOf(correct, qs.length), correct, at.id).run();
  }

  const done = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(at.id).first();
  const { results } = await env.DB.prepare('SELECT qid, choice FROM answers WHERE attempt_id = ?').bind(at.id).all();
  const chosen = new Map(results.map(r => [r.qid, r.choice]));
  return {
    score: done.score, correctCount: done.correct_count, total: qs.length,
    attemptNo: done.attempt_no, counted: done.attempt_no === 1, submittedAt: done.submitted_at,
    results: qs.map(q => {
      const c = chosen.has(q.qid) ? chosen.get(q.qid) : null;
      return { id: q.qid, choice: c, answer: q.answer, correct: c === q.answer, explanation: q.explanation };
    })
  };
}

// =====================================================================
// 老師端
// =====================================================================

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode('quiz-assignment:' + env.TEACHER_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function teacherLogin(env, b) {
  if (!env.TEACHER_PASSWORD) fail(503, '尚未設定老師密碼。');
  const pw = String(b.password || '');
  // 以雜湊比較，長度不同也不提早結束
  const [x, y] = await Promise.all([hmac(env, 'pw:' + pw), hmac(env, 'pw:' + env.TEACHER_PASSWORD)]);
  if (!safeEqual(x, y)) {
    await new Promise(r => setTimeout(r, 800));
    fail(401, '密碼錯誤。');
  }
  const exp = Date.now() + TEACHER_TOKEN_HOURS * 3600 * 1000;
  return { token: `${exp}.${await hmac(env, 'session:' + exp)}`, expiresAt: new Date(exp).toISOString() };
}

async function requireTeacher(request, env) {
  if (!env.TEACHER_PASSWORD) fail(503, '尚未設定老師密碼。');
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now() || !safeEqual(sig, await hmac(env, 'session:' + exp))) {
    fail(401, '請重新登入。');
  }
}

// =====================================================================
// Agent 出題
// =====================================================================

async function requireAgent(request, env) {
  if (!env.AGENT_API_KEY) fail(503, '尚未設定 AGENT_API_KEY。');
  const auth = request.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const [x, y] = await Promise.all([hmac(env, 'agent:' + key), hmac(env, 'agent:' + env.AGENT_API_KEY)]);
  if (!safeEqual(x, y)) fail(401, 'API 金鑰錯誤。');
}

function links(url, code) {
  return {
    code,
    studentUrl: `${url.origin}/quiz/?a=${code}`,
    teacherUrl: `${url.origin}/quiz/teacher/`
  };
}

// 題目內容會以 HTML 顯示：只保留少數無屬性的排版標籤，其餘一律轉義
const ALLOWED_TAGS = ['br', 'u', 'b', 'strong', 'em', 'i', 'sub', 'sup'];
function safeHtml(v, max = 4000) {
  const s = String(v ?? '').slice(0, max)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return s.replace(/&lt;(\/?)([a-z]+)\s*\/?&gt;/gi, (all, slash, tag) =>
    ALLOWED_TAGS.includes(tag.toLowerCase()) ? `<${slash}${tag.toLowerCase()}>` : all);
}

function parseAnswer(v) {
  if (typeof v === 'number' && [0, 1, 2, 3].includes(v)) return v;
  const s = String(v ?? '').trim().toUpperCase();
  if (/^[ABCD]$/.test(s)) return s.charCodeAt(0) - 65;
  if (/^[1-4]$/.test(s)) return Number(s) - 1;
  return null;
}

async function agentCreateQuiz(env, b, url) {
  const title = cleanText(b.title, 80);
  if (!title) fail(400, 'title（試卷名稱）必填。');
  const list = b.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100) fail(400, 'questions 需為 1～100 題的陣列。');

  const errors = [];
  const qs = list.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== 'object') { errors.push(`第 ${n} 題格式錯誤`); return null; }
    if (!String(q.question ?? q.title ?? '').trim()) errors.push(`第 ${n} 題缺少 question`);
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => !String(o ?? '').trim())) errors.push(`第 ${n} 題 options 必須是 4 個非空白選項`);
    const answer = parseAnswer(q.answer);
    if (answer == null) errors.push(`第 ${n} 題 answer 必須是 A/B/C/D`);
    return {
      qid: n, sort: n,
      part: q.part ? cleanText(q.part, 80) : null,
      tag: q.tag ? cleanText(q.tag, 20) : null,
      title: safeHtml(q.question ?? q.title),
      options: (q.options || []).map(o => safeHtml(o, 500)),
      answer,
      explanation: q.explanation ? safeHtml(q.explanation) : null
    };
  });
  if (errors.length) fail(400, '題目格式有誤：' + errors.slice(0, 10).join('；'));

  const now = nowIso();
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), x => CODE_CHARS[x % CODE_CHARS.length]).join('').toLowerCase();
  const quizId = `q-${now.slice(0, 10).replace(/-/g, '')}-${rand}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO quizzes (id, title, created_at) VALUES (?, ?, ?)').bind(quizId, title, now),
    ...qs.map(q => env.DB.prepare(
      'INSERT INTO questions (quiz_id, qid, sort, part, tag, title, options, answer, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(quizId, q.qid, q.sort, q.part, q.tag, q.title, JSON.stringify(q.options), q.answer, q.explanation))
  ]);

  const counts = [0, 0, 0, 0];
  qs.forEach(q => counts[q.answer]++);
  const out = { quizId, title, questionCount: qs.length, answerDistribution: { A: counts[0], B: counts[1], C: counts[2], D: counts[3] } };

  // 預設同時派卷；assign: false 則只建題庫
  if (b.assign !== false) {
    const a = b.assignment || {};
    const { code } = await createAssignment(env, {
      quizId, title: a.title || title, modes: a.modes || MODES, opensAt: a.opensAt, closesAt: a.closesAt
    });
    const created = await getAssignment(env, code);
    out.opensAt = created.opens_at;
    out.closesAt = created.closes_at;
    Object.assign(out, links(url, code));
  }
  return out;
}

async function agentSummary(env, code) {
  const r = await getReport(env, code);
  const firsts = r.attempts.filter(t => t.attemptNo === 1);
  const done = firsts.filter(t => t.submittedAt);
  const scores = done.map(t => t.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null;
  return {
    assignment: r.assignment,
    submitted: done.length, inProgress: firsts.length - done.length,
    averageScore: avg, maxScore: scores.length ? Math.max(...scores) : null, minScore: scores.length ? Math.min(...scores) : null,
    // 不回傳學生姓名，避免個資進入 Agent 的對話紀錄；老師後台才看得到姓名
    students: done.map(t => ({ className: t.className, seat: t.seat, score: t.score })),
    questions: r.questions.map((q, i) => {
      const counts = [0, 0, 0, 0]; let blank = 0;
      done.forEach(t => { const c = t.answers[q.id]; c == null ? blank++ : counts[c]++; });
      const wrong = done.length - counts[q.answer];
      return {
        number: i + 1, tag: q.tag, answer: 'ABCD'[q.answer],
        wrongRate: done.length ? Math.round(wrong / done.length * 1000) / 10 : null,
        choices: { A: counts[0], B: counts[1], C: counts[2], D: counts[3], blank }
      };
    })
  };
}

async function listQuizzes(env) {
  const { results } = await env.DB.prepare(
    'SELECT z.id, z.title, COUNT(q.qid) AS questionCount FROM quizzes z LEFT JOIN questions q ON q.quiz_id = z.id GROUP BY z.id ORDER BY z.created_at DESC'
  ).all();
  return { quizzes: results };
}

async function listAssignments(env) {
  const { results } = await env.DB.prepare(`
    SELECT a.*, z.title AS quiz_title,
      (SELECT COUNT(*) FROM attempts t WHERE t.assignment_code = a.code AND t.attempt_no = 1 AND t.submitted_at IS NOT NULL) AS submitted,
      (SELECT COUNT(*) FROM attempts t WHERE t.assignment_code = a.code AND t.attempt_no = 1 AND t.submitted_at IS NULL) AS in_progress,
      (SELECT AVG(score) FROM attempts t WHERE t.assignment_code = a.code AND t.attempt_no = 1 AND t.submitted_at IS NOT NULL) AS avg_score
    FROM assignments a LEFT JOIN quizzes z ON z.id = a.quiz_id
    ORDER BY a.created_at DESC`).all();
  return {
    assignments: results.map(a => ({
      code: a.code, quizId: a.quiz_id, quizTitle: a.quiz_title, title: a.title, modes: a.modes.split(','),
      opensAt: a.opens_at, closesAt: a.closes_at, isOpen: !!a.is_open, createdAt: a.created_at,
      status: assignmentStatus(a), submitted: a.submitted, inProgress: a.in_progress,
      avgScore: a.avg_score == null ? null : Math.round(a.avg_score * 10) / 10
    }))
  };
}

function parseAssignmentInput(b, partial = false) {
  const out = {};
  if (!partial || 'title' in b) {
    out.title = cleanText(b.title, 60);
    if (!out.title) fail(400, '請填寫派卷名稱。');
  }
  if (!partial || 'modes' in b) {
    const modes = Array.isArray(b.modes) ? MODES.filter(x => b.modes.includes(x)) : [];
    if (!modes.length) fail(400, '至少要勾選一種作答模式。');
    out.modes = modes.join(',');
  }
  for (const k of ['opensAt', 'closesAt']) {
    if (!partial || k in b) {
      const v = b[k];
      if (v == null || v === '') out[k] = null;
      else if (Number.isNaN(Date.parse(v))) fail(400, '時間格式不正確。');
      else out[k] = new Date(v).toISOString();
    }
  }
  if (out.opensAt && out.closesAt && out.opensAt >= out.closesAt) fail(400, '截止時間要晚於開放時間。');
  if ('isOpen' in b) out.isOpen = b.isOpen ? 1 : 0;
  return out;
}

// 未指定 API 截止時間時，自開放起提供 24 小時。
function defaultClosingTime(opensAt) {
  const start = typeof opensAt === 'string' ? Date.parse(opensAt) : NaN;
  return new Date((Number.isFinite(start) ? start : Date.now()) + 86400000).toISOString();
}

async function createAssignment(env, b) {
  const quiz = await env.DB.prepare('SELECT id FROM quizzes WHERE id = ?').bind(String(b.quizId || '')).first();
  if (!quiz) fail(400, '請選擇試卷。');
  // 沒給時間：開放＝現在、截止＝開放後 24 小時；明確給 null 才是不限
  const v = parseAssignmentInput({
    ...b,
    opensAt: b.opensAt === undefined ? nowIso() : b.opensAt,
    closesAt: b.closesAt === undefined ? defaultClosingTime(b.opensAt) : b.closesAt
  });
  for (let i = 0; i < 10; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = Array.from(bytes, x => CODE_CHARS[x % CODE_CHARS.length]).join('');
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO assignments (code, quiz_id, title, modes, opens_at, closes_at, is_open, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
    ).bind(code, quiz.id, v.title, v.modes, v.opensAt, v.closesAt, nowIso()).run();
    if (res.meta.changes) return { code };
  }
  fail(500, '無法產生派卷代碼，請再試一次。');
}

async function updateAssignment(env, code, b) {
  const a = await getAssignment(env, code);
  const v = parseAssignmentInput(b, true);
  const merged = {
    title: v.title ?? a.title, modes: v.modes ?? a.modes,
    opens_at: 'opensAt' in v ? v.opensAt : a.opens_at,
    closes_at: 'closesAt' in v ? v.closesAt : a.closes_at,
    is_open: 'isOpen' in v ? v.isOpen : a.is_open
  };
  if (merged.opens_at && merged.closes_at && merged.opens_at >= merged.closes_at) fail(400, '截止時間要晚於開放時間。');
  await env.DB.prepare('UPDATE assignments SET title = ?, modes = ?, opens_at = ?, closes_at = ?, is_open = ? WHERE code = ?')
    .bind(merged.title, merged.modes, merged.opens_at, merged.closes_at, merged.is_open, code).run();
  return { ok: true };
}

async function deleteAssignment(env, code) {
  await getAssignment(env, code);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM answers WHERE attempt_id IN (SELECT id FROM attempts WHERE assignment_code = ?)').bind(code),
    env.DB.prepare('DELETE FROM attempts WHERE assignment_code = ?').bind(code),
    env.DB.prepare('DELETE FROM assignments WHERE code = ?').bind(code)
  ]);
  return { ok: true };
}

async function getReport(env, code) {
  const a = await getAssignment(env, code);
  const quiz = await env.DB.prepare('SELECT title FROM quizzes WHERE id = ?').bind(a.quiz_id).first();
  const qs = await getQuestions(env, a.quiz_id);
  const { results: attempts } = await env.DB.prepare(
    'SELECT * FROM attempts WHERE assignment_code = ? ORDER BY class_name, seat, attempt_no'
  ).bind(code).all();
  const { results: ans } = await env.DB.prepare(
    'SELECT n.attempt_id, n.qid, n.choice FROM answers n JOIN attempts t ON t.id = n.attempt_id WHERE t.assignment_code = ?'
  ).bind(code).all();
  const byAttempt = new Map();
  for (const r of ans) {
    if (!byAttempt.has(r.attempt_id)) byAttempt.set(r.attempt_id, {});
    byAttempt.get(r.attempt_id)[r.qid] = r.choice;
  }
  return {
    assignment: {
      code: a.code, title: a.title, quizId: a.quiz_id, quizTitle: quiz?.title || '', modes: a.modes.split(','),
      opensAt: a.opens_at, closesAt: a.closes_at, isOpen: !!a.is_open, status: assignmentStatus(a), createdAt: a.created_at
    },
    questions: qs.map(q => ({ ...publicQuestion(q), answer: q.answer, explanation: q.explanation })),
    attempts: attempts.map(t => ({
      id: t.id, className: t.class_name, seat: t.seat, name: t.student_name, mode: t.mode,
      attemptNo: t.attempt_no, startedAt: t.started_at, submittedAt: t.submitted_at,
      score: t.score, correctCount: t.correct_count, answers: byAttempt.get(t.id) || {}
    }))
  };
}
