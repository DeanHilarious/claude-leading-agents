// 4.3 子任务抽屉：对照 / 执行过程 / 日志
import { getRun, getFile, getFeed } from '../api.js';
import { render as mdRender, escapeHtml } from '../md.js';
import {
  agentBadge, icon, copyBtn, bindCopy, fmtTokensCompact, fmtNum,
  STATUS_TEXT, skeleton, emptyState
} from '../components.js';

const drawerEl = document.getElementById('drawer');
const maskEl = document.getElementById('drawer-mask');

let state = {
  runId: null, subId: null, sub: null,
  tab: 'compare', round: 1, files: {},
  feed: [], feedLive: false, autoScroll: true,
  lastFocus: null, onSubscribed: null
};

const FEED_ICON = { read: 'read', exec: 'exec', edit: 'edit', message: 'talk', done: 'done' };

function head() {
  const st = state.sub || {};
  const tok = st.tokens || {};
  const sid = (st.sessionIds || [])[0];
  return '<div class="drawer-head">' +
    '<div class="dh-top">' +
    '<span class="dh-title">' + escapeHtml(st.title || st.id || '') + '</span>' +
    agentBadge(st.agent) +
    '<button type="button" class="icon-btn" id="drawer-close" aria-label="关闭抽屉">' + icon('close', 16) + '</button>' +
    '</div>' +
    '<div class="dh-meta">' +
    '<span class="m mono">' + escapeHtml([st.model, st.effort].filter(Boolean).join(' · ') || '模型未知') + '</span>' +
    (sid ? '<span class="m mono" title="' + escapeHtml(st.sessionIds.join(', ')) + '">' + escapeHtml(sid.slice(0, 8)) + '…' + copyBtn(st.sessionIds.join('\n'), '复制会话 ID') + '</span>' : '') +
    '<span class="m" title="输入 ' + fmtNum(tok.input) + ' · 缓存 ' + fmtNum(tok.cached) + ' · 输出 ' + fmtNum(tok.output) + '">输入 ' + fmtTokensCompact(tok.input) + ' · 缓存 ' + fmtTokensCompact(tok.cached) + ' · 输出 ' + fmtTokensCompact(tok.output) + '</span>' +
    '</div></div>';
}

function tabs() {
  const t = (key, label) => '<button type="button" role="tab" class="drawer-tab" data-tab="' + key + '" aria-selected="' + (state.tab === key) + '">' + label + '</button>';
  const isCodebuddy = state.sub && state.sub.agent === 'codebuddy';
  return '<div class="drawer-tabs" role="tablist">' +
    t('compare', '对照') +
    (isCodebuddy ? t('feed', '执行过程') : t('feed', '执行过程')) +
    t('log', '日志') + '</div>';
}

function roundSwitch(rounds) {
  if (!rounds || rounds.length < 2) return '';
  let btns = '';
  for (const r of rounds) {
    btns += '<button type="button" data-round="' + r.n + '" aria-pressed="' + (r.n === state.round) + '"' +
      ' title="' + (STATUS_TEXT[r.status] || '') + '">R' + r.n + '</button>';
  }
  return '<span class="round-switch" role="group" aria-label="轮次切换">' + btns + '</span>';
}

async function docColumn(title, fileName) {
  let inner;
  if (!fileName) {
    inner = '<p class="text-3">无</p>';
  } else if (state.files[fileName] !== undefined) {
    inner = state.files[fileName]
      ? '<div class="md-body">' + mdRender(state.files[fileName]) + '</div>'
      : '<p class="text-3">读取失败</p>';
  } else {
    inner = skeleton(3);
    loadFile(fileName);
  }
  return '<div class="compare-col"><div class="col-head"><h3 class="section-title" style="margin:0">' + title + '</h3></div>' + inner + '</div>';
}

async function loadFile(name) {
  try {
    const text = await getFile(state.runId, name);
    state.files[name] = text;
  } catch (e) {
    state.files[name] = null;
  }
  if (state.subId) rerenderBody();
}

// 对照视图：三栏（规格 / 交付报告 / 返工单）+ 轮次切换
async function renderCompare() {
  const rounds = state.sub ? state.sub.rounds : [];
  const r = (rounds || []).find(x => x.n === state.round) || (rounds || [])[0];
  if (!r) return emptyState('这个子任务没有轮次数据');
  const col = async (label, name) => {
    let inner;
    if (!name) inner = '<p class="text-3">无</p>';
    else if (state.files[name] !== undefined) {
      inner = state.files[name] ? '<div class="md-body">' + mdRender(state.files[name]) + '</div>' : '<p class="text-3">读取失败</p>';
    } else {
      inner = skeleton(3);
      loadFile(name);
    }
    return '<div class="compare-col"><div class="col-head"><h3 class="section-title" style="margin:0">' + label + '</h3></div>' + inner + '</div>';
  };
  // 后续轮次 spec 为 null 时回退显示第 1 轮规格
  const firstSpec = (rounds[0] || {}).spec;
  const specName = r.spec || firstSpec;
  const specLabel = r.spec ? '规格' : (specName ? '规格（R1）' : '规格');
  const spec = await col(specLabel, specName);
  const report = await col('交付报告', r.report);
  const fix = await col('返工单', r.fix);
  return '<div style="margin-bottom:16px">' + roundSwitch(rounds) + '</div>' +
    '<div class="compare-grid">' + spec + report + fix + '</div>';
}

