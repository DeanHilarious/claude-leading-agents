'use strict';
// reporter 日志模式测试：head/full/none、.upload-logs 例外、主目录路径替换、
// parseLogHeader 兼容、模式切换重传、dry-run 输出格式。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { run } = require('../reporter/reporter');
const { loadConfig } = require('../reporter/config');
const { isLogName } = require('../reporter/filter');
const { parseLogHeader } = require('../lib/runs');

const TOKEN = 'test-ingest-token-log';
const MACHINE = 'logmac';
const USER = 'fakeuser'; // 注入的用户名：/Users/fakeuser、/home/fakeuser 都要替换成 ~

function makeServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, auth: req.headers.authorization || '', body, status: 0 };
      requests.push(rec);
      const reply = (code) => { rec.status = code; res.writeHead(code); res.end(''); };
      if (rec.auth !== 'Bearer ' + TOKEN) return reply(401);
      if (req.method === 'GET' && req.url === '/ingest/v1/ping') return reply(200);
      reply(204);
    });
  });
  return { server, requests };
}

// 新版 Codex 日志：-------- 分隔的头 + 长正文（含不应上传的标记）
function codexLog() {
  const head = [
    'OpenAI Codex v0.162.0',
    '--------',
    'workdir: /Users/' + USER + '/code/some-project',
    'model: gpt-6.1-sol',
    'provider: openai',
    'approval: never',
    'sandbox: workspace-write [workdir, /tmp, $TMPDIR]',
    'reasoning effort: high',
    'reasoning summaries: none',
    'session id: 01a144ee-22d1-7a22-bf98-d5f21be19f7e',
    '--------',
    '用户消息：开始干活',
    '',
  ].join('\n');
  const body = [];
  for (let i = 1; i <= 30; i++) body.push('正文第 ' + String(i).padStart(2, '0') + ' 行：执行操作 BODY-' + String(i).padStart(3, '0'));
  body[10] = 'BODY-SECRET-MARKER 不应出现在文件头里';
  return head + '\n' + body.join('\n') + '\n';
}

// 旧版/无分隔线的普通日志（head 模式取前 20 行）
function plainLog() {
  const lines = [];
  for (let i = 1; i <= 30; i++) lines.push('普通日志第 ' + String(i).padStart(2, '0') + ' 行');
  return lines.join('\n') + '\n';
}

// 旧版带 session id 的 log-*.txt（供 codex 派生数据关联会话）
function oldLog() {
  return [
    'OpenAI Codex v0.9.4',
    'model: gpt-6.1-sol',
    'reasoning effort: medium',
    'session id: aaaa1111-2222-3333-4444-555555555555',
    'workdir: /Users/' + USER + '/todo-app',
    '',
    '正文若干行。',
  ].join('\n') + '\n';
}

function betaLog() {
  const lines = [];
  for (let i = 1; i <= 30; i++) lines.push('beta 第 ' + String(i).padStart(2, '0') + ' 行');
  lines[24] = 'BETA-FULL-MARKER 第 25 行';
  return lines.join('\n') + '\n';
}

