// 4.1 总览：标题、统计卡、三列看板、搜索、显示全部
import {
  statusBadge, statCard, subStatusBar, quotaWidget,
  fmtTokensCompact, fmtDuration, timeAgo, fmtClock, emptyState, skeleton, icon
} from '../components.js';
import { escapeHtml } from '../md.js';

// 已结束列默认显示数量
const ENDED_LIMIT = 12;

let state = { data: null, query: '', showAllEnded: false };

function taskCard(run) {
  const agents = [];
  if (run.byAgent) {
    for (const [a, n] of Object.entries(run.byAgent)) {
      if (!n || a === 'unknown') continue;
      agents.push('<span class="rc-meta"><i class="agent-dot d-' + escapeHtml(a) + '"></i>' +
        (a === 'codex' ? 'Codex' : a === 'codebuddy' ? 'CodeBuddy' : escapeHtml(a)) + ' ' + n + '</span>');
    }
  }
  const rework = run.reworkRounds ? '<span class="rc-meta rework">' + icon('rework', 13) + run.reworkRounds + '</span>' : '';
  // 远程模式：底部元信息行显示来源机器（等宽小字）
  const machine = run.machine ? '<span>· <span class="rc-machine">' + escapeHtml(run.machine) + '</span></span>' : '';
  return '<a class="run-card" href="#/run/' + encodeURIComponent(run.id) + '">' +
    '<div class="rc-top"><span class="rc-id">' + escapeHtml(run.id) + '</span>' + statusBadge(run.status) + '</div>' +
    '<div class="rc-title" title="' + escapeHtml(run.title || '') + '">' + escapeHtml(run.title || '（无标题）') + '</div>' +
    '<div class="rc-bar">' + subStatusBar(run.subStatuses) + '</div>' +
    '<div class="rc-meta-row">' + agents.join('') + rework +
    '<span class="rc-meta">' + (run.subtaskCount || 0) + ' 个子任务</span></div>' +
    '<div class="rc-foot"><span title="开工时间">' + fmtClock(run.start) + '</span>' +
    '<span>· ' + fmtDuration(run.durationMs) + '</span>' +
    '<span>· ' + fmtTokensCompact(run.tokens) + ' tok</span>' +
    '<span>· ' + timeAgo(run.updatedAt) + '</span>' + machine + '</div>' +
    '</a>';
}

function column(title, dotCls, runs, count) {
  return '<section class="kanban-col" aria-label="' + title + '">' +
    '<div class="kanban-col-head"><i class="col-dot ' + dotCls + '" aria-hidden="true"></i>' +
    '<h2 class="section-title" style="margin:0">' + title + '</h2><span class="count">' + count + '</span></div>' +
    runs.map(taskCard).join('') +
    '</section>';
}

function matches(run, q) {
  if (!q) return true;
  const hay = ((run.id || '') + ' ' + (run.title || '')).toLowerCase();
  return hay.includes(q);
}

