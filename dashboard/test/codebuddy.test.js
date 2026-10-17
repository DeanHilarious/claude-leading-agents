'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const cb = require('../lib/codebuddy');

test('sum 行解析：exit/session/turns/in/out/denials', () => {
  const s = cb.parseSumLine('codebuddy exit=0 success session=demo-ui-001 turns=12 in=520000 out=23000 denials=0 -> /home/demo/ui/app.js\n');
  assert.equal(s.exit, 0);
  assert.equal(s.subtype, 'success');
  assert.equal(s.session, 'demo-ui-001');
  assert.equal(s.turns, 12);
  assert.equal(s.input, 520000);
  assert.equal(s.output, 23000);
  assert.equal(s.denials, 0);
  assert.equal(s.tokens.cached, 0);
  assert.equal(s.tokens.total, 543000);
});

test('sum 行解析失败返回 null', () => {
  assert.equal(cb.parseSumLine('随便一行'), null);
  assert.equal(cb.parseSumLine(''), null);
});

test('没有 sum 时从 cb-*.json 的 result 读 usage', () => {
  const t = cb.tokensFromJson(path.join(__dirname, 'fixtures/runs/todo-app/cb-ui.json'));
  assert.equal(t.input, 518000);
  assert.equal(t.output, 22800);
  assert.equal(t.total, 540800);
});

test('解析不到 result 返回 null', () => {
  const t = cb.tokensFromJson(path.join(__dirname, 'fixtures/runs/todo-app/sum-ui.txt'));
  assert.equal(t, null);
});
