// 把題目 JSON 檔匯入線上測驗題庫（可同時派卷），印出學生測驗網址。
// 用法：
//   node scripts/agent-create-quiz.mjs <題目.json>              建卷並派卷（預設：立即開放、24 小時後截止、兩種模式）
//   node scripts/agent-create-quiz.mjs <題目.json> --no-assign  只匯入題庫，不派卷（老師之後在後台派）
//   node scripts/agent-create-quiz.mjs <題目.json> --check      只在本機檢查格式，不送出
// 使用環境變數 QUIZ_AGENT_KEY 傳入金鑰。
// 題目 JSON 格式見 examples/quiz.json。
import fs from 'node:fs';

const BASE = (process.env.QUIZ_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const noAssign = args.includes('--no-assign');
const checkOnly = args.includes('--check');
if (!file) { console.error('用法：node scripts/agent-create-quiz.mjs <題目.json> [--no-assign] [--check]'); process.exit(1); }

let body;
try { body = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
catch (e) { console.error('讀不到或不是合法 JSON：' + e.message); process.exit(1); }
if (noAssign) body.assign = false;

// ---- 本機格式與品質檢查（伺服器也會再檢查一次格式） ----
const errs = [], warns = [];
if (!String(body.title || '').trim()) errs.push('缺少 title');
const qs = Array.isArray(body.questions) ? body.questions : [];
if (!qs.length || qs.length > 100) errs.push('questions 需為 1～100 題');
const ans = [];
qs.forEach((q, i) => {
  const n = i + 1;
  if (!String(q.question ?? q.title ?? '').trim()) errs.push(`第 ${n} 題缺少 question`);
  if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => !String(o ?? '').trim())) errs.push(`第 ${n} 題 options 必須剛好 4 個非空白選項`);
  const a = String(q.answer ?? '').trim().toUpperCase();
  const idx = /^[ABCD]$/.test(a) ? a.charCodeAt(0) - 65 : [0, 1, 2, 3].includes(q.answer) ? q.answer : null;
  if (idx == null) errs.push(`第 ${n} 題 answer 必須是 A/B/C/D`);
  ans.push(idx);
  if (Array.isArray(q.options) && q.options.length === 4) {
    if (q.options.some(o => /^\s*[\(（]?[A-Da-d][\)）\.．、]/.test(String(o)))) warns.push(`第 ${n} 題選項開頭有 A./(A) 等編號，系統會自動加，請拿掉`);
    const lens = q.options.map(o => String(o).replace(/<[^>]+>/g, '').length);
    if (Math.max(...lens) - Math.min(...lens) > Math.max(4, Math.min(...lens) * 0.5)) warns.push(`第 ${n} 題選項長度差距大（${lens.join('/')}），可能洩漏答案`);
  }
  if (!q.explanation) warns.push(`第 ${n} 題沒有 explanation（解析）`);
});
let run = 1;
for (let i = 1; i < ans.length; i++) { run = ans[i] === ans[i - 1] ? run + 1 : 1; if (run > 2) { warns.push(`第 ${i - 1}～${i + 1} 題答案連續 3 題相同`); break; } }
const dist = [0, 1, 2, 3].map(k => ans.filter(x => x === k).length);
console.log(`題數 ${qs.length}；答案分布 A:${dist[0]} B:${dist[1]} C:${dist[2]} D:${dist[3]}`);
warns.forEach(w => console.log('⚠ ' + w));
if (errs.length) { errs.forEach(e => console.error('✘ ' + e)); process.exit(1); }
if (checkOnly) { console.log('✔ 格式檢查通過（--check 未送出）'); process.exit(0); }

// ---- 送出 ----
const key = process.env.QUIZ_AGENT_KEY;
if (!key) {
  console.error('請在執行的終端機設定環境變數 QUIZ_AGENT_KEY。');
  process.exit(1);
}

const res = await fetch(`${BASE}/quiz/api/agent/quizzes`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body)
});
const data = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`✘ 伺服器回應 ${res.status}：${data.error || '未知錯誤'}`); process.exit(1); }

const formatTime = s => s ? new Date(s).toLocaleString('zh-TW', { hour12: false }) : '不限';
console.log('\n✔ 已匯入題庫');
console.log(`  試卷代碼 quizId：${data.quizId}（${data.questionCount} 題）`);
if (data.studentUrl) {
  console.log(`  派卷代碼：${data.code}`);
  console.log(`  學生測驗網址：${data.studentUrl}`);
  console.log(`  開放：${formatTime(data.opensAt)}　截止：${formatTime(data.closesAt)}`);
} else {
  console.log('  （未派卷：老師可到後台「派出新考卷」選這份試卷）');
}
console.log(`  老師後台：${BASE}/quiz/teacher/`);
