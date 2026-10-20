'use strict';
// 由 scanRun 结果组装 API JSON。纯函数。
const os = require('os');
const { toIso, sumTokens } = require('./util');

const DAY = 86400000;

// 隐私：把用户主目录前缀替换成 ~，开源截图不泄露用户名
function maskPath(p) {
  if (typeof p !== 'string') return p;
  const home = os.homedir();
  if (home && home !== '/' && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function roundToJson(r, offsetMin) {
  return {
    n: r.n,
    status: r.status,
    start: toIso(r.startMs, offsetMin),
    end: toIso(r.endMs, offsetMin),
    spec: r.spec,
    report: r.report,
    fix: r.fix,
    log: r.log,
    sessionId: r.sessionId,
  };
}

function subToJson(s, offsetMin) {
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    model: s.model,
    effort: s.effort,
    status: s.status,
    start: toIso(s.startMs, offsetMin),
    end: toIso(s.endMs, offsetMin),
    sessionIds: s.sessionIds,
    tokens: s.tokens,
    rounds: s.rounds.map((r) => roundToJson(r, offsetMin)),
  };
}

// GET /api/runs/:id 的载荷（tokens 为整数 total，明细在 tokensDetail）
function runToJson(run, offsetMin) {
  const tokensDetail = sumTokens(run.subtasks.map((s) => s.tokens));
  return {
    id: run.id,
    machine: run.machine || null,
    title: run.title,
    status: run.status,
    start: toIso(run.startMs, offsetMin),
    updatedAt: toIso(run.updatedAtMs, offsetMin),
    durationMs: run.updatedAtMs != null && run.startMs != null ? Math.max(0, run.updatedAtMs - run.startMs) : 0,
    dir: maskPath(run.dir),
    hasEvents: run.hasEvents,
    subtaskCount: run.subtasks.length,
    byAgent: byAgent(run.subtasks),
    reworkRounds: run.subtasks.reduce((a, s) => a + Math.max(0, s.rounds.length - 1), 0),
    tokens: tokensDetail.total,
    tokensDetail,
    subtasks: run.subtasks.map((s) => subToJson(s, offsetMin)),
    files: run.files.map((f) => ({ name: f.name, group: f.group, size: f.size, mtime: toIso(f.mtimeMs, offsetMin) })),
  };
}

function byAgent(subtasks) {
  const out = { codex: 0, codebuddy: 0, unknown: 0 };
  for (const s of subtasks) {
    if (s.agent in out) out[s.agent]++; else out.unknown++;
  }
  return out;
}

function overviewItem(run, offsetMin) {
  return {
    id: run.id,
    machine: run.machine || null,
    title: run.title,
    status: run.status,
    start: toIso(run.startMs, offsetMin),
    updatedAt: toIso(run.updatedAtMs, offsetMin),
    durationMs: run.updatedAtMs != null && run.startMs != null ? Math.max(0, run.updatedAtMs - run.startMs) : 0,
    subtaskCount: run.subtasks.length,
    byAgent: byAgent(run.subtasks),
    reworkRounds: run.subtasks.reduce((a, s) => a + Math.max(0, s.rounds.length - 1), 0),
    tokens: sumTokens(run.subtasks.map((s) => s.tokens)).total,
    subStatuses: run.subtasks.map((s) => s.status),
  };
}

// GET /api/overview 的载荷
function overview(runs, o) {
  const now = o.now;
  const week = now - 7 * DAY;
  const subs7d = [];
  for (const r of runs) for (const s of r.subtasks) if (s.startMs >= week) subs7d.push(s);
  const reworked = subs7d.filter((s) => s.rounds.length > 1).length;
  const tokens7d = { codex: 0, codebuddy: 0 };
  for (const s of subs7d) {
    if (s.agent in tokens7d) tokens7d[s.agent] += s.tokens.total;
  }
  return {
    generatedAt: toIso(now, o.offsetMin),
    demo: !!o.demo,
    remote: !!o.remote,
    quota: o.quota || null,
    stats: {
      activeRuns: runs.filter((r) => r.status === 'running').length,
      runningAgents: o.runningAgents != null ? o.runningAgents : subs7d.filter((s) => s.status === 'running').length,
      awaitingReview: runs.reduce((a, r) => a + r.subtasks.filter((s) => s.status === 'review').length, 0),
      reworkRate7d: subs7d.length ? Math.round((reworked / subs7d.length) * 100) / 100 : 0,
      tokens7d,
    },
    runs: [...runs].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((r) => overviewItem(r, o.offsetMin)),
  };
}

// GET /api/bill?range=today|7d|30d|all
function bill(runs, range, o) {
  const now = o.now;
  let from;
  if (range === 'today') {
    const d = new Date(now);
    from = now - ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 - d.getMilliseconds();
  } else if (range === '30d') from = now - 30 * DAY;
  else if (range === 'all') from = -Infinity;
  else from = now - 7 * DAY;
  const rows = [];
  const totals = {
    codex: { input: 0, cached: 0, output: 0, total: 0, sessions: 0 },
    codebuddy: { input: 0, cached: 0, output: 0, total: 0, sessions: 0 },
  };
  for (const r of runs.sort((a, b) => b.updatedAtMs - a.updatedAtMs)) {
    for (const s of r.subtasks) {
      if (s.startMs < from) continue;
      rows.push({
        run: r.id,
        sub: s.id,
        agent: s.agent,
        model: s.model,
        input: s.tokens.input,
        cached: s.tokens.cached,
        output: s.tokens.output,
        total: s.tokens.total,
        start: toIso(s.startMs, o.offsetMin),
      });
      const t = totals[s.agent];
      if (t) {
        t.input += s.tokens.input;
        t.cached += s.tokens.cached;
        t.output += s.tokens.output;
        t.total += s.tokens.total;
        t.sessions += s.agent === 'codex' ? s.sessionIds.length : 1;
      }
    }
  }
  return { range, quota: o.quota || null, totals, rows };
}

module.exports = { runToJson, overview, bill, byAgent, maskPath };
