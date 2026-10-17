'use strict';
// 文件名约定解析与子任务归属匹配。纯函数。

// 轮次后缀（按顺序剥离）：-r1、-fix2、-3、-2b
const ROUND_SUFFIX_RE = /(?:-r\d+|-fix\d+|-\d+[a-z]?)$/;

function cap(re, name) {
  const m = re.exec(name);
  return m ? m[1] : null;
}

// 返回 {group, key, roundHint}
// group: spec|report|fix|log|context|other
// key:   归属用的键（已剥掉轮次后缀），spec/context/other 为 null
// roundHint: -r<k> → k+1；fix-...-<N> → N；否则 null
function classifyFile(name) {
  if (name === 'START' || /^START-/.test(name)) {
    return { group: 'other', key: null, roundHint: null, start: true };
  }
  if (name === 'events.jsonl') return { group: 'other', key: null, roundHint: null };
  if (/^context.*\.md$/.test(name)) return { group: 'context', key: null, roundHint: null };
  const specKey = cap(/^spec-(.+)\.md$/, name);
  if (specKey != null) return { group: 'spec', key: specKey, roundHint: null };
  if (/^review.*\.md$/.test(name)) return { group: 'other', key: null, roundHint: null };
  const fixRaw = cap(/^fix-(.+)\.md$/, name);
  if (fixRaw != null) {
    const m = /-(\d+)([a-z]?)$/.exec(fixRaw);
    const roundHint = m ? Number(m[1]) : null;
    const key = fixRaw.replace(ROUND_SUFFIX_RE, '');
    return { group: 'fix', key, roundHint };
  }
  let key = cap(/^result-(.+)\.md$/, name);
  if (key == null) key = cap(/^log-(.+)\.txt$/, name);
  if (key == null) key = cap(/^cb-(.+)\.(?:md|json|err)$/, name);
  if (key == null) key = cap(/^sum-(.+)\.txt$/, name);
  if (key == null) return { group: 'other', key: null, roundHint: null };
  let roundHint = null;
  const rm = /-r(\d+)$/.exec(key);
  if (rm) {
    roundHint = Number(rm[1]) + 1;
    key = key.slice(0, rm.index);
  } else {
    key = key.replace(ROUND_SUFFIX_RE, '');
  }
  const group = /^log-/.test(name) ? 'log' : 'report';
  return { group, key, roundHint };
}

// 键 → 词序列
function words(s) {
  return String(s).split('-').filter(Boolean);
}

// 若 key 的词序列是 subId 词序列的连续一段，返回 {index, len}，否则 null
function contiguousMatch(key, subId) {
  const kw = words(key);
  const sw = words(subId);
  if (!kw.length || kw.length > sw.length) return null;
  for (let i = 0; i + kw.length <= sw.length; i++) {
    let ok = true;
    for (let j = 0; j < kw.length; j++) {
      if (sw[i + j] !== kw[j]) { ok = false; break; }
    }
    if (ok) return { index: i, len: kw.length };
  }
  return null;
}

// 把键归属到子任务 id：匹配词数最多优先，其次 id 最短；不匹配返回 null
function matchSub(key, subIds) {
  if (key == null) return null;
  let best = null;
  let bestLen = -1;
  for (const id of subIds) {
    const m = contiguousMatch(key, id);
    if (m && (m.len > bestLen || (m.len === bestLen && best != null && id.length < best.length))) {
      best = id;
      bestLen = m.len;
    }
  }
  return best;
}

module.exports = { classifyFile, matchSub, contiguousMatch, words };
