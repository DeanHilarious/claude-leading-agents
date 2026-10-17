'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const codex = require('../lib/codex');

const FIX = path.resolve(__dirname, 'fixtures', 'codex-home');
const index = codex.buildCodexIndex(FIX);

test('rollout 索引按 sessionId 建好', () => {
  assert.ok(index.byId['22222222-2222-2222-2222-222222222222'.toLowerCase()]);
  assert.ok(index.byId['33333333-3333-3333-3333-333333333333'.toLowerCase()]);
  assert.equal(index.files.length, 6);
});

test('api 两个会话 token 相加', () => {
  const t = codex.readTokens(index, [
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
  ]);
  assert.equal(t.input, 200000);
  assert.equal(t.cached, 60000);
  assert.equal(t.output, 45000);
  assert.equal(t.total, 305000);
});

test('找不到的会话返回 0', () => {
  const t = codex.readTokens(index, ['00000000-0000-0000-0000-000000000000']);
  assert.equal(t.total, 0);
});

test('额度：primary used_percent 69 / window_minutes 10080 / plan pro', () => {
  const q = codex.readQuota(index);
  assert.ok(q, '读到额度');
  assert.equal(q.plan, 'pro');
  assert.equal(q.primary.usedPercent, 69);
  assert.equal(q.primary.windowMinutes, 10080);
  assert.equal(q.secondary, null);
});

test('feed：kind 判断、cmd 反转义、摘要截断', () => {
  const f = index.byId['11111111-1111-1111-1111-111111111111'.toLowerCase()];
  const steps = codex.parseFeed(f);
  assert.equal(steps[0].kind, 'read');
  assert.equal(steps[0].summary, 'cat src/store.js');
  const edit = steps.find((s) => s.kind === 'edit');
  assert.ok(edit, '有 edit 步骤');
  assert.ok(edit.summary.startsWith('apply_patch'));
  assert.ok(steps.some((s) => s.kind === 'message'));
  assert.ok(steps[steps.length - 1].kind === 'done', 'api 会话有 task_complete');
});

test('e2e 会话无 task_complete（正在运行）', () => {
  const f = index.byId['33333333-3333-3333-3333-333333333333'.toLowerCase()];
  const steps = codex.parseFeed(f);
  assert.ok(!steps.some((s) => s.kind === 'done'));
});

test('extractCmd 反转义 \\n 与 \\"', () => {
  assert.equal(codex.extractCmd('{"cmd":"echo \\"a\\nb\\""}'), 'echo "a\nb"');
  assert.equal(codex.extractCmd('no cmd here'), null);
});

test('parseFeed 最多返回 300 步', () => {
  let lines = '';
  for (let i = 0; i < 400; i++) {
    lines += JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'm' + i } }) + '\n';
  }
  const dir = path.join(__dirname, '.tmp-feed.jsonl');
  require('node:fs').writeFileSync(dir, lines);
  const steps = codex.parseFeed(dir);
  assert.equal(steps.length, 300);
  assert.equal(steps[steps.length - 1].summary, 'm399');
  require('node:fs').rmSync(dir);
});
