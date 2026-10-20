'use strict';
// 登录会话、登录限流、接收令牌校验。密钥/令牌/密码绝不出现在日志与报错里。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'cla_session';
const TTL_MS = 7 * 24 * 3600 * 1000; // 604800s，与 cookie Max-Age 一致
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

function sha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest(); }
function safeEqual(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b); }
// 先各自 sha256 再比较：长度归一，避免 timingSafeEqual 的长度泄露
function checkPassword(given, expected) { return safeEqual(sha(given), sha(expected)); }
function checkToken(given, expected) { return safeEqual(sha(given), sha(expected)); }

// 会话密钥：环境变量优先，否则读/生成 DATA/.session-secret（32 随机字节，0600）
function loadSessionSecret(dataDir) {
  if (process.env.DASHBOARD_SESSION_SECRET) return process.env.DASHBOARD_SESSION_SECRET;
  const p = path.join(dataDir, '.session-secret');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { /* 不存在则生成 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, s, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (e) { /* 非 POSIX */ }
  return s;
}

function signSession(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + mac;
}

function verifySession(secret, cookie) {
  const s = String(cookie || '');
  const i = s.indexOf('.');
  if (i < 0) return false;
  const payload = s.slice(0, i);
  const given = Buffer.from(s.slice(i + 1), 'base64url');
  const expect = crypto.createHmac('sha256', secret).update(payload).digest();
  if (!safeEqual(given, expect)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now(); } catch (e) { return false; }
}

// 取客户端 IP：X-Forwarded-For 最后一个（最外层代理追加的真实 IP），否则 socket 地址
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const parts = xff.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

// 登录限流：同一 IP 每 10 分钟最多 10 次失败
function createLoginLimiter() {
  const fails = new Map();
  const prune = (ip, now) => {
    const arr = (fails.get(ip) || []).filter((t) => t > now - LOGIN_WINDOW_MS);
    if (arr.length) fails.set(ip, arr); else fails.delete(ip);
  };
  return {
    allowed(ip) { prune(ip, Date.now()); return (fails.get(ip) || []).length < LOGIN_MAX_FAILS; },
    fail(ip) { prune(ip, Date.now()); const arr = fails.get(ip) || []; arr.push(Date.now()); fails.set(ip, arr); },
  };
}

function sendJson(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
}

// o: {password, token, secret}
function createAuth(o) {
  const limiter = createLoginLimiter();

  function cookieFromReq(req) {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string') return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }

  function hasSession(req) { return verifySession(o.secret, cookieFromReq(req)); }

  function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https'; }

  function setCookie(res, val, maxAge, secure) {
    res.setHeader('Set-Cookie', COOKIE + '=' + val + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge + (secure ? '; Secure' : ''));
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total > limit) { req.destroy(); return reject(new Error('too large')); }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleLogin(req, res) {
    let password = null;
    try {
      const body = await readBody(req, 64 * 1024);
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        const j = JSON.parse(body || '{}');
        password = typeof j.password === 'string' ? j.password : null;
      } else {
        password = new URLSearchParams(body).get('password');
      }
    } catch (e) { return sendJson(res, 400, { error: '请求格式不正确' }); }
    const ip = clientIp(req);
    if (!limiter.allowed(ip)) return sendJson(res, 429, { error: '尝试过于频繁，请 10 分钟后再试' });
    if (password == null || !checkPassword(password, o.password)) {
      limiter.fail(ip);
      return sendJson(res, 401, { error: '密码不正确' });
    }
    setCookie(res, signSession(o.secret), Math.floor(TTL_MS / 1000), isHttps(req));
    sendJson(res, 200, { ok: true });
  }

  function handleLogout(req, res) {
    setCookie(res, '', 0, isHttps(req));
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    res.end();
  }

  return { hasSession, handleLogin, handleLogout, checkToken: (t) => checkToken(t, o.token), clientIp };
}

module.exports = { createAuth, checkPassword, checkToken, loadSessionSecret, signSession, verifySession, clientIp };
