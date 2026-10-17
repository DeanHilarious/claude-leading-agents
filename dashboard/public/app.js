// 入口：hash 路由、SSE 订阅、主题切换、顶栏（面包屑/额度）
import { getOverview, getRun, getBill } from './api.js';
import { quotaWidget, emptyState } from './components.js';
import { escapeHtml } from './md.js';
import * as overview from './views/overview.js';
import * as runView from './views/run.js';
import * as bill from './views/bill.js';
import { openDrawer, closeDrawer, openFile, refreshFeed, isDrawerOpen } from './views/drawer.js';

const content = document.getElementById('content');
const breadcrumb = document.getElementById('breadcrumb');
const quotaSlot = document.getElementById('quota-slot');
const liveDot = document.getElementById('live-dot');
const liveText = document.getElementById('live-text');
const liveSr = document.getElementById('live-sr');

let route = { name: 'overview', id: null, sub: null };
let currentRun = null; // 缓存当前详情页数据，供抽屉复用
let quota = null;

// ---------- 主题 ----------
const THEME_KEY = 'cla-theme';
function readTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}
function writeTheme(v) {
  try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* 隐私模式等场景忽略 */ }
}
function applyTheme() {
  const t = readTheme();
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
document.getElementById('theme-btn').addEventListener('click', () => {
  const cur = readTheme();
  const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const nowLight = cur === 'light' || (cur !== 'dark' && sysLight);
  writeTheme(nowLight ? 'dark' : 'light');
  applyTheme();
});
applyTheme();

// ---------- 顶栏 ----------
function renderBreadcrumb() {
  let html = '<a href="#/">总览</a>';
  if (route.name === 'run' && route.id) {
    html += '<span class="crumb-sep" aria-hidden="true">/</span><span class="current mono">' + escapeHtml(route.id) + '</span>';
  } else if (route.name === 'bill') {
    html += '<span class="crumb-sep" aria-hidden="true">/</span><span class="current">账单</span>';
  }
  breadcrumb.innerHTML = html;
}

function updateNav() {
  for (const id of ['nav-overview', 'nav-bill']) {
    const el = document.getElementById(id);
    const target = el.getAttribute('data-route');
    const active = (route.name === 'overview' && target === '#/') || (route.name === 'bill' && target === '#/bill');
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  }
}
document.getElementById('nav-overview').addEventListener('click', () => { location.hash = '#/'; });
document.getElementById('nav-bill').addEventListener('click', () => { location.hash = '#/bill'; });

function renderQuota() {
  quotaSlot.innerHTML = quotaWidget(quota);
}

// ---------- 路由 ----------
function parseHash() {
  const h = location.hash.replace(/^#/, '');
  let m = h.match(/^\/run\/([^/]+)(?:\/([^/]+))?/);
  if (m) return { name: 'run', id: decodeURIComponent(m[1]), sub: m[2] ? decodeURIComponent(m[2]) : null };
  if (h === '/bill') return { name: 'bill' };
  return { name: 'overview' };
}

async function loadOverview() {
  if (isDrawerOpen()) closeDrawer();
  renderBreadcrumb(); updateNav();
  overview.loading(content);
  try {
    const data = await getOverview();
    quota = data.quota; renderQuota();
    overview.reset();
    overview.render(content, data);
  } catch (e) { overview.error(content, e); }
}

async function loadRun(id, sub) {
  renderBreadcrumb(); updateNav();
  runView.loading(content, id);
  try {
    const run = await getRun(id);
    currentRun = run;
    runView.render(content, run,
      (subId) => { location.hash = '#/run/' + encodeURIComponent(id) + '/' + encodeURIComponent(subId); },
      (fileName) => { openFile(id, fileName); });
    if (sub) {
      openDrawer(id, sub, run, {});
    } else if (isDrawerOpen()) {
      closeDrawer();
    }
  } catch (e) {
    currentRun = null;
    runView.error(content, e);
  }
}

async function loadBill(range) {
  if (isDrawerOpen()) closeDrawer();
  renderBreadcrumb(); updateNav();
  bill.loading(content);
  try {
    const data = await getBill(range || '7d');
    if (data.quota) { quota = data.quota; renderQuota(); }
    bill.render(content, data);
  } catch (e) { bill.error(content, e); }
}

window.addEventListener('bill-reload', (e) => { loadBill(e.detail); });

async function routeChanged() {
  const r = parseHash();
  const prev = route;
  route = r;
  if (r.name === 'run') {
    // 同一任务的抽屉开关不整页刷新
    if (prev.name === 'run' && prev.id === r.id) {
      renderBreadcrumb();
      if (r.sub) { openDrawer(r.id, r.sub, currentRun, {}); }
      else { closeDrawer(); }
      return;
    }
    await loadRun(r.id, r.sub);
  } else if (r.name === 'bill') {
    await loadBill('7d');
  } else {
    await loadOverview();
  }
}

window.addEventListener('hashchange', routeChanged);

// ---------- SSE ----------
let es = null;
let retryTimer = null;

function setLive(on) {
  liveDot.classList.toggle('on', on);
  liveText.textContent = on ? '实时' : '离线';
  liveSr.textContent = '实时连接：' + (on ? '在线' : '离线');
}

function connectSSE() {
  if (es) { es.close(); es = null; }
  try { es = new EventSource('/api/events'); } catch (e) { setLive(false); scheduleRetry(); return; }
  es.onopen = () => setLive(true);
  es.onerror = () => { setLive(false); es.close(); es = null; scheduleRetry(); };
  es.addEventListener('change', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data || '{}'); } catch (e) { /* 坏数据忽略 */ }
    handleChange(data.runs || []);
  });
  es.addEventListener('quota', (ev) => {
    try { quota = JSON.parse(ev.data); renderQuota(); } catch (e) { /* 忽略 */ }
  });
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connectSSE(); }, 3000);
}

// change：只刷新当前视图涉及的数据
let refreshing = false;
async function handleChange(runs) {
  if (refreshing) return;
  refreshing = true;
  try {
    if (route.name === 'overview') {
      const data = await getOverview();
      quota = data.quota; renderQuota();
      if (route.name === 'overview') overview.render(content, data);
    } else if (route.name === 'run' && route.id) {
      if (runs.length === 0 || runs.includes(route.id)) {
        const run = await getRun(route.id);
        currentRun = run;
        runView.render(content, run,
          (subId) => { location.hash = '#/run/' + encodeURIComponent(route.id) + '/' + encodeURIComponent(subId); },
          (fileName) => { openFile(route.id, fileName); });
        // 抽屉里的执行过程实时追加
        if (isDrawerOpen()) {
          const m = location.hash.match(/^#\/run\/[^/]+\/([^/]+)/);
          if (m) refreshFeed(route.id, decodeURIComponent(m[1]));
        }
      }
    } else if (route.name === 'bill') {
      await loadBill(bill.getRange());
    }
  } catch (e) { /* 刷新失败下次再试 */ }
  refreshing = false;
}

// ---------- 启动 ----------
routeChanged();
connectSSE();
