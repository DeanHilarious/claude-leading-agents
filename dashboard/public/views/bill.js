// 4.4 账单：大额度环、范围分段、汇总卡、可排序表格
import { escapeHtml } from '../md.js';
import { quotaRing, fmtNum, fmtTokensCompact, emptyState, skeleton, AGENT_TEXT } from '../components.js';

const RANGES = [{ key: 'today', label: '今天' }, { key: '7d', label: '7 天' }, { key: '30d', label: '30 天' }, { key: 'all', label: '全部' }];
const COLS = [
  { key: 'run', label: '任务', num: false },
  { key: 'sub', label: '子任务', num: false },
  { key: 'agent', label: '代理', num: false },
  { key: 'model', label: '模型', num: false },
  { key: 'input', label: '输入', num: true },
  { key: 'cached', label: '缓存', num: true },
  { key: 'output', label: '输出', num: true },
  { key: 'total', label: '合计', num: true }
];

let state = { range: '7d', sortKey: 'total', sortDir: -1, data: null };

function segBar(t) {
  const total = Math.max((t.input || 0) + (t.cached || 0) + (t.output || 0), 1);
  const p = v => ((v || 0) / total * 100).toFixed(2);
  return '<div class="seg-bar">' +
    '<span class="seg-in" style="width:' + p(t.input) + '%"></span>' +
    '<span class="seg-cached" style="width:' + p(t.cached) + '%"></span>' +
    '<span class="seg-out" style="width:' + p(t.output) + '%"></span></div>' +
    '<div class="seg-legend">' +
    '<span><i class="seg-in"></i>输入 ' + fmtNum(t.input) + '</span>' +
    '<span><i class="seg-cached"></i>缓存 ' + fmtNum(t.cached) + '</span>' +
    '<span><i class="seg-out"></i>输出 ' + fmtNum(t.output) + '</span></div>';
}

function summaryCard(agent, t) {
  return '<div class="bill-card">' +
    '<div class="bc-agent"><i class="agent-dot d-' + agent + '" style="width:10px;height:10px;border-radius:50%;background:var(--' + agent + ');display:inline-block"></i>' + (AGENT_TEXT[agent] || agent) +
    (t.sessions != null ? '<span class="text-3" style="font-weight:400;font-size:12px">· ' + t.sessions + ' 个会话</span>' : '') + '</div>' +
    '<div class="bc-num">' + fmtTokensCompact(t.total) + ' <span class="text-3" style="font-size:14px;font-weight:500">tok</span></div>' +
    segBar(t) + '</div>';
}

