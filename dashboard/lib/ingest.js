'use strict';
// 接收接口：reporter 把本机数据推到服务器。所有写入：名称校验 → 路径确认仍在 DATA 内
// → 原子写（临时文件 + rename）→ 写前再过一遍 redact（双保险）→ 磁盘配额检查。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');
const { clientIp } = require('./auth');

const NAME_RE = /^[A-Za-z0-9][\w.\-]{0,99}$/;
const SESSION_RE = /^[0-9a-f-]{8,64}$/;
const FILENAME_FORBIDDEN_RE = /auth|credential|token\.json|\.env/i;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const RATE_MAX = 600;        // 每令牌每分钟
const RATE_WINDOW = 60000;
const IP_FAIL_WINDOW = 10 * 60 * 1000; // 令牌暴力破解：按 IP 统计失败
const IP_FAIL_MAX = 20;

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function dirSize(dir) {
  let total = 0;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch (e2) { /* 忽略 */ } }
  }
  return total;
}

function decodeSeg(s) {
  try { return decodeURIComponent(s); } catch (e) { return null; }
}

// 深度遍历 JSON，只对字符串值脱敏（键名如 tokens 不能动，否则破坏结构）
function redactJsonStrings(v) {
  if (typeof v === 'string') return redact(v).text;
  if (Array.isArray(v)) return v.map(redactJsonStrings);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redactJsonStrings(v[k]);
    return o;
  }
  return v;
}

