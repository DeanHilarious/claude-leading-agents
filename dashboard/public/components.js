// 通用组件与工具：图标、徽章、统计卡、额度环、格式化、空状态、骨架屏、复制
import { escapeHtml } from './md.js';

// ---------- 图标（内联 SVG，线条 1.5px，currentColor） ----------
function icon(name, size) {
  const s = size || 16;
  const P = (d) => '<path d="' + d + '"/>';
  const paths = {
    overview: P('M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'),
    bill: P('M12 3v18M17 6H10a3 3 0 000 6h4a3 3 0 010 6H7'),
    live: P('M12 12m-2 0a2 2 0 104 0 2 2 0 10-4 0M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8'),
    search: P('M10.5 3a7.5 7.5 0 105.2 12.9l4.2 4.2M15.7 15.7A7.5 7.5 0 0010.5 3z'),
    theme: P('M12 3a9 9 0 109 9 7 7 0 01-9-9z'),
    copy: P('M9 9h10v12H9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1'),
    close: P('M6 6l12 12M18 6L6 18'),
    file: P('M6 3h8l4 4v14H6zM14 3v4h4'),
    read: P('M3 5h7v15H3zM10 8h6a3 3 0 013 3v9h-9zM3 19h7'),
    exec: P('M5 5l7 7-7 7M12 19h7'),
    edit: P('M4 20h4L20 8l-4-4L4 16zM14 6l4 4'),
    talk: P('M4 5h16v11H9l-5 4z'),
    done: P('M4 12.5l5 5L20 6.5'),
    rework: P('M4 10a8 8 0 0114-3M20 14a8 8 0 01-14 3M18 3v4h-4M6 21v-4h4'),
    chevron: P('M9 6l6 6-6 6'),
    folder: P('M3 6h6l2 3h10v11H3z'),
    sort: P('M8 4v16M8 4l-3 3M8 4l3 3M16 20V4M16 20l-3-3M16 20l3-3')
  };
  return '<svg class="icon" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
}

// ---------- 状态与文案 ----------
const STATUS_TEXT = { running: '运行中', review: '待验收', rework: '返工中', passed: '已通过', failed: '中断', ended: '已结束' };
const AGENT_TEXT = { claude: 'Claude', codex: 'Codex', codebuddy: 'CodeBuddy', unknown: '未知' };

function statusBadge(status) {
  const label = STATUS_TEXT[status] || '未知';
  return '<span class="badge badge-status status-' + escapeHtml(status || 'ended') + '">' +
    '<span class="badge-dot"></span>' + label + '</span>';
}

function agentBadge(agent) {
  const label = AGENT_TEXT[agent] || '未知';
  return '<span class="badge badge-agent agent-' + escapeHtml(agent || 'unknown') + '">' +
    '<span class="badge-dot"></span>' + label + '</span>';
}

