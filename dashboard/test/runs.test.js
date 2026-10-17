'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scanRun, parseEvents } = require('../lib/runs');

const FIX = path.resolve(__dirname, 'fixtures');
const NOW = Date.parse('2026-10-17T22:10:00+08:00');

// demo statFile：用 events/START 推导时间（与 server 的 demo 逻辑一致）
const { buildStatFile } = require('../lib/demo');
function demoScanDemo(runId) {
  const dir = path.join(FIX, 'runs', runId);
  let subIds = [];
  const evFile = path.join(dir, 'events.jsonl');
  if (fs.existsSync(evFile)) {
    for (const e of parseEvents(fs.readFileSync(evFile, 'utf8'))) {
      if (!subIds.includes(e.sub)) subIds.push(e.sub);
    }
  } else {
    subIds = fs.readdirSync(dir).filter((f) => /^spec-.*\.md$/.test(f)).map((f) => f.replace(/^spec-|\.md$/g, ''));
  }
  return scanRun(dir, { now: NOW, offsetMin: 480, procs: new Set(), statFile: buildStatFile(dir, subIds, 480) });
}

test('todo-app：三个子任务状态 api=passed ui=review e2e=running', () => {
  const run = demoScanDemo('todo-app');
  assert.equal(run.subtasks.length, 3);
  const by = {};
  for (const s of run.subtasks) by[s.id] = s;
  assert.equal(by.api.status, 'passed');
  assert.equal(by.ui.status, 'review');
  assert.equal(by.e2e.status, 'running');
  assert.equal(run.status, 'running');
});

test('todo-app：api 两轮，第 1 轮 rework、第 2 轮 passed', () => {
  const run = demoScanDemo('todo-app');
  const api = run.subtasks.find((s) => s.id === 'api');
  assert.equal(api.rounds.length, 2);
  assert.equal(api.rounds[0].status, 'rework');
  assert.equal(api.rounds[1].status, 'passed');
  assert.equal(api.rounds[0].spec, 'spec-api.md');
  assert.equal(api.rounds[0].report, 'result-api.md');
  assert.equal(api.rounds[1].fix, 'fix-api-1.md');
  assert.equal(api.rounds[1].report, 'result-api-r1.md');
  assert.equal(api.rounds[1].log, 'log-api-r1.txt');
});

test('legacy-refactor：T0 与 F3 均为 ended，review 文件进 other', () => {
  const run = demoScanDemo('legacy-refactor');
  const by = {};
  for (const s of run.subtasks) by[s.id] = s;
  assert.ok(by['T0-scan'], 'T0 子任务存在');
  assert.ok(by['fix1-F3-gate'], 'F3 子任务存在');
  assert.equal(by['T0-scan'].status, 'ended');
  assert.equal(by['fix1-F3-gate'].status, 'ended');
  assert.equal(by['T0-scan'].agent, 'codebuddy');
  assert.equal(by['fix1-F3-gate'].agent, 'codex');
  const review = run.files.find((f) => f.name === 'review-fix1.md');
  assert.equal(review.group, 'other');
});

test('landing-page：两个子任务均 passed，任务 ended', () => {
  const run = demoScanDemo('landing-page');
  assert.equal(run.subtasks.length, 2);
  assert.ok(run.subtasks.every((s) => s.status === 'passed'));
  assert.equal(run.status, 'ended');
});

// 六种状态场景：临时目录 + 注入 statFile
function tempRun(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-run-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('六种状态至少各出现一次（临时目录场景）', () => {
  const base = Date.parse('2026-10-17T22:10:00+08:00');
  const T = (h) => base - h * 3600000;
  // r: running（日志 1 分钟内更新，无报告）
  // v: review（24h 内有报告）
  // w: rework（rejected 后无下文）
  // p: passed（accepted）
  // f: failed（25h 前派出，日志 26h 前更新，无报告，无进程）
  // e: ended（30h 前有报告）
  const dir = tempRun({
    'START': '2026-10-16T20:00\n',
    'events.jsonl': [
      { t: '2026-10-17T20:00:00+08:00', sub: 'r', event: 'dispatched', round: 1 },
      { t: '2026-10-17T19:00:00+08:00', sub: 'v', event: 'delivered', round: 1 },
      { t: '2026-10-17T18:00:00+08:00', sub: 'w', event: 'rejected', round: 1 },
      { t: '2026-10-17T10:00:00+08:00', sub: 'p', event: 'accepted', round: 1 },
      { t: '2026-10-16T21:00:00+08:00', sub: 'f', event: 'dispatched', round: 1 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n',
    'spec-r.md': '# R\n',
    'spec-v.md': '# V\n',
    'spec-w.md': '# W\n',
    'spec-p.md': '# P\n',
    'spec-f.md': '# F\n',
    'log-r.txt': 'x\n',
    'log-f.txt': 'x\n',
    'result-v.md': '# v 报告\n',
  });
  const statMap = {
    'START': T(26), 'events.jsonl': T(1), 'spec-r.md': T(2), 'spec-v.md': T(3),
    'spec-w.md': T(4), 'spec-p.md': T(12), 'spec-f.md': T(25),
    'log-r.txt': base - 60000, 'log-f.txt': T(26),
    'result-v.md': T(3),
  };
  const run = scanRun(dir, {
    now: base, offsetMin: 480, procs: new Set(),
    statFile: (n) => ({ mtimeMs: statMap[n] || base, size: 10 }),
  });
  const by = {};
  for (const s of run.subtasks) by[s.id] = s.status;
  assert.equal(by.r, 'running');
  assert.equal(by.v, 'review');
  assert.equal(by.w, 'rework');
  assert.equal(by.p, 'passed');
  assert.equal(by.f, 'failed');
  assert.equal(run.status, 'running');
  fs.rmSync(dir, { recursive: true, force: true });
  // ended：无 events 的旧任务，30 小时前有报告
  const dir2 = tempRun({
    'START': '2026-10-16T16:00\n',
    'spec-old.md': '# OLD\n',
    'cb-old.md': '# 旧报告\n',
  });
  const run2 = scanRun(dir2, {
    now: base, offsetMin: 480, procs: new Set(),
    statFile: (n) => ({ mtimeMs: n === 'spec-old.md' ? T(30) : T(30), size: 10 }),
  });
  assert.equal(run2.subtasks[0].status, 'ended');
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('无 events：e2e dispatched 且日志 40 分钟未更新、无进程 → failed', () => {
  const base = Date.parse('2026-10-17T22:10:00+08:00');
  const dir = tempRun({
    'START': '2026-10-17T21:00\n',
    'spec-x.md': '# X\n',
    'log-x.txt': 'x\n',
  });
  const run = scanRun(dir, {
    now: base, offsetMin: 480, procs: new Set(),
    statFile: (n) => ({ mtimeMs: n === 'log-x.txt' ? base - 40 * 60000 : Date.parse('2026-10-17T21:00:00+08:00'), size: 5 }),
  });
  assert.equal(run.subtasks[0].status, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('demo 数据三任务状态：running / ended / ended', () => {
  for (const id of ['todo-app', 'legacy-refactor', 'landing-page']) {
    const run = demoScanDemo(id);
    if (id === 'todo-app') assert.equal(run.status, 'running');
    else assert.equal(run.status, 'ended');
  }
});
