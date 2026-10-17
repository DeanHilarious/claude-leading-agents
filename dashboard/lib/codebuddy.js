'use strict';
// CodeBuddy 汇总与 token。纯函数 + 可注入读取。
const fs = require('fs');

// sum-<键>.txt 一行格式：
// codebuddy exit=0 success session=<id> turns=310 in=10391923 out=52948 denials=0 -> <path>
function parseSumLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!/^codebuddy\b/.test(s)) return null;
  const get = (k) => {
    const m = new RegExp('\\b' + k + '=(\\S+)').exec(s);
    return m ? m[1] : null;
  };
  const num = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);
  const exit = num(get('exit'));
  const subtype = /^codebuddy\s+exit=\d+\s+(\S+)/.exec(s) ? RegExp.$1 : null;
  const tokens = {
    input: num(get('in')) || 0,
    cached: 0,
    output: num(get('out')) || 0,
  };
  tokens.total = tokens.input + tokens.output;
  return {
    exit,
    subtype,
    session: get('session'),
    turns: num(get('turns')),
    input: tokens.input,
    output: tokens.output,
    denials: num(get('denials')),
    tokens,
  };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

// 没有 sum 时读 cb-*.json 里 type:"result" 的 usage
function tokensFromJson(file) {
  const txt = readText(file);
  if (!txt) return null;
  let j;
  try { j = JSON.parse(txt); } catch (e) { return null; }
  const items = Array.isArray(j) ? j : [j];
  let last = null;
  for (const it of items) {
    if (it && it.type === 'result' && it.usage) {
      last = {
        input: it.usage.input_tokens || 0,
        cached: it.usage.cached_input_tokens || 0,
        output: it.usage.output_tokens || 0,
      };
    }
  }
  if (!last) return null;
  last.total = last.input + last.cached + last.output;
  return last;
}

module.exports = { parseSumLine, tokensFromJson, readText };