function sortedRows(rows) {
  const k = state.sortKey, dir = state.sortDir;
  return rows.slice().sort((a, b) => {
    const va = a[k], vb = b[k];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function table(rows) {
  const th = COLS.map(c => {
    const arrow = state.sortKey === c.key ? (state.sortDir > 0 ? ' ↑' : ' ↓') : '';
    return '<th class="sortable' + (c.num ? ' num' : '') + '" data-sort="' + c.key + '" aria-sort="' +
      (state.sortKey === c.key ? (state.sortDir > 0 ? 'ascending' : 'descending') : 'none') + '">' + c.label + arrow + '</th>';
  }).join('');
  const trs = sortedRows(rows).map(r => '<tr>' +
    '<td class="mono">' + escapeHtml(r.run || '—') + '</td>' +
    '<td class="mono">' + escapeHtml(r.sub || '—') + '</td>' +
    '<td><i class="agent-dot d-' + escapeHtml(r.agent || 'unknown') + '"></i>' + (AGENT_TEXT[r.agent] || '未知') + '</td>' +
    '<td class="mono td-sub">' + escapeHtml(r.model || '—') + '</td>' +
    '<td class="num">' + fmtNum(r.input) + '</td>' +
    '<td class="num">' + fmtNum(r.cached) + '</td>' +
    '<td class="num">' + fmtNum(r.output) + '</td>' +
    '<td class="num">' + fmtNum(r.total) + '</td>' +
    '</tr>').join('');
  // 合计行
  const sum = rows.reduce((acc, r) => {
    acc.input += r.input || 0; acc.cached += r.cached || 0; acc.output += r.output || 0; acc.total += r.total || 0;
    return acc;
  }, { input: 0, cached: 0, output: 0, total: 0 });
  return '<div class="table-wrap"><table class="data-table" aria-label="token 明细">' +
    '<thead><tr>' + th + '</tr></thead><tbody>' + trs +
    '<tr class="total-row"><td colspan="4">合计 · ' + rows.length + ' 行</td>' +
    '<td class="num">' + fmtNum(sum.input) + '</td><td class="num">' + fmtNum(sum.cached) + '</td>' +
    '<td class="num">' + fmtNum(sum.output) + '</td><td class="num">' + fmtNum(sum.total) + '</td></tr>' +
    '</tbody></table></div>';
}

function body(data) {
  const q = data.quota;
  let quotaHtml = '';
  if (q && q.primary) {
    const p = q.primary;
    let reset = '';
    if (p.resetsAt) {
      const t = new Date(p.resetsAt);
      if (!isNaN(t)) reset = (t.getMonth() + 1) + '/' + t.getDate() + ' 重置';
    }
    quotaHtml = '<div class="quota-big">' + quotaRing(p.usedPercent, 120, 10) +
      '<div><div class="q-num">' + Math.round(p.usedPercent) + '%</div>' +
      '<div class="text-2" style="font-size:13px">Codex 周额度' + (q.plan ? ' · ' + escapeHtml(q.plan) : '') + '</div>' +
      (reset ? '<div class="text-3" style="font-size:12px;margin-top:2px">' + reset + '</div>' : '') + '</div></div>';
    if (q.secondary) {
      const s2 = q.secondary;
      quotaHtml += '<div class="quota-big" title="5 小时窗口额度">' + quotaRing(s2.usedPercent, 120, 10) +
        '<div><div class="q-num">' + Math.round(s2.usedPercent) + '%</div>' +
        '<div class="text-2" style="font-size:13px">5 小时窗口</div>' +
        (s2.resetsAt ? '<div class="text-3" style="font-size:12px;margin-top:2px">窗口 ' + fmtNum(s2.windowMinutes) + ' 分钟</div>' : '') + '</div></div>';
    }
  } else {
    quotaHtml = '<div class="quota-big"><div class="q-num text-3">—</div><div class="text-2" style="font-size:13px">额度数据不可用</div></div>';
  }

  const tabs = '<div class="range-tabs" role="group" aria-label="时间范围">' + RANGES.map(r =>
    '<button type="button" data-range="' + r.key + '" aria-pressed="' + (state.range === r.key) + '">' + r.label + '</button>').join('') + '</div>';

  const totals = data.totals || {};
  const cx = totals.codex || { input: 0, cached: 0, output: 0, total: 0, sessions: 0 };
  const cb = totals.codebuddy || { input: 0, cached: 0, output: 0, total: 0, sessions: 0 };
  const rows = data.rows || [];

  return '<div class="page">' +
    '<div class="page-header"><div class="grow"><h1 class="page-title">账单</h1><p class="page-sub">token 都花哪儿了</p></div></div>' +
    '<div class="bill-top">' + quotaHtml + '<div class="spacer" style="flex:1"></div>' + tabs + '</div>' +
    '<div class="bill-cards">' + summaryCard('codex', cx) + summaryCard('codebuddy', cb) + '</div>' +
    (rows.length ? table(rows) : emptyState('这个时间范围内没有 token 记录', '换个时间范围试试。')) +
    '</div>';
}

function bind(container, reload) {
  container.querySelectorAll('[data-range]').forEach(el => {
    el.addEventListener('click', () => {
      const r = el.getAttribute('data-range');
      if (r === state.range) return;
      state.range = r;
      reload();
    });
  });
  container.querySelectorAll('[data-sort]').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.getAttribute('data-sort');
      if (state.sortKey === k) { state.sortDir = -state.sortDir; }
      else { state.sortKey = k; state.sortDir = -1; }
      // 本地重排即可，不用重新请求
      const tmp = document.createElement('div');
      tmp.innerHTML = body(state.data);
      container.replaceChildren(tmp);
      bind(container, reload);
    });
  });
}

function render(container, data) {
  state.data = data;
  const scroll = container.scrollTop;
  const tmp = document.createElement('div');
  tmp.innerHTML = body(data);
  container.replaceChildren(tmp);
  container.scrollTop = scroll;
  // 范围切换交给 app.js 重新拉数据
  bind(container, () => window.dispatchEvent(new CustomEvent('bill-reload', { detail: state.range })));
}

function loading(container) {
  container.innerHTML = '<div class="page">' + skeleton(8) + '</div>';
}

function error(container, err) {
  container.innerHTML = '<div class="page">' + emptyState('加载失败：' + escapeHtml(err && err.message ? err.message : '未知错误'), '稍后会自动重试。') + '</div>';
}

function getRange() { return state.range; }

export { render, loading, error, getRange };
