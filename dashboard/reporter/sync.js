'use strict';
// 同步引擎：全量扫描 runs 目录，diff 状态文件，上传变化、删除消失的任务与 Codex 派生数据。
// 单个文件失败不影响其他文件；dry-run 不联网不写状态。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classify, readFileForUpload } = require('./filter');
const { sessionIdsOfRun, buildPayload, quotaPayload, fileSig } = require('./codexdata');
const codex = require('../lib/codex');

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function emptyState() { return { files: {}, runs: {}, codex: {}, quota: null }; }

function loadState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      files: j.files || {},
      runs: j.runs || {},
      codex: j.codex || {},
      quota: j.quota || null,
    };
  } catch (e) { return emptyState(); }
}

// 原子写 + 0600（状态含各文件哈希，不外泄）；目录不存在则先建（0700）
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function listRunDirs(runsDir) {
  let ents;
  try { ents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch (e) { return []; }
  return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

function listFiles(runDir) {
  let ents;
  try { ents = fs.readdirSync(runDir, { withFileTypes: true }); } catch (e) { return []; }
  return ents.filter((e) => e.isFile()).map((e) => e.name).sort();
}

function authHeaders(cfg) {
  return { Authorization: 'Bearer ' + cfg.token };
}

// 创建同步上下文（redactFn 可注入，便于测试不依赖脱敏实现细节）
function createContext(cfg, client, o) {
  o = o || {};
  return {
    cfg,
    client,
    redactFn: o.redactFn || require('../lib/redact').redact,
    out: o.out || ((s) => console.log(s)),
    state: cfg.dryRun ? emptyState() : loadState(cfg.stateFile), // dry-run 不读不写状态，始终列出全部
    indexRebuilt: false,
  };
}

function ensureIndex(ctx) {
  // 有会话找不到时重建一次索引（与会端 server.js 的策略一致）
  const missing = ctx.missingSession;
  if (missing && !ctx.indexRebuilt) {
    ctx.index = codex.buildCodexIndex(ctx.cfg.codexHome);
    ctx.indexRebuilt = true;
  }
}

// 全量同步一遍。返回错误列表（空 = 全部成功）。
async function syncOnce(ctx) {
  const { cfg, client, state, redactFn, out } = ctx;
  const errors = [];
  const dry = cfg.dryRun;
  const runIds = listRunDirs(cfg.runsDir);
  ctx.index = ctx.index || codex.buildCodexIndex(cfg.codexHome);

  // 本地消失的任务：此前上传过才发 DELETE
  for (const run of Object.keys(state.runs)) {
    if (runIds.includes(run)) continue;
    try {
      if (!dry) {
        await client.request(cfg.url + '/ingest/v1/runs/' + cfg.machine + '/' + encodeURIComponent(run), {
          method: 'DELETE', headers: authHeaders(cfg),
        });
      }
      out('× ' + run + '（本地已删除，清理远端）');
      delete state.runs[run];
      for (const k of Object.keys(state.files)) if (k.split('/')[0] === run) delete state.files[k];
    } catch (e) {
      errors.push('DELETE ' + run + '：' + e.message);
    }
  }

  const stats = { uploaded: 0, skipped: 0, redactions: 0 };
  for (const run of runIds) {
    const runDir = path.join(cfg.runsDir, run);
    if (fs.existsSync(path.join(runDir, '.no-upload'))) {
      stats.skipped += listFiles(runDir).length;
      out('- ' + run + '（.no-upload，整个任务跳过）');
      continue;
    }
    for (const name of listFiles(runDir)) {
      const rel = run + '/' + name;
      const c = classify(name);
      if (!c.ok) {
        stats.skipped++;
        if (dry) out('- ' + rel + '（' + c.reason + '）');
        continue;
      }
      let st;
      try { st = fs.statSync(path.join(runDir, name)); } catch (e) { continue; }
      try {
        const r = readFileForUpload(path.join(runDir, name));
        if (!r.ok) {
          stats.skipped++;
          if (dry) out('- ' + rel + '（' + r.reason + '）');
          continue;
        }
        const red = redactFn(r.text);
        const hash = sha256(red.text);
        if (!dry && state.files[rel] === hash) { stats.skipped++; continue; } // 未变化
        if (!dry) {
          await client.request(cfg.url + '/ingest/v1/files/' + cfg.machine + '/' + encodeURIComponent(run) + '/' + encodeURIComponent(name), {
            method: 'PUT',
            headers: {
              ...authHeaders(cfg),
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Mtime': new Date(st.mtimeMs).toISOString(),
              'X-Redactions': String(red.count),
            },
            body: red.text,
          });
        }
        out('↑ ' + rel + '（脱敏 ' + red.count + ' 处' + (r.truncated ? '，超 2MB 已取末尾' : '') + '）');
        stats.uploaded++;
        stats.redactions += red.count;
        state.files[rel] = hash;
        state.runs[run] = true;
      } catch (e) {
        errors.push(rel + '：' + e.message);
      }
    }
  }

  // Codex 派生数据
  for (const run of runIds) {
    const runDir = path.join(cfg.runsDir, run);
    if (fs.existsSync(path.join(runDir, '.no-upload'))) continue;
    for (const id of sessionIdsOfRun(runDir)) {
      try {
        ctx.missingSession = !ctx.index.byId[id.toLowerCase()];
        ensureIndex(ctx);
        const file = ctx.index.byId[id.toLowerCase()];
        if (!file) {
          if (dry) out('- codex/' + id + '（找不到会话文件）');
          continue;
        }
        const sig = fileSig(file);
        if (!dry && state.codex[id] === sig) continue;
        const built = buildPayload(ctx.index, id, redactFn);
        if (!built) continue;
        if (!dry) {
          await client.request(cfg.url + '/ingest/v1/codex/' + cfg.machine + '/' + id, {
            method: 'PUT',
            headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
            body: built.payload,
          });
        }
        out('↑ codex/' + id + '（' + JSON.parse(built.payload).steps.length + ' 步，脱敏 ' + built.redactions + ' 处）');
        stats.redactions += built.redactions;
        state.codex[id] = sig;
      } catch (e) {
        errors.push('codex/' + id + '：' + e.message);
      }
    }
  }

  // 额度
  try {
    const q = quotaPayload(ctx.index);
    const sig = q ? JSON.stringify(q) : null;
    if (sig && sig !== state.quota) {
      if (!dry) {
        await client.request(cfg.url + '/ingest/v1/quota/' + cfg.machine, {
          method: 'PUT',
          headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
          body: sig,
        });
      }
      out('↑ quota（额度）');
      state.quota = sig;
    }
  } catch (e) {
    errors.push('quota：' + e.message);
  }

  if (!dry) {
    try { saveState(cfg.stateFile, state); }
    catch (e) { errors.push('保存状态失败：' + e.message); }
  }
  out('完成：上传 ' + stats.uploaded + ' 个文件，跳过 ' + stats.skipped + ' 个，失败 ' + errors.length + ' 个，脱敏共 ' + stats.redactions + ' 处');
  return errors;
}

module.exports = { syncOnce, createContext, loadState, saveState, sha256 };
