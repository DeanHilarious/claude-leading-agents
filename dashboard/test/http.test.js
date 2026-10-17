'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server');

const FIX = path.resolve(__dirname, 'fixtures');
let app;
let port;
let base;

async function get(p, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: p,
      headers: { Host: host || ('127.0.0.1:' + port) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

test.before(async () => {
  app = createApp({ demo: true, runs: path.join(FIX, 'runs'), codexHome: path.join(FIX, 'codex-home') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  base = '127.0.0.1:' + port;
});

test.after(() => { app.server.close(); });

test('overview：3 个任务，todo-app=running，其余 ended，quota 69', async () => {
  const r = await get('/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const j = JSON.parse(r.body);
  assert.equal(j.demo, true);
  assert.equal(j.runs.length, 3);
  const by = {};
  for (const run of j.runs) by[run.id] = run;
  assert.equal(by['todo-app'].status, 'running');
  assert.equal(by['legacy-refactor'].status, 'ended');
  assert.equal(by['landing-page'].status, 'ended');
  assert.equal(by['todo-app'].subStatuses.sort().join(','), 'passed,review,running');
  assert.equal(j.quota.plan, 'pro');
  assert.equal(j.quota.primary.usedPercent, 69);
  assert.equal(j.stats.tokens7d.codex > 0, true);
  assert.equal(j.stats.tokens7d.codebuddy > 0, true);
});

test('runs/:id：todo-app 子任务与轮次', async () => {
  const r = await get('/api/runs/todo-app');
  const j = JSON.parse(r.body);
  assert.equal(j.id, 'todo-app');
  assert.equal(j.hasEvents, true);
  // tokens 是整数（契约），明细在 tokensDetail；dir 打码以 ~ 开头
  assert.equal(j.tokens, 916000);
  assert.equal(j.tokensDetail.total, 916000);
  assert.equal(j.tokensDetail.input, 200000 + 520000 + 50000);
  assert.ok(j.dir.startsWith('~'), 'dir 应以 ~ 开头：' + j.dir);
  const by = {};
  for (const s of j.subtasks) by[s.id] = s;
  assert.equal(by.api.status, 'passed');
  assert.equal(by.api.rounds.length, 2);
  assert.equal(by.api.rounds[0].status, 'rework');
  assert.equal(by.api.rounds[1].fix, 'fix-api-1.md');
  assert.equal(by.api.rounds[1].report, 'result-api-r1.md');
  assert.equal(by.ui.status, 'review');
  // CodeBuddy 报告优先 .md
  assert.equal(by.ui.rounds[0].report, 'cb-ui.md');
  assert.equal(by.e2e.status, 'running');
  assert.equal(by.api.tokens.input, 200000);
  assert.equal(by.ui.tokens.input, 520000);
  assert.ok(j.files.some((f) => f.name === 'context.md' && f.group === 'context'));
});

test('任务标题：context 或规格首标题，不显示任务 id', async () => {
  const todo = JSON.parse((await get('/api/runs/todo-app')).body);
  assert.equal(todo.title, '待办应用（todo-app）');
  const legacy = JSON.parse((await get('/api/runs/legacy-refactor')).body);
  assert.equal(legacy.title, '扫描旧模块依赖');
  const landing = JSON.parse((await get('/api/runs/landing-page')).body);
  assert.equal(landing.title, '实现落地页首屏');
  const ov = JSON.parse((await get('/api/overview')).body);
  const titles = ov.runs.map((x) => x.title);
  assert.ok(titles.includes('扫描旧模块依赖'));
  assert.ok(titles.includes('实现落地页首屏'));
});

test('runs/nope → 404', async () => {
  const r = await get('/api/runs/nope');
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).error, 'not found');
});

test('文件接口：正常读取与路径穿越 400', async () => {
  const ok = await get('/api/runs/todo-app/file?name=spec-api.md');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes('# 实现待办 API'));
  assert.equal(ok.headers['content-type'], 'text/plain; charset=utf-8');
  const bad = await get('/api/runs/todo-app/file?name=' + encodeURIComponent('../x'));
  assert.equal(bad.status, 400);
  const cred = await get('/api/runs/todo-app/file?name=auth.json');
  assert.equal(cred.status, 400);
  const nf = await get('/api/runs/todo-app/file?name=nope.md');
  assert.equal(nf.status, 404);
});

test('Host: evil.com → 403', async () => {
  const r = await get('/api/overview', 'evil.com:1234');
  assert.equal(r.status, 403);
});

test('bill?range=all：分代理汇总与行', async () => {
  const r = await get('/api/bill?range=all');
  const j = JSON.parse(r.body);
  assert.equal(j.range, 'all');
  assert.ok(j.rows.length >= 7);
  assert.equal(j.totals.codex.input >= 200000, true);
  assert.equal(j.totals.codebuddy.input >= 543000 + 91000, true);
  const row = j.rows.find((x) => x.run === 'todo-app' && x.sub === 'api');
  assert.equal(row.agent, 'codex');
});

test('feed：codebuddy 返回 summary，codex 返回 steps', async () => {
  const ui = await get('/api/runs/todo-app/subtasks/ui/feed');
  const ju = JSON.parse(ui.body);
  assert.equal(ju.agent, 'codebuddy');
  assert.deepEqual(ju.steps, []);
  assert.equal(ju.summary.session, 'demo-ui-001');
  assert.equal(ju.summary.turns, 12);
  const api = await get('/api/runs/todo-app/subtasks/api/feed');
  const ja = JSON.parse(api.body);
  assert.equal(ja.agent, 'codex');
  assert.ok(ja.steps.length > 0);
  assert.ok(ja.steps[0].summary.length > 0);
});

test('未知 /api/* → 404 JSON', async () => {
  const r = await get('/api/whatever');
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).error, 'not found');
});

test('GET / 无 public 时返回提示页', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('指挥台') || r.body.includes('html'));
});

test('maskPath：主目录前缀替换为 ~，其余原样', async () => {
  const { maskPath } = require('../lib/aggregate');
  const os = require('node:os');
  assert.equal(maskPath(os.homedir() + '/.codex-runs/oc102'), '~/.codex-runs/oc102');
  assert.equal(maskPath('/tmp/other'), '/tmp/other');
  assert.equal(maskPath(os.homedir()), '~');
});

test('run 详情带服务端时钟（演示模式固定为 22:10）', async () => {
  const j = JSON.parse((await get('/api/runs/todo-app')).body);
  assert.equal(new Date(j.generatedAt).getTime(), new Date('2026-10-17T22:10:00+08:00').getTime());
});
