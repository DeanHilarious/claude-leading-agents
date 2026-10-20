'use strict';
// 配置加载：命令行 > 环境变量 > ~/.claude-leading-agents/reporter.json。
// 令牌只从环境变量或 token 文件读取，绝不进命令行参数与日志。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// 解析命令行参数（数组形式，便于测试注入）
function parseArgs(argv) {
  const out = { interval: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--runs') out.runs = argv[++i];
    else if (a === '--codex-home') out.codexHome = argv[++i];
    else if (a === '--machine') out.machine = argv[++i];
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--once') out.once = true;
    else if (a === '--dry-run') out.dryRun = true;
    // 以下为测试/高级用途注入点，不在 README 的常规用法里
    else if (a === '--state') out.state = argv[++i];
    else if (a === '--token-file') out.tokenFile = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else throw new Error('未知参数：' + a);
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

// 令牌文件：必须是 0600，否则拒绝使用（防其他用户读取）
function readTokenFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  if (!st.isFile()) return null;
  if (st.mode & 0o077) {
    throw new Error('令牌文件权限不是 0600，拒绝使用。请执行：chmod 600 ' + file);
  }
  const tok = fs.readFileSync(file, 'utf8').trim();
  return tok || null;
}

function checkUrl(str) {
  let u;
  try { u = new URL(str); } catch (e) { return { err: 'URL 不合法：' + str }; }
  if (u.protocol !== 'https:' && !LOCAL_HOSTS.has(u.hostname)) {
    return { err: '服务器地址必须是 https://（当前 ' + u.protocol + '）。仅 localhost / 127.0.0.1 / [::1] 允许 http 便于本地联调。' };
  }
  return { url: u };
}

function sanitizeMachine(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '');
}

function nameOk(s) { return /^[A-Za-z0-9][\w.\-]{0,99}$/.test(s); }

// 汇总配置。env / home 可注入，便于测试。
function loadConfig(argv, o) {
  o = o || {};
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const base = path.join(home, '.claude-leading-agents');
  const args = parseArgs(argv);
  const conf = readJson(args.config || path.join(base, 'reporter.json'));
  // 配置文件里的 ~/ 前缀按本机 HOME 展开
  const expand = (p) => (typeof p === 'string' && p.startsWith('~/')) ? path.join(home, p.slice(2)) : p;

  const dryRun = !!args.dryRun;
  const urlStr = args.url || env.DASHBOARD_URL || conf.url || null;
  const url = urlStr ? checkUrl(urlStr) : null;
  if (urlStr && url.err) return { err: url.err };
  if (!urlStr && !dryRun) {
    return { err: '缺少服务器地址：请用 --url、环境变量 DASHBOARD_URL，或 ~/.claude-leading-agents/reporter.json 里的 "url" 配置。' };
  }

  let machine = args.machine || env.REPORTER_MACHINE || conf.machine || sanitizeMachine(os.hostname());
  if (!machine || !nameOk(machine)) {
    return { err: '机器名不合法（须匹配 ^[A-Za-z0-9][\\w.-]{0,99}$）：' + machine };
  }

  // 令牌：dry-run 不联网，可不提供
  let token = env.DASHBOARD_INGEST_TOKEN || null;
  if (!token) {
    try { token = readTokenFile(args.tokenFile || path.join(base, 'token')); } catch (e) { return { err: e.message }; }
  }
  if (!token && !dryRun) return { err: '缺少令牌：请设置环境变量 DASHBOARD_INGEST_TOKEN，或写入 ~/.claude-leading-agents/token（chmod 600）。' };

  const interval = args.interval;
  if (!Number.isFinite(interval) || interval < 1) return { err: '--interval 必须是 ≥1 的秒数' };

  return {
    ok: true,
    url: urlStr || 'http://localhost', // dry-run 无地址时的占位，不会联网
    machine,
    runsDir: args.runs || expand(conf.runs) || path.join(home, '.codex-runs'),
    codexHome: args.codexHome || expand(conf.codexHome) || path.join(home, '.codex'),
    stateFile: args.state || path.join(base, 'reporter-state.json'),
    token,
    dryRun,
    once: !!args.once,
    interval,
  };
}

module.exports = { loadConfig, parseArgs, checkUrl, sanitizeMachine };