// ---------- 格式化 ----------
// token 紧凑格式：1.2M / 35.6K
function fmtTokensCompact(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// 表格用千分位
function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function fmtDuration(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
  const d = Math.floor(h / 24);
  return d + ' 天 ' + (h % 24) + ' 小时';
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

// 相对时间（「3 分钟前」），title 显示绝对时间
function timeAgo(iso) {
  if (!iso) return '<span class="time">—</span>';
  const t = new Date(iso);
  if (isNaN(t)) return '<span class="time">—</span>';
  const abs = t.getFullYear() + '/' + pad(t.getMonth() + 1) + '/' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
  const diff = Date.now() - t.getTime();
  let label;
  if (diff < 0) {
    label = abs.slice(5);
  } else if (diff < 60000) {
    label = '刚刚';
  } else if (diff < 3600000) {
    label = Math.floor(diff / 60000) + ' 分钟前';
  } else if (diff < 86400000) {
    label = Math.floor(diff / 3600000) + ' 小时前';
  } else if (diff < 7 * 86400000) {
    label = Math.floor(diff / 86400000) + ' 天前';
  } else {
    label = pad(t.getMonth() + 1) + '/' + pad(t.getDate());
  }
  return '<span class="time" title="' + abs + '">' + label + '</span>';
}

function fmtClock(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (isNaN(t)) return '—';
  return pad(t.getMonth() + 1) + '/' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
}

// ---------- 统计卡 ----------
function statCard(label, valueHtml, extraHtml) {
  return '<div class="stat-card">' +
    '<div class="stat-label">' + label + '</div>' +
    '<div class="stat-value">' + valueHtml + '</div>' +
    (extraHtml ? '<div class="stat-extra">' + extraHtml + '</div>' : '') +
    '</div>';
}

// 子任务状态条：每个子任务一格
function subStatusBar(subStatuses) {
  let cells = '';
  for (const s of subStatuses || []) {
    cells += '<i class="sub-cell status-' + escapeHtml(s || 'ended') + '" title="' + (STATUS_TEXT[s] || '未知') + '"></i>';
  }
  return '<div class="sub-status-bar" role="img" aria-label="子任务状态">' + cells + '</div>';
}

// 轮次胶囊
function roundPills(rounds) {
  let html = '';
  for (const r of rounds || []) {
    html += '<span class="round-pill status-' + escapeHtml(r.status || 'ended') + '" title="第 ' + r.n + ' 轮 · ' + (STATUS_TEXT[r.status] || '未知') + '">R' + r.n + '</span>';
  }
  return html;
}

// ---------- 额度环（SVG） ----------
// size 直径，stroke 线宽，used 0-100
function quotaRing(used, size, stroke, cls) {
  const pct = (used == null || isNaN(used)) ? 0 : Math.max(0, Math.min(100, used));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const colorCls = cls || (pct > 90 ? 'q-red' : pct > 70 ? 'q-amber' : 'q-ok');
  return '<svg class="quota-ring ' + colorCls + '" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="额度 ' + Math.round(pct) + '%">' +
    '<circle class="ring-bg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
    '<circle class="ring-fg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + (c * pct / 100) + ' ' + c + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"/>' +
    '</svg>';
}

// 顶栏额度环 + 文本
function quotaWidget(quota) {
  if (!quota || !quota.primary) return '<span class="quota-widget quota-none">额度 —</span>';
  const p = quota.primary;
  let reset = '';
  if (p.resetsAt) {
    const t = new Date(p.resetsAt);
    if (!isNaN(t)) reset = pad(t.getMonth() + 1) + '/' + pad(t.getDate()) + ' 重置';
  }
  const label = Math.round(p.usedPercent) + '%' + (reset ? ' · ' + reset : '');
  return '<span class="quota-widget" title="Codex 周额度' + (quota.plan ? ' · ' + escapeHtml(quota.plan) : '') + '">' +
    quotaRing(p.usedPercent, 28, 3) +
    '<span class="quota-label">' + label + '</span></span>';
}

// ---------- 空状态 / 骨架屏 ----------
function emptyState(text, hint) {
  return '<div class="empty-state">' +
    '<svg width="48" height="24" viewBox="0 0 48 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M17 12h9M31 8l9-3M31 16l9 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="43" cy="6" r="3" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="43" cy="18" r="3" stroke="currentColor" stroke-width="1.5"/>' +
    '</svg>' +
    '<p>' + escapeHtml(text) + '</p>' +
    (hint ? '<p class="empty-hint">' + escapeHtml(hint) + '</p>' : '') +
    '</div>';
}

function skeleton(rows) {
  let html = '<div class="skeleton" aria-busy="true">';
  for (let i = 0; i < (rows || 3); i++) {
    html += '<div class="sk-line" style="width:' + (55 + ((i * 13) % 35)) + '%"></div>';
  }
  return html + '</div>';
}

// ---------- 复制到剪贴板（成功提示「已复制」） ----------
function flashTip(el, msg) {
  const old = el.parentElement && el.parentElement.querySelector('.copy-tip');
  if (old) old.remove();
  const tip = document.createElement('span');
  tip.className = 'copy-tip';
  tip.textContent = msg || '已复制';
  if (el.parentElement) el.parentElement.appendChild(tip);
  setTimeout(() => tip.remove(), 1400);
}

function bindCopy(container) {
  container.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.getAttribute('data-copy') || '';
      const done = () => flashTip(btn, '已复制');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });
}

function copyBtn(text, label) {
  return '<button type="button" class="icon-btn copy-btn" data-copy="' + escapeHtml(text) + '" aria-label="' + escapeHtml(label || '复制') + '" title="' + escapeHtml(label || '复制') + '">' + icon('copy', 14) + '</button>';
}

export {
  icon, STATUS_TEXT, AGENT_TEXT, statusBadge, agentBadge,
  fmtTokensCompact, fmtNum, fmtDuration, timeAgo, fmtClock, pad,
  statCard, subStatusBar, roundPills, quotaRing, quotaWidget,
  emptyState, skeleton, bindCopy, copyBtn, flashTip
};
