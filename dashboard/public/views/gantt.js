// 4.2 甘特时间线：每个子任务一行，每轮一段色块
import { escapeHtml } from '../md.js';
import { fmtClock, pad, fmtDuration } from '../components.js';

const LABEL_W = 160;
const AGENT_COLOR = { codex: 'var(--codex)', codebuddy: 'var(--codebuddy)', unknown: 'var(--text-3)' };

export function renderGantt(subtasks, runStart, nowIso) {
  // 用服务端的「现在」，演示数据才不会被真实时钟拉长
  const clock = nowIso && !isNaN(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now();
  const list = (subtasks || []).filter(st => st.start);
  if (!list.length) return '';
  let min = Infinity, max = -Infinity;
  for (const st of list) {
    const s = new Date(st.start).getTime();
    let e = st.end ? new Date(st.end).getTime() : clock;
    if (isNaN(s)) continue;
    if (e <= s) e = s + 60000;
    min = Math.min(min, s); max = Math.max(max, e);
  }
  if (!isFinite(min) || !isFinite(max)) return '';
  if (runStart && !isNaN(new Date(runStart))) min = Math.min(min, new Date(runStart).getTime());
  const now = clock;
  if (now > max) max = now;
  const span = Math.max(max - min, 60000);
  const W = 100; // 百分比刻度
  const pct = t => ((t - min) / span) * W;

  // 刻度：最多 6 个；同一天只显示 HH:MM，跨天才显示日期；最后一个右对齐不溢出
  let ticks = '';
  const n = Math.min(6, Math.max(2, Math.round(span / 1800000) + 1));
  let prevDay = null;
  for (let i = 0; i <= n; i++) {
    const t = min + span * i / n;
    const d = new Date(t);
    const day = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const label = (i > 0 && day !== prevDay)
      ? pad(d.getMonth() + 1) + '/' + pad(d.getDate())
      : pad(d.getHours()) + ':' + pad(d.getMinutes());
    prevDay = day;
    if (i === n) {
      ticks += '<span class="gantt-tick gantt-tick-last" style="right:0">' + label + '</span>';
    } else {
      ticks += '<span class="gantt-tick" style="left:' + (i / n * 100).toFixed(2) + '%">' + label + '</span>';
    }
  }

  let rows = '';
  for (const st of list) {
    const color = AGENT_COLOR[st.agent] || AGENT_COLOR.unknown;
    let segs = '';
    for (const r of st.rounds || []) {
      if (!r.start) continue;
      const s = new Date(r.start).getTime();
      let e = r.end ? new Date(r.end).getTime() : Math.max(clock, s + 60000);
      if (isNaN(s)) continue;
      if (e <= s) e = s + 60000;
      const left = pct(s), right = pct(e);
      const isRw = r.n >= 2;
      const tip = 'R' + r.n + ' · ' + fmtClock(r.start) + '–' + fmtClock(r.end) + ' · ' + fmtDuration(e - s);
      segs += '<span class="gantt-seg' + (isRw ? ' rw' : '') + '" style="left:' + left.toFixed(2) + '%;width:' +
        Math.max(right - left, 0.5).toFixed(2) + '%;background:' + color + '" title="' + escapeHtml(tip) + '" tabindex="0" role="img" aria-label="' + escapeHtml(tip) + '"></span>';
    }
    const nowPct = pct(clock);
    rows += '<div class="gantt-row">' +
      '<span class="g-label" title="' + escapeHtml(st.title || st.id) + '">' + escapeHtml(st.title || st.id) + '</span>' +
      '<div class="gantt-track">' + segs +
      (nowPct >= 0 && nowPct <= 100 ? '<span class="gantt-now" style="left:' + nowPct.toFixed(2) + '%" title="现在"></span>' : '') +
      '</div></div>';
  }

  return '<div class="gantt-wrap" role="region" aria-label="时间线">' +
    '<div class="gantt">' +
    '<div class="gantt-scale">' + ticks + '</div>' +
    rows +
    '</div></div>';
}
