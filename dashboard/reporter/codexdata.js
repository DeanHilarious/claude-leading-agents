'use strict';
// Codex 派生数据：从 log-*.txt 头部取 session id，复用 lib/codex.js 的解析
// 生成 {tokens, steps}；steps 的 summary/detail 过脱敏；整体 ≤1MB。
const fs = require('fs');
const path = require('path');
const codex = require('../lib/codex');
const { parseLogHeader } = require('../lib/runs');
const { truncate } = require('../lib/util');

const MAX_JSON = 1024 * 1024;

// 一个任务目录里所有 log-*.txt 头部的 session id（去重）
function sessionIdsOfRun(runDir) {
  const ids = new Set();
  let names;
  try { names = fs.readdirSync(runDir); } catch (e) { return []; }
  for (const name of names) {
    if (!/^log-.*\.txt$/i.test(name)) continue;
    try {
      const h = parseLogHeader(fs.readFileSync(path.join(runDir, name), 'utf8'));
      if (h && h.sessionId && /^[0-9a-f-]{8,64}$/i.test(h.sessionId)) ids.add(h.sessionId);
    } catch (e) { /* 坏日志忽略 */ }
  }
  return [...ids];
}

// 会话文件签名：mtime+size，没变就不重复上传
function fileSig(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + '-' + st.size;
  } catch (e) { return null; }
}

// 生成 PUT /ingest/v1/codex/<machine>/<sessionId> 的载荷
function buildPayload(index, sessionId, redactFn) {
  const file = index.byId[String(sessionId).toLowerCase()];
  if (!file) return null;
  const tokens = codex.readTokens(index, [sessionId]);
  let redactions = 0;
  // parseFeed 已限 300 步（超出保留最后 300）、detail ≤4000
  const steps = codex.parseFeed(file).map((s) => {
    const a = redactFn(s.summary);
    const b = redactFn(s.detail);
    redactions += a.count + b.count;
    return { t: s.t, kind: s.kind, summary: a.text, detail: truncate(b.text, 4000) };
  });
  let payload = { tokens, steps };
  // 整体 ≤1MB，超出从最早的步骤砍起（折半收缩，避免逐条重序列化）
  let s = JSON.stringify(payload);
  while (s.length > MAX_JSON && payload.steps.length > 1) {
    payload.steps = payload.steps.slice(Math.floor(payload.steps.length / 2));
    s = JSON.stringify(payload);
  }
  if (s.length > MAX_JSON) payload = { tokens, steps: [] };
  return { payload: JSON.stringify(payload), redactions };
}

function quotaPayload(index) {
  return codex.readQuota(index);
}

module.exports = { sessionIdsOfRun, buildPayload, quotaPayload, fileSig };
