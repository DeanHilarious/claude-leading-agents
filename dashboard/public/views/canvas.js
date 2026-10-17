// 4.2 流程画布：Claude 节点、泳道、子任务节点卡、贝塞尔连线、回环箭头
import { escapeHtml } from '../md.js';
import { statusBadge, roundPills, icon } from '../components.js';

const CARD_W = 220, CARD_H = 112, GAP_X = 32, GAP_Y = 20;
const LANE_X = 180, CLAUDE_X = 28;
const AGENT_COLOR = { codex: 'var(--codex)', codebuddy: 'var(--codebuddy)', unknown: 'var(--text-3)' };

function agentColor(a) { return AGENT_COLOR[a] || AGENT_COLOR.unknown; }

function linkPath(x1, y1, x2, y2) {
  // 三次贝塞尔，控制点水平偏移一半距离
  const dx = (x2 - x1) / 2;
  return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
}

// 泳道分配：按代理分泳道（codex / codebuddy / 其他归 codebuddy 下方）
function lanes(subtasks) {
  const order = [];
  for (const st of subtasks) {
    const a = st.agent === 'codebuddy' ? 'codebuddy' : 'codex';
    if (!order.includes(a)) order.push(a);
  }
  // 只有一个代理时只画一条
  if (order.length === 1 && order[0] === 'codebuddy') return ['codebuddy'];
  return order.length ? order : ['codex'];
}

