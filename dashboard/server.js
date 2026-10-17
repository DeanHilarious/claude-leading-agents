'use strict';
// 指挥台 HTTP 服务。零依赖，只读，只听 127.0.0.1。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const runs = require('./lib/runs');
const codex = require('./lib/codex');
const cbLib = require('./lib/codebuddy');
const psLib = require('./lib/ps');
const agg = require('./lib/aggregate');
const { buildStatFile } = require('./lib/demo');
const { isSafeFileName, isCredentialName, toIso, offsetMinutesOf } = require('./lib/util');
const { matchSub } = require('./lib/naming');

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
  }
  return out;
}

function createApp(cfg) {
  const nowStr = cfg.demo ? DEMO_NOW : (cfg.now || new Date().toISOString());
  const fixedNow = Date.parse(nowStr);
  // 演示和测试用固定时间；真实运行必须取当前时间，否则「超时中断」之类的判断会随服务运行变旧
  const getNow = () => (cfg.demo || cfg.now ? fixedNow : Date.now());
  const offsetMin = offsetMinutesOf(nowStr);
  const runsDir = cfg.runs;
  const codexHome = cfg.codexHome;
  const cache = new Map(); // runId -> {sig, data}
  let codexIndex = codex.buildCodexIndex(codexHome);
  let indexRebuilt = false;

  function listRunIds() {
    let ents;
    try { ents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch (e) { return []; }
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
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

  function ensureIndex(run) {
    // 有会话找不到索引时，重建一次
    const missing = run.subtasks.some((s) => s.agent === 'codex' && s.sessionIds.some((id) => !codexIndex.byId[id.toLowerCase()]));
    if (missing && !indexRebuilt) {
      codexIndex = codex.buildCodexIndex(codexHome);
      indexRebuilt = true;
    }
  }

  function scanOne(runId) {
    const dir = path.join(runsDir, runId);
    // 状态含「多久没更新」的判断，所以缓存键里带一个 30 秒的时间桶
    const sig = runSig(dir) + '|' + Math.floor(getNow() / 30000);
    const hit = cache.get(runId);
    if (hit && hit.sig === sig) return hit.data;
    const data = scanRunCached(dir, runId);
    cache.set(runId, { sig, data });
    return data;
  }

  function scanRunCached(dir, runId) {
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
    const procs = getProcs(runId, subIds);
    const data = runs.scanRun(dir, { now: getNow(), offsetMin, codexIndex, procs, statFile });
    ensureIndex(data);
    if (statFile) {
      // 重建索引后 token 可能变化，重扫一次
      const again = runs.scanRun(dir, { now: getNow(), offsetMin, codexIndex, procs, statFile });
      return again;
    }
    return data;
  }

  let procsCache = { t: 0, list: [] };
  function getProcs(runId, subIds) {
    if (cfg.demo) return new Set();
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
    return codex.readQuota(codexIndex);
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function sendText(res, code, text) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.md': 'text/plain; charset=utf-8',
  };

  function handleFile(req, res, url, runId) {
    const name = url.searchParams.get('name') || '';
    if (!isSafeFileName(name) || isCredentialName(name)) return sendJson(res, 400, { error: 'bad name' });
    const p = path.join(runsDir, runId, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
    if (!st.isFile()) return sendJson(res, 400, { error: 'bad name' });
    const MAX = 2 * 1024 * 1024;
    let buf;
    if (st.size > MAX) {
      const fd = fs.openSync(p, 'r');
      try {
        buf = Buffer.alloc(MAX);
        fs.readSync(fd, buf, 0, MAX, st.size - MAX);
      } finally { fs.closeSync(fd); }
    } else {
      buf = fs.readFileSync(p);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  }

  function handleFeed(res, runId, subId) {
    const run = scanOne(runId);
    const sub = run.subtasks.find((s) => s.id === subId);
    if (!sub) return sendJson(res, 404, { error: 'not found' });
    const live = sub.status === 'running';
    if (sub.agent === 'codebuddy') {
      let summary = null;
      const sumF = run.files.map((f) => f.name).find((f) => new RegExp('^sum-' + subId + '(?:-r\\d+)?\\.txt$').test(f));
      if (sumF) {
        const parsed = cbLib.parseSumLine(fs.readFileSync(path.join(run.dir, sumF), 'utf8'));
        if (parsed) summary = { exit: parsed.exit, subtype: parsed.subtype, session: parsed.session, turns: parsed.turns, input: parsed.input, output: parsed.output, denials: parsed.denials };
      }
      return sendJson(res, 200, { agent: 'codebuddy', live, steps: [], summary });
    }
    // codex：取该子任务最新一个会话的 rollout
    const id = sub.sessionIds[sub.sessionIds.length - 1];
    const file = id ? codexIndex.byId[id.toLowerCase()] : null;
    const steps = file ? codex.parseFeed(file) : [];
    sendJson(res, 200, { agent: sub.agent, live, steps, summary: null });
  }

  function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (parts[1] === 'overview') {
      const list = listRunIds().map(scanOne);
      const runningAgents = cfg.demo
        ? list.reduce((a, r) => a + r.subtasks.filter((s) => s.status === 'running').length, 0)
        : procsCache.list.length;
      return sendJson(res, 200, agg.overview(list, { now: getNow(), offsetMin, demo: cfg.demo, quota: quota(), runningAgents }));
    }
    if (parts[1] === 'runs' && parts[2] && !parts[3]) {
      if (!listRunIds().includes(parts[2])) return sendJson(res, 404, { error: 'not found' });
      const json = agg.runToJson(scanOne(parts[2]), offsetMin);
      json.generatedAt = new Date(getNow()).toISOString();
      // 演示数据放在仓库里，显示成标准位置，免得截图暴露本机目录结构
      if (cfg.demo) json.dir = `~/.codex-runs/${json.id}`;
      return sendJson(res, 200, json);
    }
    if (parts[1] === 'runs' && parts[2] && parts[3] === 'file') {
      if (!listRunIds().includes(parts[2])) return sendJson(res, 404, { error: 'not found' });
      return handleFile(req, res, url, parts[2]);
    }
    if (parts[1] === 'runs' && parts[2] && parts[3] === 'subtasks' && parts[4] && parts[5] === 'feed') {
      return handleFeed(res, parts[2], decodeURIComponent(parts[4]));
    }
    if (parts[1] === 'bill') {
      const range = url.searchParams.get('range') || '7d';
      const list = listRunIds().map(scanOne);
      return sendJson(res, 200, agg.bill(list, range, { now: getNow(), offsetMin, quota: quota() }));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function handleStatic(res, url) {
    const publicDir = path.join(__dirname, 'public');
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    rel = rel.replace(/^\/+/, '');
    if (rel.includes('..')) return sendText(res, 403, 'forbidden');
    const p = path.join(publicDir, rel);
    let st;
    try { st = fs.statSync(p); } catch (e) {
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<!doctype html><meta charset="utf-8"><title>指挥台</title><p>未找到前端文件（public/ 不存在）。API 见 /api/overview。</p>');
      }
      return sendText(res, 404, 'not found');
    }
    if (!st.isFile()) return sendText(res, 404, 'not found');
    const ext = path.extname(p);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(p));
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    // 防 DNS 重绑定
    const host = (req.headers.host || '').toLowerCase();
    const port = cfg._listenPort || cfg.port;
    if (host !== 'localhost:' + port && host !== '127.0.0.1:' + port) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('{"error":"forbidden"}');
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/events') return handleSse(req, res);
      return handleApi(req, res, url);
    }
    handleStatic(res, url);
  }

  let sseClients = new Set();
  let watchTimer = null;
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

  let watcher = null;
  function startWatch() {
    try {
      watcher = fs.watch(runsDir, { recursive: true }, () => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          const changed = [];
          for (const id of listRunIds()) {
            const dir = path.join(runsDir, id);
            const sig = runSig(dir);
            const hit = cache.get(id);
            if (!hit || hit.sig !== sig) changed.push(id);
          }
          const oldQuota = JSON.stringify(quota());
          for (const id of changed) scanOne(id); // 刷新缓存
          const newQuota = JSON.stringify(quota());
          if (changed.length) broadcast('change', { runs: changed });
          if (oldQuota !== newQuota) broadcast('quota', { quota: quota() });
        }, 300);
      });
    } catch (e) { /* watch 失败则静默，接口仍可用 */ }
  }

  const server = http.createServer(handler);
  server.on('listening', () => { cfg._listenPort = server.address().port; startWatch(); });
  server.on('close', () => { if (watcher) watcher.close(); });
  return { server, scanOne, listRunIds, broadcast };
}

function main() {
  const args = parseArgs(process.argv);
  const here = __dirname;
  const fix = (p) => path.resolve(here, 'test/fixtures', p);
  const cfg = {
    demo: args.demo,
    runs: args.demo ? fix('runs') : (args.runs || path.join(os.homedir(), '.codex-runs')),
    codexHome: args.demo ? fix('codex-home') : (args.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    now: args.now,
  };
  const app = createApp(cfg);
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${args.port} 已被占用：指挥台可能已经在运行了，直接打开 http://127.0.0.1:${args.port} 看看。\n要同时再开一个，换个端口：node dashboard/server.js --port ${args.port + 1}`);
      process.exit(1);
    }
    throw err;
  });
  app.server.listen(args.port, '127.0.0.1', () => {
    console.log('指挥台已启动 → http://127.0.0.1:' + args.port);
  });
}

if (require.main === module) main();
module.exports = { createApp, parseArgs, DEMO_NOW };
