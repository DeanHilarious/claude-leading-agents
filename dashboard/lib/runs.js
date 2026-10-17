'use strict';
// 扫描 run 目录，推断子任务 / 轮次 / 状态。路径与时间全部可注入。
const fs = require('fs');
const path = require('path');
const { classifyFile, matchSub } = require('./naming');
const { subStatusFromEvents, subStatusNoEvents, roundStatuses, runStatus } = require('./status');
const { isCredentialName, parseStartLocal, sumTokens } = require('./util');
const cb = require('./codebuddy');

// 读 events.jsonl，坏行跳过
function parseEvents(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch (e) { continue; }
    const t = Date.parse(j.t);
    if (!j.sub || !j.event || !Number.isFinite(t)) continue;
    out.push({ t, sub: j.sub, event: j.event, agent: j.agent || null, model: j.model || null, effort: j.effort || null, round: j.round || 1, note: j.note || null });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Codex 日志头：model / reasoning effort / session id / OpenAI Codex
function parseLogHeader(text) {
  if (!text) return null;
  const head = text.slice(0, 2000);
  const get = (k) => {
    const m = new RegExp(k + ':\\s*(.+)').exec(head);
    return m ? m[1].trim() : null;
  };
  return {
    codex: /OpenAI Codex/.test(head.split('\n')[0] || ''),
    model: get('model'),
    effort: get('reasoning effort'),
    sessionId: get('session id'),
  };
}

function firstHeading(text) {
  if (!text) return null;
  for (const line of text.split('\n')) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// 轮次报告优先级：.md > sum.txt > .json（.err 不作为报告）
function reportScore(name) {
  if (/\.md$/.test(name)) return 3;
  if (/^sum-.*\.txt$/.test(name)) return 2;
  return 1;
}

// 子任务的轮次划分与文件分配
function buildRounds(subId, o) {
  // 轮号集合：1 + dispatched 轮 + fix 轮(hint+1) + -r<k> 轮(k+1)
  const nums = new Set([1]);
  for (const e of o.events) nums.add(e.round);
  for (const f of o.fixes) nums.add(f.hint + 1);
  for (const f of [...o.reports, ...o.logs]) if (f.roundHint) nums.add(f.roundHint);
  const sorted = [...nums].sort((a, b) => a - b);
  const rounds = sorted.map((n) => {
    const evs = o.events.filter((e) => e.round === n);
    const fix = (o.fixes.find((f) => f.hint + 1 === n) || {}).name || null;
    let start = null;
    if (evs.length) start = evs[0].t;
    else if (fix) start = o.times[fix];
    else if (n === 1 && o.spec) start = o.times[o.spec];
    if (start == null) start = o.subStart;
    return { n, startMs: start, endMs: null, spec: n === 1 ? o.spec : null, report: null, fix, log: null, sessionId: null, evs };
  });
  // 报告/日志分配：有 -r 后缀的直接归对应轮；否则归「开始时间 ≤ mtime」的最后一轮
  for (const f of [...o.reports, ...o.logs]) {
    const ft = o.times[f.name];
    let target = 1;
    if (f.roundHint) target = f.roundHint;
    else {
      for (const r of rounds) if (r.startMs <= ft) target = r.n;
    }
    const r = rounds.find((x) => x.n === target) || rounds[0];
    if (f.group === 'log' && !r.log) r.log = f.name;
    if (f.group === 'report') {
      const sc = reportScore(f.name);
      if (!r.report || sc > r._reportScore) { r.report = f.name; r._reportScore = sc; }
    }
  }
  for (const r of rounds) {
    if (r.log) r.sessionId = (o.logMeta[r.log] || {}).sessionId || null;
    const ends = r.evs.map((e) => e.t);
    if (r.report) ends.push(o.times[r.report]);
    if (r.log) ends.push(o.times[r.log]);
    r.endMs = ends.length ? Math.max(...ends) : r.startMs;
  }
  return rounds;
}

// scanRun(dir, opts)
// opts: {now(ms), procs:Set<subId>, codexIndex, statFile(name)->{mtimeMs,size}}
function scanRun(dir, opts) {
  const now = opts.now;
  const stat = opts.statFile || ((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { mtimeMs: st.mtimeMs, size: st.size };
  });
  const all = fs.readdirSync(dir).filter((f) => {
    if (isCredentialName(f)) return false;
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; }
  });
  const times = {};
  const sizes = {};
  for (const f of all) {
    const st = stat(f);
    times[f] = st ? st.mtimeMs : 0;
    sizes[f] = st ? st.size : 0;
  }
  const events = all.includes('events.jsonl')
    ? parseEvents(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'))
    : [];
  // START 文件
  let startMs = null;
  const startFile = all.find((f) => f === 'START' || /^START-/.test(f));
  if (startFile) {
    startMs = parseStartLocal(fs.readFileSync(path.join(dir, startFile), 'utf8'), opts.offsetMin);
  }
  // 子任务全集
  let subIds;
  if (events.length) {
    subIds = [];
    for (const e of events) if (!subIds.includes(e.sub)) subIds.push(e.sub);
  } else {
    subIds = all.filter((f) => /^spec-.*\.md$/.test(f)).map((f) => f.replace(/^spec-/, '').replace(/\.md$/, ''));
  }
  // 归属
  const per = {};
  for (const id of subIds) per[id] = { spec: null, reports: [], fixes: [], logs: [], cbFiles: [] };
  const files = [];
  const otherFiles = [];
  for (const f of all) {
    const c = classifyFile(f);
    files.push({ name: f, group: c.group, size: sizes[f], mtimeMs: times[f] });
    if (f === 'events.jsonl') continue;
    const owner = matchSub(c.key, subIds);
    if (!owner) { otherFiles.push(f); continue; }
    const p = per[owner];
    if (c.group === 'spec' && !p.spec) p.spec = f;
    else if (c.group === 'report') {
      if (/^cb-.*\.err$/.test(f)) { /* err 永不作为轮次报告 */ }
      else if (/^cb-|^sum-/.test(f)) { p.cbFiles.push(f); p.reports.push({ name: f, group: c.group, roundHint: c.roundHint }); }
      else p.reports.push({ name: f, group: c.group, roundHint: c.roundHint });
    } else if (c.group === 'fix') p.fixes.push({ name: f, hint: c.roundHint });
    else if (c.group === 'log') p.logs.push({ name: f, group: 'log', roundHint: c.roundHint });
  }
  // 日志头缓存
  const logMeta = {};
  for (const id of subIds) {
    for (const l of per[id].logs) {
      logMeta[l.name] = parseLogHeader(fs.readFileSync(path.join(dir, l.name), 'utf8'));
    }
  }
  // 标题
  let title = null;
  const ctxFile = all.find((f) => /^context.*\.md$/.test(f));
  if (ctxFile) title = firstHeading(fs.readFileSync(path.join(dir, ctxFile), 'utf8'));
  // 子任务
  const subtasks = subIds.map((id) => {
    const p = per[id];
    const evts = events.filter((e) => e.sub === id);
    const subStart = evts.length ? evts[0].t : (p.spec ? times[p.spec] : (startMs != null ? startMs : times[all[0]] || now));
    const rounds = buildRounds(id, {
      events: evts, fixes: p.fixes, reports: p.reports, logs: p.logs, spec: p.spec,
      times, subStart, logMeta,
    });
    const specText = p.spec ? fs.readFileSync(path.join(dir, p.spec), 'utf8') : null;
    // agent / model / effort
    let agent = evts.find((e) => e.agent) ? evts.find((e) => e.agent).agent : null;
    let model = evts.find((e) => e.model) ? evts.find((e) => e.model).model : null;
    let effort = evts.find((e) => e.effort) ? evts.find((e) => e.effort).effort : null;
    const firstLogMeta = p.logs.length ? logMeta[p.logs[0].name] : null;
    if (agent == null) agent = p.cbFiles.length ? 'codebuddy' : (firstLogMeta && firstLogMeta.codex ? 'codex' : 'unknown');
    if (model == null && firstLogMeta) model = firstLogMeta.model;
    if (effort == null && firstLogMeta) effort = firstLogMeta.effort;
    // sessionIds
    const sessionIds = rounds.map((r) => r.sessionId).filter(Boolean);
    // 状态
    const knownTimes = [subStart];
    for (const r of rounds) { if (r.startMs != null) knownTimes.push(r.startMs); if (r.endMs != null) knownTimes.push(r.endMs); }
    const lastLogMs = p.logs.length ? Math.max(...p.logs.map((l) => times[l.name])) : null;
    let status;
    if (evts.length) {
      status = subStatusFromEvents(evts, { now, procs: opts.procs, lastLogMs });
      if (status == null) status = 'unknown';
    } else {
      status = subStatusNoEvents({ subId: id, rounds, lastLogMs, lastKnownMs: Math.max(...knownTimes) }, { now, procs: opts.procs });
    }
    const rstatuses = roundStatuses(rounds, evts, status);
    rounds.forEach((r, i) => { r.status = rstatuses[i]; });
    // token
    let tokens = null;
    if (agent === 'codebuddy') {
      // 每轮（含返工）各有一份 sum，用量要累加，不能只取第一份
      for (const sumF of p.cbFiles.filter((f) => /^sum-/.test(f))) {
        const parsed = cb.parseSumLine(fs.readFileSync(path.join(dir, sumF), 'utf8'));
        if (!parsed) continue;
        tokens = tokens || { input: 0, cached: 0, output: 0, total: 0 };
        for (const k of Object.keys(tokens)) tokens[k] += parsed.tokens[k] || 0;
      }
      if (!tokens) {
        const jsonF = p.cbFiles.find((f) => /^cb-.*\.json$/.test(f));
        if (jsonF) tokens = cb.tokensFromJson(path.join(dir, jsonF));
      }
    } else if (agent === 'codex' && opts.codexIndex) {
      tokens = require('./codex').readTokens(opts.codexIndex, sessionIds);
    }
    if (!tokens) tokens = { input: 0, cached: 0, output: 0, total: 0 };
    return {
      id, title: firstHeading(specText) || id, agent, model, effort, status,
      startMs: subStart,
      endMs: Math.max(...knownTimes),
      sessionIds, tokens, rounds,
    };
  });
  // run 级
  const allKnown = [];
  for (const e of events) allKnown.push(e.t);
  for (const f of all) allKnown.push(times[f]);
  const runStart = startMs != null ? startMs : (subtasks.length ? Math.min(...subtasks.map((s) => s.startMs)) : null);
  const updatedAt = allKnown.length ? Math.max(...allKnown) : now;
  return {
    id: path.basename(dir),
    // 任务标题：context 首标题 → 第一个子任务规格标题 → 目录名
    title: title || (subtasks.length ? subtasks[0].title : null) || path.basename(dir),
    dir,
    status: runStatus(subtasks.map((s) => s.status)),
    startMs: runStart,
    updatedAtMs: updatedAt,
    hasEvents: events.length > 0,
    subtasks,
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { scanRun, parseEvents, parseLogHeader, firstHeading };
