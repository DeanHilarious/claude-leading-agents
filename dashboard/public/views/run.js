// 4.2 任务详情：头部、流程画布、甘特时间线、文件列表
import { escapeHtml } from '../md.js';
import {
  statusBadge, agentBadge, fmtDuration, fmtTokensCompact, fmtClock,
  emptyState, skeleton, icon, copyBtn, bindCopy
} from '../components.js';
import { renderCanvas, bindCanvas } from './canvas.js';
import { renderGantt } from './gantt.js';

const GROUP_LABEL = { spec: '规格', report: '报告', fix: '返工单', log: '日志', context: '公共背景', other: '其他' };
const GROUP_ORDER = ['spec', 'report', 'fix', 'log', 'context', 'other'];

let state = { id: null, filesOpen: false };

function head(run) {
  const meta = [
    '<span class="m" title="开工时间">' + icon('exec', 13) + fmtClock(run.start) + '</span>',
    '<span class="m">' + fmtDuration(run.durationMs) + '</span>',
    '<span class="m">' + (run.subtaskCount != null ? run.subtaskCount : '—') + ' 个子任务</span>',
    '<span class="m">' + (run.reworkRounds != null ? run.reworkRounds : '—') + ' 轮返工</span>',
    '<span class="m">' + (run.tokens != null ? fmtTokensCompact(run.tokens) + ' tok' : '—') + '</span>'
  ].join('');
  return '<div class="page-header">' +
    '<div class="grow"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
    '<h1 class="page-title">' + escapeHtml(run.id) + '</h1>' + statusBadge(run.status) + '</div>' +
    (run.title ? '<p class="page-sub">' + escapeHtml(run.title) + '</p>' : '') +
    '<div class="run-head-meta">' + meta + '</div></div>' +
    '<div class="run-head-right">' +
    '<span class="dir-chip" title="' + escapeHtml(run.dir || '') + '">' + icon('folder', 13) +
    '<span class="dir-text">' + escapeHtml(run.dir || '—') + '</span>' +
    (run.dir ? copyBtn(run.dir, '复制文件夹路径') : '') + '</span>' +
    '</div></div>';
}

function fileRow(id, f) {
  const size = f.size != null ? (f.size / 1024).toFixed(f.size >= 1024 * 1024 ? 0 : 1) + ' KB' : '';
  return '<button type="button" class="file-row" data-file="' + escapeHtml(f.name) + '">' +
    icon('file', 14) +
    '<span class="f-name">' + escapeHtml(f.name) + '</span>' +
    '<span class="f-meta">' + escapeHtml(size) + (f.mtime ? ' · ' + fmtClock(f.mtime) : '') + '</span>' +
    '</button>';
}

function files(run) {
  const groups = {};
  for (const f of run.files || []) {
    const g = GROUP_ORDER.includes(f.group) ? f.group : 'other';
    (groups[g] = groups[g] || []).push(f);
  }
  let inner = '';
  for (const g of GROUP_ORDER) {
    if (!groups[g] || !groups[g].length) continue;
    inner += '<div class="file-group"><div class="section-title">' + GROUP_LABEL[g] + ' · ' + groups[g].length + '</div>' +
      groups[g].map(f => fileRow(run.id, f)).join('') + '</div>';
  }
  if (!inner) inner = '<div class="empty-state"><p>这个任务还没有文件</p></div>';
  return '<section class="files-section">' +
    '<button type="button" class="files-toggle" id="files-toggle" aria-expanded="' + (state.filesOpen ? 'true' : 'false') + '" aria-controls="files-body">' +
    icon('file', 15) + '文件 · ' + (run.files || []).length + '<span class="chev">' + icon('chevron', 14) + '</span></button>' +
    '<div class="files-body' + (state.filesOpen ? ' open' : '') + '" id="files-body">' + inner + '</div>' +
    '</section>';
}

function body(run, onOpenSub, onOpenFile) {
  return '<div class="page">' +
    head(run) +
    renderCanvas(run.subtasks) +
    '<div style="height:8px"></div>' +
    renderGantt(run.subtasks, run.start) +
    files(run) +
    '</div>';
}

function bind(container, run, onOpenSub, onOpenFile) {
  bindCanvas(container, onOpenSub);
  bindCopy(container);
  const toggle = container.querySelector('#files-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      state.filesOpen = !state.filesOpen;
      toggle.setAttribute('aria-expanded', state.filesOpen ? 'true' : 'false');
      container.querySelector('#files-body').classList.toggle('open', state.filesOpen);
    });
  }
  container.querySelectorAll('.file-row').forEach(el => {
    el.addEventListener('click', () => onOpenFile(el.getAttribute('data-file')));
  });
}

function render(container, run, onOpenSub, onOpenFile) {
  state.id = run.id;
  const scroll = container.scrollTop;
  const tmp = document.createElement('div');
  tmp.innerHTML = body(run);
  container.replaceChildren(tmp);
  container.scrollTop = scroll;
  bind(container, run, onOpenSub, onOpenFile);
}

function loading(container, id) {
  container.innerHTML = '<div class="page">' + skeleton(8) + '</div>';
}

function error(container, err) {
  container.innerHTML = '<div class="page">' + emptyState('加载失败：' + escapeHtml(err && err.message ? err.message : '未知错误'), '检查一下这个任务是否还存在。') + '</div>';
}

export { render, loading, error };