function feedView() {
  if (state.sub && state.sub.agent === 'codebuddy') {
    const s = state.feedSummary;
    if (!s) return emptyState('CodeBuddy 结束后才输出结果', '跑完之后这里会显示一行汇总。');
    const cells = [
      ['exit', s.exit != null ? s.exit : '—'], ['结果', s.subtype || '—'],
      ['轮次', s.turns != null ? s.turns : '—'], ['输入', fmtTokensCompact(s.input)],
      ['输出', fmtTokensCompact(s.output)], ['拒绝', s.denials != null ? s.denials : '—']
    ];
    return '<p class="text-2" style="margin-top:0">CodeBuddy 结束后才输出结果，下面是汇总：</p>' +
      '<div class="cb-summary">' + cells.map(c => '<div class="cell"><span>' + c[0] + '</span><b class="mono">' + escapeHtml(String(c[1])) + '</b></div>').join('') + '</div>' +
      (s.session ? '<p class="text-3 mono" style="font-size:12px">session ' + escapeHtml(s.session) + '</p>' : '');
  }
  if (!state.feed.length) return emptyState('还没有执行记录', '代理开始干活后这里会实时出现每一步。');
  let html = '<div class="feed-list" id="feed-list">';
  for (const s of state.feed) {
    const ic = FEED_ICON[s.kind] || 'exec';
    html += '<div class="feed-item" data-ts="' + escapeHtml(s.t || '') + '">' +
      '<button type="button" class="feed-row" aria-label="展开详情">' +
      '<span class="feed-icon k-' + escapeHtml(s.kind) + '">' + icon(ic, 13) + '</span>' +
      '<span class="feed-summary" title="' + escapeHtml(s.summary || '') + '">' + escapeHtml(s.summary || s.kind) + '</span>' +
      '<span class="feed-time">' + (s.t ? escapeHtml(String(s.t).slice(11, 16)) : '') + '</span>' +
      '</button>' +
      '<div class="feed-detail"><pre>' + escapeHtml(s.detail || s.summary || '') + '</pre></div>' +
      '</div>';
  }
  return html + '</div>';
}

function logView() {
  const rounds = (state.sub && state.sub.rounds) || [];
  const log = state.roundLogName || (rounds[rounds.length - 1] || {}).log;
  if (!log) return emptyState('没有日志文件');
  if (state.files[log] !== undefined) {
    const text = state.files[log] || '';
    const lines = text.split('\n');
    const tail = lines.slice(-400).join('\n');
    return '<pre class="log-view" aria-label="日志尾部">' + escapeHtml(tail) + '</pre>';
  }
  loadLog(log);
  return skeleton(5);
}

async function loadLog(name) {
  state.roundLogName = name;
  if (state.files[name] !== undefined) { rerenderBody(); return; }
  try {
    const text = await getFile(state.runId, name);
    state.files[name] = text;
  } catch (e) {
    state.files[name] = null;
  }
  if (state.subId) rerenderBody();
}

async function loadFeed() {
  try {
    const data = await getFeed(state.runId, state.subId);
    state.feed = data.steps || [];
    state.feedLive = !!data.live;
    state.feedSummary = data.summary || null;
  } catch (e) {
    state.feed = []; state.feedSummary = null;
  }
  if (state.subId) rerenderBody();
}

function rerenderBody() {
  const bodyEl = drawerEl.querySelector('.drawer-body');
  if (!bodyEl || !state.sub) return;
  const scroll = bodyEl.scrollTop;
  let html;
  if (state.tab === 'compare') {
    renderCompare().then(h => {
      bodyEl.innerHTML = h;
      bindBody(bodyEl);
      bodyEl.scrollTop = scroll;
    });
    return;
  }
  if (state.tab === 'feed') {
    html = feedView();
    bodyEl.innerHTML = html;
    bindBody(bodyEl);
    if (state.autoScroll) {
      const list = bodyEl.querySelector('#feed-list');
      if (list) list.lastElementChild && list.lastElementChild.scrollIntoView({ block: 'end' });
      else bodyEl.scrollTop = bodyEl.scrollHeight;
    } else {
      bodyEl.scrollTop = scroll;
    }
    return;
  }
  html = logView();
  bodyEl.innerHTML = html;
  bindBody(bodyEl);
  bodyEl.scrollTop = scroll;
}

function bindBody(bodyEl) {
  bodyEl.querySelectorAll('[data-round]').forEach(el => {
    el.addEventListener('click', () => {
      state.round = Number(el.getAttribute('data-round'));
      state.roundLogName = null;
      rerenderBody();
      // 轮次切换也更新头部里的轮次切换条
      render();
    });
  });
  bodyEl.querySelectorAll('.feed-row').forEach(el => {
    el.addEventListener('click', () => {
      el.parentElement.classList.toggle('open');
    });
  });
  bindCopy(bodyEl);
  // 用户上滚暂停自动滚动
  bodyEl.addEventListener('scroll', () => {
    const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 48;
    state.autoScroll = nearBottom;
  }, { passive: true });
}

