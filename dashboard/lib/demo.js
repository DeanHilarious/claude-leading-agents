'use strict';
// demo 模式：fixtures 的真实 mtime 不可靠，
// 解析时间一律用 events / START 推出，保证结果确定。
const fs = require('fs');
const path = require('path');
const { parseEvents, firstHeading } = require('./runs');
const { parseStartLocal } = require('./util');
const { classifyFile, matchSub } = require('./naming');

// 为一个 run 目录构造 statFile(name)->{mtimeMs, size}
function buildStatFile(runDir, subIds, offsetMin) {
  let events = [];
  try {
    events = parseEvents(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'));
  } catch (e) { events = []; }
  let startMs = null;
  try {
    const startFile = fs.readdirSync(runDir).find((f) => f === 'START' || /^START-/.test(f));
    if (startFile) startMs = parseStartLocal(fs.readFileSync(path.join(runDir, startFile), 'utf8'), offsetMin);
  } catch (e) { /* ignore */ }
  if (startMs == null) startMs = events.length ? events[0].t : 0;
  const later = startMs + 3 * 3600000;
  const cache = {};
  return (name) => {
    if (name in cache) return cache[name];
    let t = null;
    const c = classifyFile(name);
    const owner = matchSub(c.key, subIds);
    if (events.length && owner) {
      // 该子任务对应轮次的首次 dispatched 时间
      let round = c.roundHint || 1;
      if (c.group === 'fix') round = c.hint + 1;
      const evs = events.filter((e) => e.sub === owner && e.round === round);
      if (evs.length) t = evs[0].t;
      else {
        const any = events.filter((e) => e.sub === owner);
        if (any.length) t = round === 1 ? any[0].t : any[any.length - 1].t;
      }
    } else if (!events.length && owner) {
      let round = c.roundHint || 1;
      if (c.group === 'fix') round = c.hint + 1;
      t = round > 1 ? later : startMs;
    }
    if (t == null) t = startMs;
    let size = 0;
    try { size = fs.statSync(path.join(runDir, name)).size; } catch (e) { /* ignore */ }
    const out = { mtimeMs: t, size };
    cache[name] = out;
    return out;
  };
}

module.exports = { buildStatFile };
