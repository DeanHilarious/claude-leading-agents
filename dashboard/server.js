'use strict';
// 指挥台 HTTP 服务。零依赖。
// 本地模式：只读，只听 127.0.0.1；远程模式（--data）：登录 + 接收接口 + 多机器数据源。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const runs = require('./lib/runs');
const codex = require('./lib/codex');
const psLib = require('./lib/ps');
const { buildStatFile } = require('./lib/demo');
const { offsetMinutesOf } = require('./lib/util');
const { matchSub } = require('./lib/naming');
const remoteLib = require('./lib/remote');
const { createAuth, loadSessionSecret } = require('./lib/auth');
const { createIngest } = require('./lib/ingest');
const { createApi } = require('./lib/api');
const watchLib = require('./lib/watch');
const staticLib = require('./lib/static');

const DEMO_NOW = '2026-10-17T22:10:00+08:00';

function parseArgs(argv) {
  const out = { port: 4177, demo: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--runs') out.runs = argv[++i];
    else if (a === '--codex-home') out.codexHome = argv[++i];
    else if (a === '--demo') out.demo = true;
    else if (a === '--now') out.now = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--allowed-host') out.allowedHost = argv[++i];
    else if (a === '--listen-host') out.listenHost = argv[++i];
  }
  return out;
}