function body(data) {
  const runs = (data.runs || []).filter(r => matches(r, state.query));
  const cols = { running: [], review: [], ended: [] };
  for (const r of runs) {
    const s = r.status === 'running' ? 'running' : (r.status === 'review' || r.status === 'rework') ? 'review' : 'ended';
    cols[s].push(r);
  }
  const endedAll = cols.ended;
  const ended = state.showAllEnded ? endedAll : endedAll.slice(0, ENDED_LIMIT);

  const s = data.stats || {};
  const t7 = s.tokens7d || {};
  const totalTok = (t7.codex || 0) + (t7.codebuddy || 0);
  const cxPct = totalTok ? Math.round((t7.codex || 0) / totalTok * 100) : 50;
  const cbPct = 100 - cxPct;
  const reworkRate = s.reworkRate7d != null ? Math.round(s.reworkRate7d * 100) + '%' : '—';

  let html = '<div class="page"><div class="page-header">' +
    '<div class="grow"><h1 class="page-title">指挥台</h1><p class="page-sub">Claude 派出的所有任务</p></div>' +
    '<label class="search-box">' + icon('search', 14) +
    '<input type="search" id="ov-search" placeholder="搜索任务名或规格标题" value="' + escapeHtml(state.query) + '" aria-label="搜索任务"></label>' +
    '</div>';

  html += '<div class="stat-row">' +
    statCard('进行中的任务',
      String(s.activeRuns != null ? s.activeRuns : '—'),
      '<span class="stat-sub">' + (s.runningAgents != null ? s.runningAgents : '—') + ' 个代理在跑<span class="pulse-dot" aria-hidden="true"></span></span>') +
    statCard('待验收的子任务', String(s.awaitingReview != null ? s.awaitingReview : '—')) +
    statCard('返工率（近 7 天）', reworkRate) +
    statCard('本周 token', fmtTokensCompact(totalTok),
      '<div class="token-bar"><span class="seg-codex" style="width:' + cxPct + '%"></span><span class="seg-codebuddy" style="width:' + cbPct + '%"></span></div>' +
      '<div class="token-legend"><span><i class="seg-codex" style="border-radius:50%"></i>Codex ' + fmtTokensCompact(t7.codex || 0) + '</span>' +
      '<span><i class="seg-codebuddy" style="border-radius:50%"></i>CodeBuddy ' + fmtTokensCompact(t7.codebuddy || 0) + '</span></div>') +
    '</div>';

  if (!runs.length) {
    html += emptyState(state.query ? '没有匹配的任务' : '还没有任务',
      state.query ? '换个关键词试试' : '让 Claude 派一次活，这里就会出现。');
  } else {
    html += '<div class="kanban">' +
      column('进行中', 'd-running', cols.running, cols.running.length) +
      column('待验收', 'd-review', cols.review, cols.review.length) +
      column('已结束', 'd-ended', ended, endedAll.length) +
      '</div>';
    if (!state.showAllEnded && endedAll.length > ENDED_LIMIT) {
      html += '<button type="button" class="show-all-btn" id="ov-show-all">显示全部 ' + endedAll.length + ' 个已结束任务</button>';
    }
  }
  return html + '</div>';
}

function render(container, data) {
  state.data = data;
  const scroll = container.scrollTop;
  // 先构建再替换，避免闪烁
  const tmp = document.createElement('div');
  tmp.innerHTML = body(data);
  container.replaceChildren(tmp);
  container.scrollTop = scroll;

  const search = container.querySelector('#ov-search');
  if (search) {
    search.addEventListener('input', () => {
      state.query = search.value.trim().toLowerCase();
      const t2 = document.createElement('div');
      t2.innerHTML = body(state.data);
      const keepFocus = t2.querySelector('#ov-search');
      if (keepFocus) {
        keepFocus.focus();
        keepFocus.setSelectionRange(keepFocus.value.length, keepFocus.value.length);
      }
      container.replaceChildren(t2);
      bindExtras(container);
    });
  }
  bindExtras(container);
}

function bindExtras(container) {
  const btn = container.querySelector('#ov-show-all');
  if (btn) {
    btn.addEventListener('click', () => {
      state.showAllEnded = true;
      const t2 = document.createElement('div');
      t2.innerHTML = body(state.data);
      container.replaceChildren(t2);
      bindExtras(container);
    });
  }
}

function loading(container) {
  container.innerHTML = '<div class="page">' +
    '<div class="sk-line" style="width:30%;height:28px"></div>' +
    skeleton(6) + '</div>';
}

function error(container, err) {
  container.innerHTML = '<div class="page">' + emptyState('加载失败：' + escapeHtml(err && err.message ? err.message : '未知错误'), '稍后会自动重试，也可以刷新页面试试。') + '</div>';
}

function reset() { state.query = ''; state.showAllEnded = false; }

export { render, loading, error, reset };