const ROLLOUT = [
  '{"timestamp":"2026-10-20T10:01:00+08:00","type":"session_meta","payload":{"session_id":"aaaa1111-2222-3333-4444-555555555555","cwd":"/Users/' + USER + '/todo-app"}}',
  '{"timestamp":"2026-10-20T10:02:00+08:00","type":"response_item","payload":{"type":"custom_tool_call","name":"shell","input":"{\\"cmd\\":\\"cat /Users/' + USER + '/todo-app/README.md\\"}"}}',
  '{"timestamp":"2026-10-20T10:03:00+08:00","type":"event_msg","payload":{"type":"agent_message","message":"完成，文件在 /Users/' + USER + '/todo-app/README.md"}}',
  '{"timestamp":"2026-10-20T10:04:00+08:00","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":50,"total_tokens":150}}}}',
].join('\n') + '\n';

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'replog-home-'));
  fs.mkdirSync(path.join(home, '.claude-leading-agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-leading-agents', 'token'), TOKEN);
  fs.chmodSync(path.join(home, '.claude-leading-agents', 'token'), 0o600);
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replog-runs-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'replog-codex-'));
  // run alpha：三种日志形态 + 非日志文本
  const alpha = path.join(runsDir, 'alpha');
  fs.mkdirSync(alpha);
  fs.writeFileSync(path.join(alpha, 'log1.txt'), codexLog());          // 新版 Codex 头
  fs.writeFileSync(path.join(alpha, 'plain-log.txt'), plainLog());     // 无头普通日志
  fs.writeFileSync(path.join(alpha, 'review-fix1-log.txt'), '返工记录\n补了测试。\n');
  fs.writeFileSync(path.join(alpha, 'x.log'), '小日志\n');
  fs.writeFileSync(path.join(alpha, 'log-api.txt'), oldLog());         // 旧版 log-*.txt
  fs.writeFileSync(path.join(alpha, 'sum-a.txt'), '汇总输出 -> /Users/' + USER + '/.codex-runs/alpha/sum-a.txt\n用户名 ' + USER + ' 单独出现、@' + USER + ' 提及都替换，' + USER + '2 不动\n');
  fs.writeFileSync(path.join(alpha, 'spec-a.md'), '# 规格\n路径 /Users/' + USER + '/proj/spec-a.md 与 /home/' + USER + '/other 都要替换\n');
  // run beta：.upload-logs 例外（日志按 full 处理）
  const beta = path.join(runsDir, 'beta');
  fs.mkdirSync(beta);
  fs.writeFileSync(path.join(beta, '.upload-logs'), '');
  fs.writeFileSync(path.join(beta, 'beta-log.txt'), betaLog());
  fs.writeFileSync(path.join(beta, 'spec-b.md'), '# beta\n');
  // codex home：会话里带主目录路径
  fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '10', '20'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'sessions', '2026', '10', '20',
    'rollout-2026-10-20T10-00-00-aaaa1111-2222-3333-4444-555555555555.jsonl'), ROLLOUT);
  // 模拟接收服务
  const srv = makeServer();
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const env = { DASHBOARD_URL: 'http://127.0.0.1:' + srv.server.address().port, DASHBOARD_INGEST_TOKEN: TOKEN };
  const call = (argv, o) => run(argv.concat(['--machine', MACHINE, '--runs', runsDir, '--codex-home', codexHome]), {
    env, home, user: USER, retryBaseMs: 5,
    out: (s) => (o && o.out || []).push(s),
    err: (s) => (o && o.err || []).push(s),
  });
  return {
    home, runsDir, codexHome, requests: srv.requests,
    call,
    cleanup: async () => { srv.server.close(); fs.rmSync(runsDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(codexHome, { recursive: true, force: true }); },
  };
}

const puts = (reqs, prefix) => reqs.filter((r) => r.method === 'PUT' && (!prefix || r.url.startsWith(prefix)));
const fileBody = (s, rel) => {
  const r = puts(s.requests, '/ingest/v1/files/' + MACHINE + '/').find((x) => x.url.endsWith('/' + rel));
  return r ? r.body : null;
};

test('isLogName：日志文件名匹配规则', () => {
  for (const n of ['log1.txt', 'log-api-r1.txt', 'review-fix1-log.txt', 'x.log', 'log.txt', 'LOG1.TXT']) {
    assert.ok(isLogName(n), n + ' 应是日志');
  }
  for (const n of ['sum-ui.txt', 'spec-api.md', 'result-api-r1.md', 'notes.txt', 'START', 'events.jsonl']) {
    assert.ok(!isLogName(n), n + ' 不应是日志');
  }
});