function createApp(cfg) {
  const remote = !!cfg.data;
  const nowStr = cfg.demo ? DEMO_NOW : (cfg.now || new Date().toISOString());
  const fixedNow = Date.parse(nowStr);
  // 演示和测试用固定时间；真实运行必须取当前时间，否则「超时中断」之类的判断会随服务运行变旧
  const getNow = () => (cfg.demo || cfg.now ? fixedNow : Date.now());
  const offsetMin = offsetMinutesOf(nowStr);
  const runsDir = cfg.runs;
  const cache = new Map(); // runKey -> {sig, data}
  let codexIndex = remote ? null : codex.buildCodexIndex(cfg.codexHome);
  let indexRebuilt = false;
  const publicDir = path.join(__dirname, 'public');

  const auth = remote ? createAuth({
    password: cfg.password,
    token: cfg.token,
    secret: cfg.secret || loadSessionSecret(cfg.data),
  }) : null;

  // 任务来源：本地单个 runsDir；远程遍历 DATA/<machine>/runs/*
  function listEntries() {
    if (remote) return remoteLib.listRunEntries(cfg.data);
    let ents;
    try { ents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch (e) { return []; }
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ machine: null, name: e.name, dir: path.join(runsDir, e.name), key: e.name }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  function findEntry(key) {
    return listEntries().find((e) => e.key === key);
  }

  function indexFor(entry) {
    if (remote) return codex.buildRemoteCodexIndex(path.join(cfg.data, entry.machine));
    return codexIndex;
  }

  function runSig(runDir) {
    // 签名 = 所有文件的 mtime+size 之和（缓存失效依据）
    let sig = 0;
    let names;
    try { names = fs.readdirSync(runDir); } catch (e) { return null; }
    for (const f of names) {
      try {
        const st = fs.statSync(path.join(runDir, f));
        if (st.isFile()) sig += st.mtimeMs + st.size;
      } catch (e) { /* ignore */ }
    }
    return sig;
  }

  function scanOne(entry) {
    // 状态含「多久没更新」的判断，所以缓存键里带一个 30 秒的时间桶
    const sig = runSig(entry.dir) + '|' + Math.floor(getNow() / 30000);
    const hit = cache.get(entry.key);
    if (hit && hit.sig === sig) return hit.data;
    const data = scanRunCached(entry);
    data.machine = entry.machine;
    data.id = entry.key; // 多机器同名时展示为 <run>@<machine>；本地模式 key 即目录名
    cache.set(entry.key, { sig, data });
    return data;
  }

  function scanRunCached(entry) {
    const dir = entry.dir;
    const idx = indexFor(entry);
    // 先粗扫一次拿子任务全集（demo statFile 需要）
    const subIds = [];
    if (fs.existsSync(path.join(dir, 'events.jsonl'))) {
      for (const e of runs.parseEvents(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'))) {
        if (!subIds.includes(e.sub)) subIds.push(e.sub);
      }
    } else {
      for (const f of fs.readdirSync(dir)) {
        const m = /^spec-(.+)\.md$/.exec(f);
        if (m) subIds.push(m[1]);
      }
    }
    const statFile = cfg.demo ? buildStatFile(dir, subIds, offsetMin) : null;
    const procs = getProcs(entry.name, subIds);
    const opts = { now: getNow(), offsetMin, codexIndex: idx, procs, statFile };
    const data = runs.scanRun(dir, opts);
    ensureIndex(data);
    if (statFile) {
      // 重建索引后 token 可能变化，重扫一次
      return runs.scanRun(dir, opts);
    }
    return data;
  }

  function ensureIndex(data) {
    if (remote) return;
    // 有会话找不到索引时，重建一次
    const missing = data.subtasks.some((s) => s.agent === 'codex' && s.sessionIds.some((id) => !codexIndex.byId[id.toLowerCase()]));
    if (missing && !indexRebuilt) {
      codexIndex = codex.buildCodexIndex(cfg.codexHome);
      indexRebuilt = true;
    }
  }

  let procsCache = { t: 0, list: [] };
  function getProcs(runId, subIds) {
    if (cfg.demo || remote) return new Set();
    const nowT = Date.now();
    if (nowT - procsCache.t > 5000) {
      procsCache = { t: nowT, list: psLib.listProcs(runsDir) };
    }
    const set = new Set();
    for (const p of procsCache.list) {
      if (p.runId !== runId) continue;
      const id = matchSub(p.sub, subIds);
      if (id) set.add(id);
    }
    return set;
  }

  function quota() {
    return remote ? codex.readRemoteQuota(cfg.data) : codex.readQuota(codexIndex);
  }

  const api = createApi({
    cfg, offsetMin, getNow, listEntries, findEntry, scanOne, indexFor, quota,
    procsCount: () => procsCache.list.length,
  });
  const sendJson = api.sendJson;

  let sseClients = new Set();
  function handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
  }

  function broadcast(event, data) {
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const c of sseClients) { try { c.write(payload); } catch (e) { /* ignore */ } }
  }

  const ingest = remote ? createIngest({
    dataDir: cfg.data,
    checkToken: auth.checkToken,
    maxBytes: cfg.maxBytes != null ? cfg.maxBytes : (Number(process.env.DASHBOARD_MAX_BYTES) || 2 * 1024 ** 3),
    onRunChange: (machine, run) => {
      const e = listEntries().find((x) => x.machine === machine && x.name === run);
      if (e) broadcast('change', { runs: [e.key] });
    },
    onMachineChange: (machine) => {
      const ks = listEntries().filter((e) => e.machine === machine).map((e) => e.key);
      if (ks.length) broadcast('change', { runs: ks });
    },
    onQuota: () => broadcast('quota', { quota: quota() }),
  }) : null;

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (remote) {
      // 安全响应头注入到所有响应（含 SSE / 接收接口）
      const extra = remoteLib.securityHeaders(req.headers['x-forwarded-proto'] === 'https');
      const orig = res.writeHead;
      res.writeHead = function (code, headers) { return orig.call(this, code, Object.assign({}, headers, extra)); };
    }
    // 防 DNS 重绑定：localhost 之外只允许 --allowed-host 列出的域名
    const host = (req.headers.host || '').toLowerCase();
    const port = cfg._listenPort || cfg.port;
    if (!remoteLib.hostAllowed(host, port, cfg.allowedHosts)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('{"error":"forbidden"}');
    }
    if (remote) {
      const p = url.pathname;
      if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true });
      if (p === '/login' && req.method === 'GET') {
        if (auth.hasSession(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
        return staticLib.serveLogin(res, publicDir);
      }
      if (p === '/login' && req.method === 'POST') return auth.handleLogin(req, res);
      if (p === '/logout' && req.method === 'POST') return auth.handleLogout(req, res);
      // 接收接口用原始路径（URL 对象会归一化掉 `..`）
      const rawPath = req.url.split('?')[0];
      if (rawPath.startsWith('/ingest/')) return ingest(req, res, rawPath);
      if (!auth.hasSession(req)) {
        if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'unauthorized' });
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/events') return handleSse(req, res);
      return api.handleApi(req, res, url);
    }
    staticLib.serveStatic(res, url, publicDir);
  }

  const stopWatch = watchLib.startWatch({
    watchDir: remote ? cfg.data : runsDir, listEntries, runSig, cache, scanOne, quota, broadcast,
  });

  const server = http.createServer(handler);
  server.on('listening', () => { cfg._listenPort = server.address().port; });
  server.on('close', () => stopWatch());
  return { server, scanOne, listEntries, broadcast, auth };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.data && (args.demo || args.runs || args.codexHome)) {
    console.error('--data（远程数据模式）不能与 --demo / --runs / --codex-home 同时使用。');
    process.exit(1);
  }
  const here = __dirname;
  const fix = (p) => path.resolve(here, 'test/fixtures', p);
  let cfg;
  if (args.data) {
    const missing = [];
    if (!process.env.DASHBOARD_PASSWORD) missing.push('DASHBOARD_PASSWORD（观看密码）');
    if (!process.env.DASHBOARD_INGEST_TOKEN) missing.push('DASHBOARD_INGEST_TOKEN（接收令牌）');
    else if (process.env.DASHBOARD_INGEST_TOKEN.length < 24) missing.push('DASHBOARD_INGEST_TOKEN（长度须 ≥24 字符）');
    if (missing.length) {
      console.error('远程模式（--data）缺少必要配置：' + missing.join('；') + '。请在环境文件中设置后重试。');
      process.exit(1);
    }
    cfg = {
      data: path.resolve(args.data),
      allowedHosts: (args.allowedHost || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      password: process.env.DASHBOARD_PASSWORD,
      token: process.env.DASHBOARD_INGEST_TOKEN,
    };
  } else {
    cfg = {
      demo: args.demo,
      runs: args.demo ? fix('runs') : (args.runs || path.join(os.homedir(), '.codex-runs')),
      codexHome: args.demo ? fix('codex-home') : (args.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
      now: args.now,
    };
  }
  cfg.port = args.port;
  const app = createApp(cfg);
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${args.port} 已被占用：指挥台可能已经在运行了，直接打开 http://127.0.0.1:${args.port} 看看。\n要同时再开一个，换个端口：node dashboard/server.js --port ${args.port + 1}`);
      process.exit(1);
    }
    throw err;
  });
  const listenHost = args.listenHost || '127.0.0.1';
  app.server.listen(args.port, listenHost, () => {
    if (cfg.data) console.log('指挥台（远程模式）已启动 → http://' + listenHost + ':' + args.port + '（经 nginx 反代对外）');
    else console.log('指挥台已启动 → http://127.0.0.1:' + args.port);
  });
}

if (require.main === module) main();
module.exports = { createApp, parseArgs, DEMO_NOW };