export function renderCanvas(subtasks) {
  const list = (subtasks || []).slice().sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : Infinity;
    const tb = b.start ? new Date(b.start).getTime() : Infinity;
    return ta - tb;
  });
  const laneKeys = lanes(list);
  const LANE_LABEL = { codex: 'Codex', codebuddy: 'CodeBuddy' };

  // 计算每条泳道的高度（换行增长）
  const laneRows = {};
  for (const st of list) {
    const k = st.agent === 'codebuddy' && laneKeys.includes('codebuddy') ? 'codebuddy' : (laneKeys.includes('codex') ? 'codex' : laneKeys[0]);
    st._lane = k;
    laneRows[k] = (laneRows[k] || 0) + 1;
  }
  const laneHeights = {};
  const laneY = {};
  let y = 24;
  for (const k of laneKeys) {
    const rows = Math.max(1, Math.ceil((laneRows[k] || 0) / 10000)); // 行数由下面按宽度算
    laneY[k] = y;
    laneHeights[k] = rows;
    y += 160; // 占位，实际在布局时更新
  }

  // 布局：每条泳道内卡片从左到右排，宽度不够换行（容器最小宽 720，可横向滚动）
  const VIEW_W = Math.max(720, LANE_X + 40 + list.length * (CARD_W + GAP_X));
  const laneBands = [];
  let cursorY = 24;
  const cardPos = [];
  for (const k of laneKeys) {
    const items = list.filter(s => s._lane === k);
    if (!items.length) continue;
    const rows = Math.ceil(items.length / Math.max(1, Math.floor((VIEW_W - LANE_X - 24) / (CARD_W + GAP_X)))) || 1;
    const laneH = Math.max(1, rows) * (CARD_H + GAP_Y) + 20;
    laneBands.push({ key: k, y: cursorY, h: laneH });
    let i = 0;
    for (const st of items) {
      const row = Math.floor(i / Math.max(1, Math.floor((VIEW_W - LANE_X - 24) / (CARD_W + GAP_X))));
      const col = i % Math.max(1, Math.floor((VIEW_W - LANE_X - 24) / (CARD_W + GAP_X)));
      const x = LANE_X + 24 + col * (CARD_W + GAP_X);
      const cy = cursorY + 10 + row * (CARD_H + GAP_Y);
      cardPos.push({ st, x, y: cy, laneY: cursorY + 10 + (Math.max(1, rows) * (CARD_H + GAP_Y)) / 2 - CARD_H / 2 });
      i++;
    }
    cursorY += laneH + 16;
  }
  const totalH = Math.max(cursorY + 16, 240);
  const claudeY = totalH / 2;

  // SVG 连线层
  let links = '';
  for (const p of cardPos) {
    const color = agentColor(p.st.agent);
    const running = p.st.status === 'running' || p.st.status === 'rework';
    const faded = p.st.status === 'ended' || p.st.status === 'unknown';
    const cls = 'flow-link' + (running ? ' running' : '');
    const op = faded ? ' opacity="0.4"' : '';
    const y2 = p.y + CARD_H / 2;
    links += '<path class="' + cls + '" stroke="' + color + '"' + op +
      ' d="' + linkPath(CLAUDE_X + 60 + 32, claudeY + 24, p.x, y2) + '"/>';
  }

  // 节点卡（HTML 叠在 SVG 上）
  let cards = '';
  for (const p of cardPos) {
    const st = p.st;
    const reworkN = (st.rounds || []).filter(r => r.status === 'rework').length;
    const model = [st.model, st.effort].filter(Boolean).join(' · ') || '模型未知';
    cards += '<button type="button" class="sub-node" style="left:' + p.x + 'px;top:' + p.y + 'px" data-sub="' + escapeHtml(st.id) + '" aria-label="子任务 ' + escapeHtml(st.title || st.id) + '">' +
      (reworkN ? '<span class="rework-loop">' + icon('rework', 12) + '×' + reworkN + '</span>' : '') +
      '<span class="sn-top"><span class="sn-title">' + escapeHtml(st.title || st.id) + '</span>' + statusBadge(st.status) + '</span>' +
      '<span class="sn-model mono">' + escapeHtml(model) + '</span>' +
      '<span class="sn-rounds">' + roundPills(st.rounds) + '</span>' +
      '</button>';
  }

  // 泳道底与标签
  let bands = '';
  for (const b of laneBands) {
    bands += '<div class="lane-band" style="left:' + (LANE_X - 8) + 'px;top:' + b.y + 'px;width:' + (VIEW_W - LANE_X - 8) + 'px;height:' + b.h + 'px;background:' + agentColor(b.key) + ';opacity:.06"></div>' +
      '<div class="lane-label" style="left:' + LANE_X + 'px;top:' + (b.y - 16) + 'px;color:' + agentColor(b.key) + '">' + LANE_LABEL[b.key] + '</div>';
  }

  const logo = '<svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
    '<circle cx="6" cy="16" r="4" stroke="var(--claude)" stroke-width="1.5"/>' +
    '<path d="M10 16h8M21 10.5l6-2M21 21.5l6 2" stroke="var(--claude)" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="28.5" cy="8" r="2.6" stroke="var(--codex)" stroke-width="1.5"/>' +
    '<circle cx="28.5" cy="24" r="2.6" stroke="var(--codebuddy)" stroke-width="1.5"/></svg>';

  return '<div class="canvas-wrap" role="region" aria-label="流程画布" tabindex="0">' +
    '<div class="flow-canvas" style="width:' + VIEW_W + 'px;height:' + totalH + 'px">' +
    '<div class="dot-grid"></div>' +
    '<svg class="flow-svg" width="' + VIEW_W + '" height="' + totalH + '" viewBox="0 0 ' + VIEW_W + ' ' + totalH + '" aria-hidden="true">' + links + '</svg>' +
    bands +
    '<div class="claude-node" style="left:' + CLAUDE_X + 'px;top:' + (claudeY - 8) + 'px">' +
    '<div class="claude-circle">' + logo + '</div>' +
    '<span class="cn-label">Claude · 大脑</span></div>' +
    cards +
    '</div></div>';
}

export function bindCanvas(container, onOpen) {
  container.querySelectorAll('.sub-node').forEach(el => {
    el.addEventListener('click', () => onOpen(el.getAttribute('data-sub')));
  });
}