test('head 模式：Codex 头只传到第二条 --------，workdir 隐藏，parseLogHeader 仍可解析', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const out = [], err = [];
  assert.equal(await s.call(['--once'], { out, err }), 0, 'err=' + err.join('|'));
  const body = fileBody(s, 'alpha/log1.txt');
  assert.ok(body, 'log1.txt 应上传');
  assert.ok(body.endsWith('[日志正文未上传：仅上传文件头]\n'), '末尾应有说明行：' + JSON.stringify(body.slice(-80)));
  assert.ok(body.includes('model: gpt-6.1-sol'));
  assert.ok(body.includes('reasoning effort: high'));
  assert.ok(body.includes('session id: 01a144ee-22d1-7a22-bf98-d5f21be19f7e'));
  assert.ok(body.includes('workdir: <hidden>'), 'workdir 值应替换为 <hidden>');
  assert.ok(!body.includes('BODY-SECRET-MARKER'), '第二条 -------- 之后的正文不应上传');
  assert.ok(!body.includes('正文第 01 行'), '正文不应上传');
  // 服务端现有解析函数仍能读出 model / effort / session id / 是 Codex 日志
  const h = parseLogHeader(body);
  assert.equal(h.codex, true);
  assert.equal(h.model, 'gpt-6.1-sol');
  assert.equal(h.effort, 'high');
  assert.equal(h.sessionId, '01a144ee-22d1-7a22-bf98-d5f21be19f7e');
});

test('head 模式：无分隔线的普通日志取前 20 行；review-*-log.txt 也是日志', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--once']), 0);
  const plain = fileBody(s, 'alpha/plain-log.txt');
  assert.ok(plain.endsWith('[日志正文未上传：仅上传文件头]\n'));
  assert.ok(plain.includes('普通日志第 20 行'));
  assert.ok(!plain.includes('普通日志第 21 行'), '第 20 行之后不应上传');
  const review = fileBody(s, 'alpha/review-fix1-log.txt');
  assert.ok(review, 'review-fix1-log.txt 应上传');
  assert.ok(review.includes('返工记录'));
  assert.ok(review.endsWith('[日志正文未上传：仅上传文件头]\n'), 'review-*-log.txt 按日志处理');
});

test('sum-*.txt 不是日志：全文上传且无文件头说明行', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--once']), 0);
  const sum = fileBody(s, 'alpha/sum-a.txt');
  assert.ok(sum, 'sum-a.txt 应上传');
  assert.ok(!sum.includes('[日志正文未上传'), 'sum-*.txt 不应带日志说明行');
  assert.ok(sum.includes('汇总输出 -> ~/.codex-runs/alpha/sum-a.txt'), '主目录路径应替换：' + sum);
  assert.ok(sum.includes('用户名 <user> 单独出现、@<user> 提及都替换，' + USER + '2 不动'), '用户名单独出现应替换：' + sum);
  assert.ok(!sum.includes('/Users/' + USER));
});

test('主目录路径替换：spec 文本与 codex steps 都生效', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--once']), 0);
  const spec = fileBody(s, 'alpha/spec-a.md');
  assert.ok(spec.includes('~/proj/spec-a.md'));
  assert.ok(spec.includes('~/other'), '/home/<user> 形式也要替换');
  assert.ok(!spec.includes('/Users/' + USER));
  assert.ok(!spec.includes('/home/' + USER));
  const cx = puts(s.requests, '/ingest/v1/codex/' + MACHINE + '/').find((r) => r.url.includes('aaaa1111'));
  assert.ok(cx, 'codex 派生数据应上传');
  const j = JSON.parse(cx.body);
  assert.ok(j.steps.some((st) => (st.summary + st.detail).includes('~/todo-app/README.md')), 'steps 里主目录路径应替换');
  assert.ok(!cx.body.includes('/Users/' + USER), 'codex 载荷里不应再有主目录路径');
});

