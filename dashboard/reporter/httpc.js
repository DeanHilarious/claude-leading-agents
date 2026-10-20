'use strict';
// 极简 HTTP(S) 客户端：PUT/GET/DELETE + 指数退避重试。
// 网络错误 / 429 / 5xx 重试（1s 起、最长 5 分钟、带抖动）；400/401/413 等不重试。
const http = require('http');
const https = require('https');

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function requestOnce(urlStr, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效 URL')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    if (body != null) req.write(body);
    req.end();
  });
}

// ctl.closed 置 true 后：不再发起重试，等待在途请求结束即抛错（用于优雅退出）
function createClient(retryOpts) {
  const ro = retryOpts || {};
  const baseMs = ro.baseMs || 1000;
  const maxMs = ro.maxMs || 5 * 60 * 1000;
  const maxAttempts = ro.maxAttempts || 10;
  const ctl = { closed: false, inflight: 0 };

  async function request(urlStr, opts) {
    const o = opts || {};
    let delay = baseMs;
    for (let i = 1; ; i++) {
      if (ctl.closed) throw new Error('正在退出，已取消请求');
      ctl.inflight++;
      let res;
      try {
        res = await requestOnce(urlStr, {
          method: o.method || 'GET',
          headers: o.headers || {},
          body: o.body != null ? o.body : null,
          timeoutMs: o.timeoutMs || 30000,
        });
      } catch (e) {
        if (ctl.closed || i >= maxAttempts) throw new Error('网络错误（重试 ' + (i - 1) + ' 次后放弃）：' + e.message);
        await sleep(delay + Math.random() * Math.min(delay, 500));
        delay = Math.min(delay * 2, maxMs);
        continue;
      } finally { ctl.inflight--; }
      if (res.status >= 200 && res.status < 300) return res;
      const retryable = RETRY_STATUS.has(res.status);
      if (retryable && i < maxAttempts && !ctl.closed) {
        await sleep(delay + Math.random() * Math.min(delay, 500));
        delay = Math.min(delay * 2, maxMs);
        continue;
      }
      const err = new Error('HTTP ' + res.status + (res.body ? '：' + res.body.slice(0, 200) : ''));
      err.status = res.status;
      throw err;
    }
  }

  return { request, ctl };
}

module.exports = { createClient };
