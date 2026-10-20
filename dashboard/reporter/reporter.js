'use strict';
// reporter 入口：命令行、启动校验（ping）、一遍同步 / 常驻监视。
// 用法：
//   node dashboard/reporter/reporter.js --url URL [--runs DIR] [--codex-home DIR]
//        [--machine NAME] [--once] [--dry-run] [--interval 30]
const { loadConfig } = require('./config');
const { createClient } = require('./httpc');
const { createContext, syncOnce } = require('./sync');
const fs = require('fs');

const WATCH_DEBOUNCE_MS = 2000;

// 优雅退出：信号到来后不再开始新扫描、取消重试，等在途请求结束
function installSignalHandlers(stop) {
  let done = false;
  const h = () => {
    if (done) return;
    done = true;
    stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', h);
  process.on('SIGTERM', h);
}

// 供测试与 CLI 共用。io 可注入捕获输出。
async function run(argv, o) {
  o = o || {};
  const out = o.out || ((s) => console.log(s));
  const err = o.err || ((s) => console.error(s));
  const env = o.env || process.env;
  const home = o.home;
  const cfg = loadConfig(argv, { env, home });
  if (cfg.err) {
    err('配置错误：' + cfg.err);
    return 1;
  }
  const client = createClient({ baseMs: o.retryBaseMs, maxAttempts: o.retryMaxAttempts });
  const ctx = createContext(cfg, client, { out, redactFn: o.redactFn });

  // 启动校验令牌与连通性（dry-run 不联网）
  if (!cfg.dryRun) {
    try {
      await client.request(cfg.url + '/ingest/v1/ping', { headers: { Authorization: 'Bearer ' + cfg.token } });
    } catch (e) {
      const m = e.status === 401
        ? '令牌校验失败（401）：请检查 DASHBOARD_INGEST_TOKEN 或 ~/.claude-leading-agents/token。'
        : '无法连接服务器（GET /ingest/v1/ping 失败）：' + e.message;
      err(m);
      return 1;
    }
  }

  if (cfg.once || cfg.dryRun) {
    const errors = await syncOnce(ctx);
    for (const e of errors) err('失败：' + e);
    if (errors.length) return 1;
    if (cfg.dryRun) out('（dry-run：以上为将执行的动作，未联网、未写状态）');
    return 0;
  }

  // 常驻模式：fs.watch 触发（去抖）+ 定时全量兜底
  let running = false;
  let stopping = false;
  let timer = null;
  const scan = async () => {
    if (running || stopping) return;
    running = true;
    try {
      const errors = await syncOnce(ctx);
      for (const e of errors) err('失败：' + e); // 失败不退出：下一轮全量扫描会补齐
    } finally { running = false; }
  };
  const stop = async () => {
    stopping = true;
    client.ctl.closed = true;
    clearTimeout(timer);
    if (intervalTimer) clearInterval(intervalTimer);
    if (watcher) { try { watcher.close(); } catch (e) { /* ignore */ } }
    while (running) await new Promise((r) => setTimeout(r, 50)); // 等在途请求完成
  };
  let watcher = null;
  let intervalTimer = null;
  try {
    watcher = fs.watch(cfg.runsDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(scan, WATCH_DEBOUNCE_MS);
    });
  } catch (e) { /* watch 失败则靠定时扫描兜底 */ }
  intervalTimer = setInterval(scan, cfg.interval * 1000);
  installSignalHandlers(stop);
  out('reporter 已启动：' + cfg.machine + ' → ' + cfg.url + '（每 ' + cfg.interval + 's 全量扫描，Ctrl-C 退出）');
  await scan(); // 启动先同步一遍
  return new Promise(() => {}); // 常驻不返回
}

function main() {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error('发生错误：' + e.message);
    process.exit(1);
  });
}

if (require.main === module) main();
module.exports = { run };