function render() {
  if (!state.sub) return;
  drawerEl.innerHTML = head() + tabs() + '<div class="drawer-body" tabindex="0"></div>';
  const nb = drawerEl.querySelector('.drawer-body');
  const close = drawerEl.querySelector('#drawer-close');
  close.addEventListener('click', closeDrawer);
  // 标签页在 body 外，必须绑在 drawerEl 上
  drawerEl.querySelectorAll('[data-tab]').forEach(el => {
    el.addEventListener('click', () => {
      state.tab = el.getAttribute('data-tab');
      render();
    });
  });
  nb.addEventListener('scroll', () => {
    state.autoScroll = nb.scrollHeight - nb.scrollTop - nb.clientHeight < 48;
  }, { passive: true });
  if (state.tab === 'compare') {
    renderCompare().then(h => { nb.innerHTML = h; bindBody(nb); });
  } else if (state.tab === 'feed') {
    nb.innerHTML = feedView();
    bindBody(nb);
    if (state.autoScroll) nb.scrollTop = nb.scrollHeight;
  } else {
    nb.innerHTML = logView();
    bindBody(nb);
  }
}

export async function openDrawer(runId, subId, run, opts) {
  state.lastFocus = document.activeElement;
  state.runId = runId;
  state.subId = subId;
  state.files = {};
  state.feed = []; state.feedSummary = null; state.autoScroll = true;
  state.tab = (opts && opts.tab) || 'compare';
  state.onSubscribed = (opts && opts.onSubscribed) || null;
  if (run && run.subtasks) {
    state.sub = run.subtasks.find(s => s.id === subId) || null;
  }
  if (!state.sub) {
    try { const r = await getRun(runId); state.sub = (r.subtasks || []).find(s => s.id === subId) || null; }
    catch (e) { state.sub = null; }
  }
  state.round = state.sub && state.sub.rounds ? (state.sub.rounds[state.sub.rounds.length - 1] || {}).n || 1 : 1;
  state.roundLogName = null;
  drawerEl.hidden = false;
  maskEl.hidden = false;
  requestAnimationFrame(() => {
    drawerEl.classList.add('open');
    maskEl.classList.add('open');
  });
  render();
  loadFeed();
  // Esc 关闭
  document.addEventListener('keydown', onKeydown);
  maskEl.addEventListener('click', closeDrawer);
  // 焦点进入抽屉
  const firstBtn = drawerEl.querySelector('#drawer-close');
  if (firstBtn) firstBtn.focus();
}

function onKeydown(e) {
  if (e.key === 'Escape') closeDrawer();
}

export function closeDrawer() {
  drawerEl.classList.remove('open');
  maskEl.classList.remove('open');
  document.removeEventListener('keydown', onKeydown);
  maskEl.removeEventListener('click', closeDrawer);
  setTimeout(() => { drawerEl.hidden = true; maskEl.hidden = true; }, 240);
  if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  state.subId = null; state.sub = null;
  if (state.onSubscribed) state.onSubscribed();
}

// 文件查看模式：日志页打开某个文件
export async function openFile(runId, name) {
  // 找一个子任务挂靠；没有就只展示日志
  state.lastFocus = document.activeElement;
  state.runId = runId; state.subId = null; state.sub = null;
  state.files = {}; state.feed = []; state.tab = 'log';
  state.roundLogName = name;
  drawerEl.hidden = false; maskEl.hidden = false;
  requestAnimationFrame(() => {
    drawerEl.classList.add('open');
    maskEl.classList.add('open');
  });
  drawerEl.innerHTML = '<div class="drawer-head"><div class="dh-top">' +
    '<span class="dh-title mono" style="font-size:15px">' + escapeHtml(name) + '</span>' +
    '<button type="button" class="icon-btn" id="drawer-close" aria-label="关闭抽屉">' + icon('close', 16) + '</button>' +
    '</div></div><div class="drawer-body" tabindex="0"></div>';
  drawerEl.querySelector('#drawer-close').addEventListener('click', closeDrawer);
  const nb = drawerEl.querySelector('.drawer-body');
  nb.innerHTML = skeleton(4);
  try {
    const text = await getFile(runId, name);
    nb.innerHTML = '<pre class="log-view">' + (name.endsWith('.md') ? mdRender(text) : escapeHtml(text)) + '</pre>';
  } catch (e) {
    nb.innerHTML = emptyState('读取失败：' + escapeHtml(e.message || ''), '');
  }
  document.addEventListener('keydown', onKeydown);
  maskEl.addEventListener('click', closeDrawer);
  drawerEl.querySelector('#drawer-close').focus();
}

// SSE change：若涉及当前子任务，刷新执行过程
export function refreshFeed(runId, subId) {
  if (state.runId === runId && state.subId === subId && state.tab === 'feed') {
    loadFeed();
  }
}

export function isDrawerOpen() { return !drawerEl.hidden; }
