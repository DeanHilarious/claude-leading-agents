'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyFile, matchSub } = require('../lib/naming');

test('spec 文件分组与键', () => {
  const c = classifyFile('spec-fix1-F3-gate.md');
  assert.equal(c.group, 'spec');
  assert.equal(c.key, 'fix1-F3-gate');
});

test('review 归 other', () => {
  assert.equal(classifyFile('review-fix1.md').group, 'other');
});

test('fix 文件的轮次后缀', () => {
  const a = classifyFile('fix-F3-1.md');
  const b = classifyFile('fix-F3-2b.md');
  assert.equal(a.group, 'fix');
  assert.equal(a.key, 'F3');
  assert.equal(a.roundHint, 1);
  assert.equal(b.roundHint, 2);
  assert.equal(b.key, 'F3');
});

test('-r<k> 后缀直接归第 k+1 轮', () => {
  const c = classifyFile('result-fix1-F3-r1.md');
  assert.equal(c.group, 'report');
  assert.equal(c.key, 'fix1-F3');
  assert.equal(c.roundHint, 2);
  const l = classifyFile('log-fix1-F1-r1.txt');
  assert.equal(l.group, 'log');
  assert.equal(l.roundHint, 2);
  assert.equal(l.key, 'fix1-F1');
});

test('旧命名归属：cb-fix1-F3 归 fix1-F3-gate', () => {
  const ids = ['T0-scan', 'fix1-F3-gate'];
  assert.equal(matchSub(classifyFile('cb-fix1-F3.md').key, ids), 'fix1-F3-gate');
  assert.equal(matchSub(classifyFile('sum-fix1-F3-r1.txt').key, ids), 'fix1-F3-gate');
  assert.equal(matchSub(classifyFile('cb-T0.md').key, ids), 'T0-scan');
});

test('fix-F3-1 归 F3 子任务，review 不归属', () => {
  const ids = ['fix1-F3-gate', 'fix1-F1'];
  assert.equal(matchSub(classifyFile('fix-F3-1.md').key, ids), 'fix1-F3-gate');
  assert.equal(matchSub(classifyFile('review-fix1.md').key, ids), null);
});

test('匹配词数最多优先，再选 id 最短', () => {
  const ids = ['a-F3', 'a-F3-gate'];
  assert.equal(matchSub('a-F3', ids), 'a-F3');
  assert.equal(matchSub('F3', ids), 'a-F3');
});

test('log-fix1-F1-r1 归 fix1-F1', () => {
  const ids = ['fix1-F1', 'fix1-F3-gate'];
  assert.equal(matchSub(classifyFile('log-fix1-F1-r1.txt').key, ids), 'fix1-F1');
});
