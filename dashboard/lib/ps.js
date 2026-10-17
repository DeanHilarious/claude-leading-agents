'use strict';
// 读取正在运行的代理进程。--demo 模式不调用。
const { execFileSync } = require('child_process');
const path = require('path');

// run：形如 [{runId, sub, agent}]；runner 可注入便于测试
function listProcs(runsDir, runner) {
  const run = runner || (() => {
    try {
      return execFileSync('ps', ['-Ao', 'pid,lstart,args'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch (e) { return ''; }
  });
  const out = [];
  const abs = path.resolve(runsDir);
  for (const line of run().split('\n')) {
    const isCodex = /\bcodex\b.*\bexec\b/.test(line) && line.includes(abs);
    const isCodebuddy = (/cb\.sh\b/.test(line) || /\bcodebuddy\b.*-p/.test(line)) && line.includes(abs);
    if (!isCodex && !isCodebuddy) continue;
    // 从参数里提取 <RUNS>/<任务>/result-<键>.md 或 spec/fix 文件名
    let sub = null;
    const m = /(result-|spec-|fix-)([\w.\-]+?)\.(md|txt)/.exec(line);
    if (m) sub = m[2];
    if (!sub) continue;
    // 提取任务名（runs 目录后的第一段）
    let runId = null;
    const rm = new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/\\s"\']+)').exec(line);
    if (rm) runId = rm[1];
    if (!runId) continue;
    out.push({ runId, sub, agent: isCodex ? 'codex' : 'codebuddy' });
  }
  return out;
}

module.exports = { listProcs };
