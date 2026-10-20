'use strict';
// /api/* 路由处理。依赖全部由 ctx 注入，便于测试。
const fs = require('fs');
const path = require('path');
const codex = require('./codex');
const agg = require('./aggregate');
const { isSafeFileName, isCredentialName } = require('./util');
const cbLib = require('./codebuddy');

// ctx: {cfg, offsetMin, getNow, listEntries, findEntry, scanOne, indexFor, quota, procsCount}
function createApi(ctx) {
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function handleFile(req, res, url, entry) {
    const name = url.searchParams.get('name') || '';
    if (!isSafeFileName(name) || isCredentialName(name)) return sendJson(res, 400, { error: 'bad name' });
    const p = path.join(entry.dir, name);
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

  function handleFeed(res, entry, subId) {
    const run = ctx.scanOne(entry);
    const sub = run.subtasks.find((s) => s.id === subId);
    if (!sub) return sendJson(res, 404, { error: 'not found' });
    const live = sub.status === 'running';
    if (sub.agent === 'codebuddy') {
      let summary = null;
      const sumF = run.files.map((f) => f.name).find((f) => new RegExp('^sum-' + subId + '(?:-r\\d+)?\\.txt$').test(f));
      if (sumF) {
        const parsed = cbLib.parseSumLine(fs.readFileSync(path.join(entry.dir, sumF), 'utf8'));
        if (parsed) summary = { exit: parsed.exit, subtype: parsed.subtype, session: parsed.session, turns: parsed.turns, input: parsed.input, output: parsed.output, denials: parsed.denials };
      }
      return sendJson(res, 200, { agent: 'codebuddy', live, steps: [], summary });
    }
    // codex：取该子任务最新一个会话的数据
    const id = sub.sessionIds[sub.sessionIds.length - 1];
    const file = id ? ctx.indexFor(entry).byId[id.toLowerCase()] : null;
    const steps = file ? codex.parseFeed(file) : [];
    sendJson(res, 200, { agent: sub.agent, live, steps, summary: null });
  }

  function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (parts[1] === 'overview') {
      const list = ctx.listEntries().map(ctx.scanOne);
      const runningAgents = (ctx.cfg.demo || ctx.cfg.data)
        ? list.reduce((a, r) => a + r.subtasks.filter((s) => s.status === 'running').length, 0)
        : ctx.procsCount();
      return sendJson(res, 200, agg.overview(list, { now: ctx.getNow(), offsetMin: ctx.offsetMin, demo: ctx.cfg.demo, remote: !!ctx.cfg.data, quota: ctx.quota(), runningAgents }));
    }
    if (parts[1] === 'runs' && parts[2] && !parts[3]) {
      const entry = ctx.findEntry(decodeURIComponent(parts[2]));
      if (!entry) return sendJson(res, 404, { error: 'not found' });
      const json = agg.runToJson(ctx.scanOne(entry), ctx.offsetMin);
      json.generatedAt = new Date(ctx.getNow()).toISOString();
      if (ctx.cfg.demo) json.dir = `~/.codex-runs/${json.id}`;
      // 远程模式不暴露服务器路径，只展示逻辑位置标签
      if (ctx.cfg.data) json.dir = entry.machine + ':~/.codex-runs/' + entry.name;
      return sendJson(res, 200, json);
    }
    if (parts[1] === 'runs' && parts[2] && parts[3] === 'file') {
      const entry = ctx.findEntry(decodeURIComponent(parts[2]));
      if (!entry) return sendJson(res, 404, { error: 'not found' });
      return handleFile(req, res, url, entry);
    }
    if (parts[1] === 'runs' && parts[2] && parts[3] === 'subtasks' && parts[4] && parts[5] === 'feed') {
      const entry = ctx.findEntry(decodeURIComponent(parts[2]));
      if (!entry) return sendJson(res, 404, { error: 'not found' });
      return handleFeed(res, entry, decodeURIComponent(parts[4]));
    }
    if (parts[1] === 'bill') {
      const range = url.searchParams.get('range') || '7d';
      const list = ctx.listEntries().map(ctx.scanOne);
      return sendJson(res, 200, agg.bill(list, range, { now: ctx.getNow(), offsetMin: ctx.offsetMin, quota: ctx.quota() }));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  return { handleApi, sendJson };
}

module.exports = { createApi };
