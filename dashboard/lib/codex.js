'use strict';
// Codex rollout 解析：索引、token、额度、执行过程。路径全部可注入。
const fs = require('fs');
const path = require('path');
const { truncate } = require('./util');

// 扫描 codexHome/sessions 下所有 rollout-*.jsonl，返回按文件名倒序的数组
// 文件名含时间戳，倒序即最新在前（不依赖 mtime，demo 也正确）。
function buildCodexIndex(codexHome) {
  const sessionsDir = path.join(codexHome, 'sessions');
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(ent.name)) files.push(p);
    }
  };
  walk(sessionsDir);
  files.sort((a, b) => (path.basename(b) > path.basename(a) ? 1 : -1));
  // sessionId → 文件路径
  const byId = {};
  for (const f of files) {
    const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.basename(f));
    if (m && !(m[1].toLowerCase() in byId)) byId[m[1].toLowerCase()] = f;
  }
  return { files, byId };
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch (e) { return []; }
}

function parseJson(line) {
  try { return JSON.parse(line); } catch (e) { return null; }
}

// 取一个 rollout 里最后一个 token_count 的 total_token_usage
function tokensFromFile(file) {
  let last = null;
  for (const line of readLines(file)) {
    const j = parseJson(line);
    if (!j) continue;
    const p = j.payload || {};
    if (j.type === 'event_msg' && p.type === 'token_count') {
      const u = (p.info && p.info.total_token_usage) || {};
      last = {
        input: u.input_tokens || 0,
        cached: u.cached_input_tokens || 0,
        output: u.output_tokens || 0,
        total: u.total_tokens || 0,
      };
    }
  }
  return last;
}

// 多个 sessionId 的 token 相加
function readTokens(index, sessionIds) {
  const out = { input: 0, cached: 0, output: 0, total: 0 };
  for (const id of sessionIds || []) {
    const f = index.byId[String(id).toLowerCase()];
    if (!f) continue;
    const t = tokensFromFile(f);
    if (t) {
      out.input += t.input;
      out.cached += t.cached;
      out.output += t.output;
      out.total += t.total;
    }
  }
  return out;
}

// 在最新 20 个 rollout 里倒序找第一个 rate_limits
function readQuota(index) {
  for (const f of index.files.slice(0, 20)) {
    for (const line of readLines(f)) {
      if (line.indexOf('rate_limits') < 0) continue;
      const j = parseJson(line);
      if (!j) continue;
      const p = j.payload || {};
      const rl = p.rate_limits || (p.info && p.info.rate_limits) || null;
      if (!rl) continue;
      const plan = p.plan_type || (p.info && p.info.plan_type) || rl.plan_type || null;
      const conv = (x) => x ? {
        usedPercent: x.used_percent,
        windowMinutes: x.window_minutes,
        resetsAt: x.resets_at ? new Date(x.resets_at * 1000).toISOString() : null,
      } : null;
      return { plan, primary: conv(rl.primary), secondary: conv(rl.secondary) };
    }
  }
  return null;
}

// 从工具调用入参里提取 cmd:"..." 的命令并反转义
function extractCmd(input) {
  if (typeof input !== 'string') return null;
  const m = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (!m) return null;
  return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function stepKind(cmd) {
  if (/apply_patch|Begin Patch/.test(cmd)) return 'edit';
  if (/^(cat|sed|head|tail|rg|grep|ls|find|wc|nl)\b/.test(cmd)) return 'read';
  return 'exec';
}

// 执行过程：最多返回最后 limit 步
function parseFeed(file, limit) {
  const max = limit || 300;
  const steps = [];
  for (const line of readLines(file)) {
    const j = parseJson(line);
    if (!j) continue;
    const p = j.payload || {};
    if (j.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      const raw = p.type === 'custom_tool_call' ? p.input : p.arguments;
      const cmd = extractCmd(raw);
      if (cmd != null) {
        steps.push({ t: j.timestamp || null, kind: stepKind(cmd), summary: truncate(cmd.split('\n')[0], 160), detail: truncate(raw, 4000) });
      }
    } else if (j.type === 'event_msg' && p.type === 'agent_message') {
      steps.push({ t: j.timestamp || null, kind: 'message', summary: truncate(p.message, 160), detail: truncate(p.message, 4000) });
    } else if (j.type === 'event_msg' && p.type === 'task_complete') {
      steps.push({ t: j.timestamp || null, kind: 'done', summary: 'task_complete', detail: '' });
    }
  }
  return steps.length > max ? steps.slice(steps.length - max) : steps;
}

module.exports = { buildCodexIndex, readTokens, readQuota, parseFeed, extractCmd, stepKind };
