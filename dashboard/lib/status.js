'use strict';
// 状态推断（六种）与轮次状态。纯函数，时间全部注入。

const DAY = 86400000;

// 有 events 的子任务：取最后一个事件
// dispatched→running（进程不在且该轮日志>30分钟没更新→failed）
// delivered→review；rejected→rework；accepted→passed；abandoned→failed
function subStatusFromEvents(evts, opts) {
  if (!evts || !evts.length) return null;
  const last = evts[evts.length - 1];
  const now = opts.now;
  const procRunning = opts.procs && opts.procs.has(last.sub);
  const lastLogMs = opts.lastLogMs; // 该子任务最新日志的时间（可空）
  switch (last.event) {
    case 'dispatched':
      if (!procRunning && lastLogMs != null && now - lastLogMs > 30 * 60000) return 'failed';
      return 'running';
    case 'delivered': return 'review';
    case 'rejected': return 'rework';
    case 'accepted': return 'passed';
    case 'abandoned': return 'failed';
    default: return null;
  }
}

// 没有 events 的子任务：
// 进程在跑→running；最后一轮有报告→（24h内 review 否则 ended）；
// 最后一轮没报告且日志 3 分钟内更新→running；否则（24h内 failed，更早 ended）
function subStatusNoEvents(o, opts) {
  const now = opts.now;
  if (opts.procs && opts.procs.has(o.subId)) return 'running';
  const lastRound = o.rounds[o.rounds.length - 1];
  const lastTime = o.lastKnownMs; // 子任务最新已知时间（文件/报告）
  if (lastRound && lastRound.report) {
    return now - lastTime < DAY ? 'review' : 'ended';
  }
  const lastLogMs = o.lastLogMs;
  if (lastLogMs != null && now - lastLogMs <= 3 * 60000) return 'running';
  if (now - lastTime < DAY) return 'failed';
  return 'ended';
}

// 每轮状态：该轮结束于 rejected 或之后有新返工单→rework；最后一轮＝子任务状态
function roundStatuses(rounds, evts, subStatus) {
  return rounds.map((r, i) => {
    if (i === rounds.length - 1) return subStatus;
    // 该轮是否有 rejected 事件
    const rejected = evts.some((e) => e.round === r.n && e.event === 'rejected');
    // 之后是否有新返工单（fix 文件属于后续轮次）
    const laterFix = rounds.slice(i + 1).some((rr) => rr.fix);
    if (rejected || laterFix) return 'rework';
    return 'passed';
  });
}

// 任务状态：running > review > ended
function runStatus(subStats) {
  if (subStats.some((s) => s === 'running')) return 'running';
  if (subStats.some((s) => s === 'review' || s === 'rework')) return 'review';
  return 'ended';
}

module.exports = { subStatusFromEvents, subStatusNoEvents, roundStatuses, runStatus };
