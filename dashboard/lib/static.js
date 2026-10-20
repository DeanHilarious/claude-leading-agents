'use strict';
// 静态文件服务（public/）与登录页。
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
};

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function serveStatic(res, url, publicDir) {
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

function serveLogin(res, publicDir) {
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(publicDir, 'login.html')));
  } catch (e) {
    sendText(res, 500, 'login page missing');
  }
}

module.exports = { serveStatic, serveLogin, MIME };