// o: {dataDir, checkToken(given)->bool, maxBytes, onRunChange(machine, run),
//     onMachineChange(machine), onQuota()}
function createIngest(o) {
  const dataDir = path.resolve(o.dataDir);
  const maxBytes = o.maxBytes || 2 * 1024 ** 3;
  let used = dirSize(dataDir);
  const hits = [];
  const ipFails = new Map(); // ip -> 失败时间戳数组（令牌暴力破解防护）

  function rateOk() {
    const now = Date.now();
    while (hits.length && hits[0] <= now - RATE_WINDOW) hits.shift();
    if (hits.length >= RATE_MAX) return false;
    hits.push(now);
    return true;
  }

  function ipFailsOf(ip) {
    const now = Date.now();
    const arr = (ipFails.get(ip) || []).filter((t) => t > now - IP_FAIL_WINDOW);
    if (arr.length) ipFails.set(ip, arr); else ipFails.delete(ip);
    return arr;
  }

  // 只用校验过的名称拼接，并确认结果仍在 DATA 内
  function safeJoin(...names) {
    const p = path.resolve(path.join(dataDir, ...names));
    if (p !== dataDir && !p.startsWith(dataDir + path.sep)) return null;
    return p;
  }

  function atomicWrite(p, text, mtimeIso) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = path.join(path.dirname(p), '.tmp-' + crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
    if (mtimeIso) {
      const t = Date.parse(mtimeIso);
      if (Number.isFinite(t)) fs.utimesSync(p, new Date(t), new Date(t));
    }
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length']);
      if (Number.isFinite(len) && len > limit) return reject({ code: 413 });
      const chunks = [];
      let total = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        total += c.length;
        if (total > limit) { over = true; return reject({ code: 413 }); }
        chunks.push(c);
      });
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => { if (!over) reject({ code: 400 }); });
      req.on('close', () => { if (!over) reject({ code: 400 }); });
    });
  }

  async function putFile(req, parts) {
    const machine = decodeSeg(parts[3]);
    const run = decodeSeg(parts[4]);
    const filename = decodeSeg(parts[5]);
    if (!NAME_RE.test(machine || '') || !NAME_RE.test(run || '')) return { code: 400, msg: '名称不合法' };
    if (!NAME_RE.test(filename || '') || FILENAME_FORBIDDEN_RE.test(filename)) return { code: 400, msg: '文件名不合法' };
    const text = redact(await readBody(req, MAX_FILE)).text; // 双保险：写前再脱敏
    const p = safeJoin(machine, 'runs', run, filename);
    if (!p) return { code: 400, msg: '路径不合法' };
    let old = 0;
    try { old = fs.statSync(p).size; } catch (e) { /* 新文件 */ }
    if (used - old + Buffer.byteLength(text) > maxBytes) return { code: 507, msg: '超过磁盘配额' };
    atomicWrite(p, text, req.headers['x-mtime']);
    used += Buffer.byteLength(text) - old;
    if (typeof o.onRunChange === 'function') o.onRunChange(machine, run);
    return { code: 204 };
  }

  async function putCodex(req, parts) {
    const machine = decodeSeg(parts[3]);
    const sessionId = decodeSeg(parts[4]);
    if (!NAME_RE.test(machine || '') || !SESSION_RE.test(sessionId || '')) return { code: 400, msg: '名称不合法' };
    let j;
    try { j = JSON.parse(await readBody(req, MAX_JSON)); } catch (e) { return { code: 400, msg: 'JSON 不合法' }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { code: 400, msg: 'JSON 不合法' };
    const raw = JSON.stringify(redactJsonStrings(j));
    const p = safeJoin(machine, 'codex', sessionId + '.json');
    if (!p) return { code: 400, msg: '路径不合法' };
    let old = 0;
    try { old = fs.statSync(p).size; } catch (e) { /* 新文件 */ }
    if (used - old + Buffer.byteLength(raw) > maxBytes) return { code: 507, msg: '超过磁盘配额' };
    atomicWrite(p, raw, null);
    used += Buffer.byteLength(raw) - old;
    if (typeof o.onMachineChange === 'function') o.onMachineChange(machine);
    return { code: 204 };
  }

  async function putQuota(req, parts) {
    const machine = decodeSeg(parts[3]);
    if (!NAME_RE.test(machine || '')) return { code: 400, msg: '名称不合法' };
    let j;
    try { j = JSON.parse(await readBody(req, MAX_JSON)); } catch (e) { return { code: 400, msg: 'JSON 不合法' }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { code: 400, msg: 'JSON 不合法' };
    const raw = JSON.stringify(redactJsonStrings(j));
    const p = safeJoin(machine, 'quota.json');
    if (!p) return { code: 400, msg: '路径不合法' };
    let old = 0;
    try { old = fs.statSync(p).size; } catch (e) { /* 新文件 */ }
    if (used - old + Buffer.byteLength(raw) > maxBytes) return { code: 507, msg: '超过磁盘配额' };
    atomicWrite(p, raw, req.headers['x-mtime']);
    used += Buffer.byteLength(raw) - old;
    if (typeof o.onQuota === 'function') o.onQuota();
    return { code: 204 };
  }

  async function delRun(parts) {
    const machine = decodeSeg(parts[3]);
    const run = decodeSeg(parts[4]);
    if (!NAME_RE.test(machine || '') || !NAME_RE.test(run || '')) return { code: 400, msg: '名称不合法' };
    const p = safeJoin(machine, 'runs', run);
    if (!p) return { code: 400, msg: '路径不合法' };
    let st;
    try { st = fs.statSync(p); } catch (e) { return { code: 204 }; }
    if (!st.isDirectory()) return { code: 400, msg: '不是任务目录' };
    // 先广播再删：key 计算依赖目录存在
    if (typeof o.onRunChange === 'function') o.onRunChange(machine, run);
    used -= dirSize(p);
    fs.rmSync(p, { recursive: true, force: true });
    return { code: 204 };
  }

  // 用原始（未归一化）路径解析：URL 构造器会吃掉 `..`，必须自己看到原始段
  return async function handleIngest(req, res, rawPath) {
    const ip = clientIp(req);
    // 暴力破解防护：失败超过阈值后，该 IP 的所有 /ingest/* 一律 429（含令牌正确的）
    if (ipFailsOf(ip).length > IP_FAIL_MAX) return send(res, 429, { error: '请求过于频繁' });
    const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''));
    if (!m || !o.checkToken(m[1].trim())) {
      const arr = ipFailsOf(ip);
      arr.push(Date.now());
      ipFails.set(ip, arr);
      return send(res, 401, { error: 'unauthorized' });
    }
    if (!rateOk()) return send(res, 429, { error: '请求过于频繁' });
    const parts = rawPath.split('/').filter(Boolean); // ['ingest','v1',...]
    let r;
    try {
      if (parts[1] !== 'v1') r = { code: 404, msg: 'not found' };
      else if (parts[2] === 'ping' && req.method === 'GET') {
        return send(res, 200, { ok: true, time: new Date().toISOString(), limits: { maxFileBytes: MAX_FILE } });
      } else if (parts[2] === 'files' && req.method === 'PUT' && parts.length === 6) r = await putFile(req, parts);
      else if (parts[2] === 'codex' && req.method === 'PUT' && parts.length === 5) r = await putCodex(req, parts);
      else if (parts[2] === 'quota' && req.method === 'PUT' && parts.length === 4) r = await putQuota(req, parts);
      else if (parts[2] === 'runs' && req.method === 'DELETE' && parts.length === 5) r = await delRun(parts);
      else if (['files', 'codex', 'quota', 'runs'].includes(parts[2])) r = { code: 400, msg: '路径不合法' };
      else r = { code: 404, msg: 'not found' };
    } catch (e) {
      r = (e && e.code) ? { code: e.code, msg: e.code === 413 ? '请求体过大' : '请求不合法' } : { code: 400, msg: '请求不合法' };
    }
    if (r.code === 413) {
      // 超限：返回 413 并立即中断连接
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(JSON.stringify({ error: r.msg }), () => req.destroy());
      return;
    }
    if (r.code === 204) { res.writeHead(204); return res.end(); }
    send(res, r.code, { error: r.msg });
  };
}

module.exports = { createIngest, NAME_RE, SESSION_RE };