test('full 模式：日志全文上传（含 workdir 路径，主目录替换后）', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--logs', 'full', '--once']), 0);
  const body = fileBody(s, 'alpha/log1.txt');
  assert.ok(body.includes('BODY-SECRET-MARKER'), '全文应包含正文');
  assert.ok(body.includes('正文第 30 行'));
  assert.ok(!body.includes('[日志正文未上传'), 'full 模式不加说明行');
  assert.ok(body.includes('workdir: ~/code/some-project'), 'full 模式 workdir 不隐藏、但主目录要替换');
  const plain = fileBody(s, 'alpha/plain-log.txt');
  assert.ok(plain.includes('普通日志第 25 行'), '普通日志也全文');
});

test('none 模式：日志完全不上传，非日志文本照常', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  // 去掉 beta 的例外文件，纯测 none（none + .upload-logs 的组合见下一条）
  fs.rmSync(path.join(s.runsDir, 'beta', '.upload-logs'));
  const out = [];
  assert.equal(await s.call(['--logs', 'none', '--once'], { out }), 0);
  const names = puts(s.requests, '/ingest/v1/files/' + MACHINE + '/').map((r) => r.url.split('/').pop());
  for (const log of ['log1.txt', 'plain-log.txt', 'review-fix1-log.txt', 'x.log', 'log-api.txt', 'beta-log.txt']) {
    assert.ok(!names.includes(log), log + ' 不应上传');
  }
  for (const f of ['sum-a.txt', 'spec-a.md', 'spec-b.md']) {
    assert.ok(names.includes(f), f + ' 应照常上传');
  }
  assert.ok(out.some((l) => l.includes('（其中日志 0 个，仅文件头 0 个）')), '汇总行日志计数应为 0：' + out.join('|'));
});

test('.upload-logs 例外：该任务的日志按 full 处理', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--once']), 0); // 默认 head
  const beta = fileBody(s, 'beta/beta-log.txt');
  assert.ok(beta, 'beta-log.txt 应上传');
  assert.ok(beta.includes('BETA-FULL-MARKER'), '.upload-logs 任务日志应全文上传');
  assert.ok(beta.includes('beta 第 30 行'));
  assert.ok(!beta.includes('[日志正文未上传'), '不加文件头说明行');
  // 对照：alpha 的日志仍按 head
  assert.ok(fileBody(s, 'alpha/log1.txt').endsWith('[日志正文未上传：仅上传文件头]\n'));
});

test('.upload-logs 例外在 none 模式下也生效', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--logs', 'none', '--once']), 0);
  const beta = fileBody(s, 'beta/beta-log.txt');
  assert.ok(beta && beta.includes('BETA-FULL-MARKER'), 'none 模式下 .upload-logs 任务日志仍全文上传');
  assert.equal(fileBody(s, 'alpha/log1.txt'), null, 'alpha 日志仍不上传');
});

test('切换日志模式触发重传（状态哈希按处理后内容计算）', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--once']), 0);
  const first = puts(s.requests, '/ingest/v1/files/').length;
  assert.ok(first > 0);
  s.requests.length = 0;
  assert.equal(await s.call(['--once']), 0);
  assert.equal(puts(s.requests, '/ingest/v1/files/').length, 0, '模式不变不重传');
  s.requests.length = 0;
  assert.equal(await s.call(['--logs', 'full', '--once']), 0);
  const names = puts(s.requests, '/ingest/v1/files/').map((r) => r.url.split('/').pop());
  assert.ok(names.includes('log1.txt') && names.includes('plain-log.txt'), '切到 full 后日志应重传：' + names.join(','));
  assert.ok(!names.includes('sum-a.txt'), '非日志内容未变不重传');
});

test('dry-run：日志行与汇总行格式；不联网不写状态', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const out = [], err = [];
  assert.equal(await s.call(['--dry-run'], { out, err }), 0, 'err=' + err.join('|'));
  assert.equal(s.requests.length, 0, '不应有任何网络请求');
  const text = out.join('\n');
  assert.ok(text.includes('↑ alpha/log1.txt（仅文件头，脱敏 0 处）'), '日志行格式：' + text);
  assert.ok(text.includes('↑ alpha/spec-a.md（脱敏 0 处）'), '非日志行格式不变');
  assert.ok(text.includes('完成：上传 9 个文件（其中日志 6 个，仅文件头 5 个），跳过 1 个，失败 0 个，脱敏共 0 处'), '汇总行格式：' + text);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude-leading-agents', 'reporter-state.json')), '不应写状态文件');
});

test('head 模式：超过 64KB 的大日志只读头部，脱敏/主目录替换照常', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  // 1.7MB 级别的日志：大量正文 + 代码里的 token = getToken()（真实数据的主要误报源）
  const head = [
    'OpenAI Codex v0.162.0',
    '--------',
    'workdir: /Users/' + USER + '/code/some-project',
    'model: gpt-6.1-sol',
    'provider: openai',
    'approval: never',
    'sandbox: workspace-write [workdir, /tmp, $TMPDIR]',
    'reasoning effort: high',
    'reasoning summaries: none',
    'session id: 01a144ee-22d1-7a22-bf98-d5f21be19f7e',
    '--------',
  ].join('\n') + '\n';
  const body = [];
  for (let i = 0; i < 20000; i++) body.push('正文行 ' + i + '：token = getToken() 以及 /Users/' + USER + '/code/x' + i);
  const big = path.join(s.runsDir, 'alpha', 'log-big.txt');
  fs.writeFileSync(big, head + body.join('\n') + '\n');
  assert.ok(fs.statSync(big).size > 1024 * 1024, '应超过 1MB');
  const out = [], err = [];
  assert.equal(await s.call(['--once'], { out, err }), 0, 'err=' + err.join('|'));
  const b = fileBody(s, 'alpha/log-big.txt');
  assert.ok(b, '大日志应上传');
  assert.ok(b.length < 2000, '只上传文件头：' + b.length);
  assert.ok(b.includes('session id: 01a144ee-22d1-7a22-bf98-d5f21be19f7e'));
  assert.ok(b.includes('workdir: <hidden>'));
  assert.ok(!b.includes('getToken'), '正文不应上传');
  const h = parseLogHeader(b);
  assert.equal(h.codex, true);
  assert.equal(h.model, 'gpt-6.1-sol');
  assert.equal(h.sessionId, '01a144ee-22d1-7a22-bf98-d5f21be19f7e');
  // 脱敏计数：大日志的正文不再参与，误报源消失
  const line = out.find((l) => l.includes('↑ alpha/log-big.txt'));
  assert.ok(line, '应有上传行');
  assert.ok(line.includes('（仅文件头，脱敏 0 处）'), '文件头内容干净：' + line);
});

test('配置：--logs 校验、reporter.json 的 logs、命令行优先', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const base = { env: {}, home: s.home, user: USER };
  let r = loadConfig(['--dry-run', '--logs', 'bogus'], base);
  assert.ok(r.err && r.err.includes('head'), '非法值应报错：' + (r && r.err));
  // 默认 head
  r = loadConfig(['--dry-run'], base);
  assert.equal(r.logs, 'head');
  // 配置文件
  fs.writeFileSync(path.join(s.home, '.claude-leading-agents', 'reporter.json'), '{"logs":"full"}');
  r = loadConfig(['--dry-run'], base);
  assert.equal(r.logs, 'full');
  // 命令行优先
  r = loadConfig(['--dry-run', '--logs', 'none'], base);
  assert.equal(r.logs, 'none');
  // 配置文件里的非法值也报错
  fs.writeFileSync(path.join(s.home, '.claude-leading-agents', 'reporter.json'), '{"logs":"everything"}');
  r = loadConfig(['--dry-run'], base);
  assert.ok(r.err && r.err.includes('head'));
});
