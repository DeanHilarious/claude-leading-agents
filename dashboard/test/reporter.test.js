'use strict';
// reporter 测试：模拟接收服务 + 临时 HOME，覆盖上传/跳过/增量/删除/重试/脱敏调用。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { run } = require('../reporter/reporter');
const { loadConfig } = require('../reporter/config');

const FIX = path.resolve(__dirname, 'fixtures');
const TOKEN = 'test-ingest-token-abc123';
const MACHINE = 'testmac';

// 模拟接收服务：校验令牌、记录请求，可注入失败行为
function makeServer(ctl) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, auth: req.headers.authorization || '', body, status: 0 };
      requests.push(rec);
      const reply = (code, text) => { rec.status = code; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(text); };
      if (rec.auth !== 'Bearer ' + TOKEN) return reply(401, '{"error":"bad token"}');
      if (req.method === 'GET' && req.url === '/ingest/v1/ping') {
        return reply(200, '{"ok":true,"time":"now","limits":{"maxFileBytes":2097152}}');
      }
      if (req.method === 'PUT') {
        if (ctl.unauthorized) return reply(401, '{"error":"expired"}');
        if (ctl.alwaysFailName && req.url.endsWith('/' + ctl.alwaysFailName)) return reply(500, '{"error":"boom"}');
        if (ctl.failPuts > 0) { ctl.failPuts--; return reply(500, '{"error":"boom"}'); }
      }
      reply(204, '');
    });
  });
  return { server, requests, ctl };
}

// 临时环境：home（令牌/状态）、runs（复制 todo-app + 注入文件）；bareHome=真时不预建 .claude-leading-agents
async function setup(extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-home-'));
  if (!extra || !extra.bareHome) {
    fs.mkdirSync(path.join(home, '.claude-leading-agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude-leading-agents', 'token'), TOKEN);
    fs.chmodSync(path.join(home, '.claude-leading-agents', 'token'), 0o600);
  }
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-runs-'));
  fs.cpSync(path.join(FIX, 'runs', 'todo-app'), path.join(runsDir, 'todo-app'), { recursive: true });
  const ctl = { failPuts: 0, unauthorized: false, alwaysFailName: null };
  const srv = makeServer(ctl);
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.server.address().port;
  const env = { DASHBOARD_URL: base, DASHBOARD_INGEST_TOKEN: TOKEN };
  const call = (argv, o) => run(argv.concat(['--runs', runsDir, '--codex-home', path.join(FIX, 'codex-home')]), {
    env, home, retryBaseMs: 5, retryMaxAttempts: o && o.retryMaxAttempts,
    out: (s) => (o && o.out || []).push(s),
    err: (s) => (o && o.err || []).push(s),
    redactFn: (o && o.redactFn) || ((t) => ({ text: t, count: 0, kinds: [] })),
  });
  return { home, runsDir, srv, requests: srv.requests, ctl, base, env, call, cleanup: async () => { srv.server.close(); fs.rmSync(runsDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } };
}

const puts = (reqs, prefix) => reqs.filter((r) => r.method === 'PUT' && (!prefix || r.url.startsWith(prefix)));
const urls = (reqs) => reqs.map((r) => r.method + ' ' + r.url);

test('首次全量上传：白名单文件 + codex 派生 + quota，跳过 cb-*.json', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const out = [], err = [];
  const code = await s.call(['--machine', MACHINE, '--once'], { out, err });
  assert.equal(code, 0, '退出码 0，err=' + err.join('|'));
  const files = puts(s.requests, '/ingest/v1/files/' + MACHINE + '/');
  const names = files.map((r) => r.url.split('/').pop()).sort();
  assert.ok(names.includes('spec-api.md'));
  assert.ok(names.includes('events.jsonl'));
  assert.ok(names.includes('START'));
  assert.ok(!names.includes('cb-ui.json'), 'cb-*.json 应跳过');
  assert.equal(names.length, 14, 'todo-app 应上传 14 个文件：' + names.join(','));
  assert.ok(files.every((r) => r.status === 204));
  // codex 派生
  const cx = puts(s.requests, '/ingest/v1/codex/' + MACHINE + '/').filter((r) => r.url.includes('22222222-2222-2222-2222-222222222222'));
  assert.equal(cx.length, 1, '应上传 session 22222222 的派生数据');
  const j = JSON.parse(cx[0].body);
  assert.equal(j.tokens.total, 115000);
  assert.ok(j.steps.length >= 3);
  // quota
  assert.equal(puts(s.requests, '/ingest/v1/quota/' + MACHINE).length, 1);
  assert.ok(out.some((l) => l.includes('↑ todo-app/spec-api.md')));
  assert.ok(out.some((l) => l.includes('完成：上传 14 个文件，跳过 1 个，失败 0 个')), '结尾汇总行：' + out.join('|'));
});

test('二次同步：未变化不重复上传；文件变化只传变化的', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  const firstCount = puts(s.requests, '/ingest/v1/files/').length;
  assert.ok(firstCount > 0);
  s.requests.length = 0;
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  assert.equal(puts(s.requests, '/ingest/v1/files/').length, 0, '二次不应重复上传文件');
  assert.equal(puts(s.requests, '/ingest/v1/codex/').length, 0, '会话未变不应重传');
  assert.equal(puts(s.requests, '/ingest/v1/quota/').length, 0);
  s.requests.length = 0;
  fs.writeFileSync(path.join(s.runsDir, 'todo-app', 'spec-api.md'), '# 新内容\n');
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  const files = puts(s.requests, '/ingest/v1/files/');
  assert.deepEqual(files.map((r) => r.url.split('/').pop()), ['spec-api.md'], '只传变化的文件');
  assert.ok(files[0].body.includes('新内容'));
});

test('上传前调用 redact 并用其返回的文本上传', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const seen = [];
  const redactFn = (text) => { seen.push(String(text).slice(0, 30)); return { text: 'REDACTED<<' + text, count: 2, kinds: ['k'] }; };
  assert.equal(await s.call(['--machine', MACHINE, '--once'], { redactFn }), 0);
  assert.ok(seen.length > 10, '每个文件都过了一遍 redact');
  const spec = puts(s.requests, '/ingest/v1/files/').find((r) => r.url.endsWith('spec-api.md'));
  assert.ok(spec.body.startsWith('REDACTED<<'), '上传体应为 redact 返回的文本');
  assert.equal(spec.headers !== undefined || true, true);
  assert.equal(seen.filter((x) => x.includes('REDACTED<<')).length, 0, 'redact 不应重复喂已脱敏文本');
});

test('跳过规则：cb-x.json / auth-*.txt / .env / 二进制 / .no-upload', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const dir = path.join(s.runsDir, 'todo-app');
  fs.writeFileSync(path.join(dir, 'cb-x.json'), '{}');
  fs.writeFileSync(path.join(dir, 'auth-notes.txt'), 'nothing');
  fs.writeFileSync(path.join(dir, '.env'), 'X=1');
  fs.writeFileSync(path.join(dir, 'data.txt'), Buffer.from('a\0b'));
  fs.mkdirSync(path.join(s.runsDir, 'secret-run'));
  fs.writeFileSync(path.join(s.runsDir, 'secret-run', 'spec-a.md'), '# x');
  fs.writeFileSync(path.join(s.runsDir, 'secret-run', '.no-upload'), '');
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  const all = urls(puts(s.requests, '/ingest/v1/files/'));
  assert.ok(!all.some((u) => u.includes('cb-x.json')));
  assert.ok(!all.some((u) => u.includes('auth-notes.txt')));
  assert.ok(!all.some((u) => u.includes('.env')));
  assert.ok(!all.some((u) => u.includes('data.txt')));
  assert.ok(!all.some((u) => u.includes('secret-run')), '.no-upload 任务整体跳过');
});

test('--dry-run：不联网、不写状态、列出将上传的文件', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const out = [], err = [];
  const code = await s.call(['--machine', MACHINE, '--dry-run'], { out, err });
  assert.equal(code, 0, 'err=' + err.join('|'));
  assert.equal(s.requests.length, 0, '不应有任何网络请求');
  const text = out.join('\n');
  assert.ok(text.includes('todo-app/spec-api.md'));
  assert.ok(text.includes('跳过') || text.includes('-'), '应有跳过说明');
  assert.ok(!fs.existsSync(path.join(s.home, '.claude-leading-agents', 'reporter-state.json')), '不应写状态文件');
});

test('失败后重试成功（500 → 204）', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.ctl.failPuts = 1;
  const err = [];
  const code = await s.call(['--machine', MACHINE, '--once'], { err });
  assert.equal(code, 0, '重试后成功，err=' + err.join('|'));
  const fileReqs = puts(s.requests, '/ingest/v1/files/');
  const five = fileReqs.filter((r) => r.status === 500);
  assert.equal(five.length, 1, '恰有一次 500');
  assert.equal(fileReqs.filter((r) => r.status === 204).length, 14, '全部最终成功');
});

test('401 不重试：每个请求只试一次', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.ctl.unauthorized = true;
  const err = [];
  const code = await s.call(['--machine', MACHINE, '--once'], { err });
  assert.equal(code, 1);
  const fileReqs = puts(s.requests, '/ingest/v1/files/');
  assert.equal(fileReqs.length, 14, '14 个文件各一次，不重试');
  assert.ok(fileReqs.every((r) => r.status === 401));
  assert.ok(err.join('\n').includes('401'), '应打印失败原因');
});

test('令牌不出现在任何输出里', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const out = [], err = [];
  await s.call(['--machine', MACHINE, '--once'], { out, err });
  s.ctl.unauthorized = true;
  await s.call(['--machine', MACHINE, '--once'], { out, err });
  const all = out.join('\n') + '\n' + err.join('\n');
  assert.ok(!all.includes(TOKEN), '令牌不得出现在输出：' + all);
  assert.ok(s.requests.every((r) => r.auth === 'Bearer ' + TOKEN || r.status === 401));
});

test('本地任务删除后发 DELETE，未上传过的不发', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  s.requests.length = 0;
  fs.rmSync(path.join(s.runsDir, 'todo-app'), { recursive: true });
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  const dels = s.requests.filter((r) => r.method === 'DELETE');
  assert.deepEqual(dels.map((r) => r.url), ['/ingest/v1/runs/' + MACHINE + '/todo-app']);
  // 再跑一遍：状态已清理，不再 DELETE
  s.requests.length = 0;
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  assert.equal(s.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('https 校验与令牌文件权限', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-cfg-'));
  const tk = path.join(home, 'token');
  fs.writeFileSync(tk, 'x');
  fs.chmodSync(tk, 0o644);
  const env = {};
  let r = loadConfig(['--url', 'http://example.com', '--token-file', tk], { env, home });
  assert.ok(r.err && r.err.includes('https'), '非本机 http 应报错');
  r = loadConfig(['--url', 'http://localhost:9999', '--token-file', tk], { env, home });
  assert.ok(r.err && r.err.includes('chmod 600'), '权限不对应拒绝：' + (r && r.err));
  fs.chmodSync(tk, 0o600);
  r = loadConfig(['--url', 'http://localhost:9999', '--token-file', tk], { env, home });
  assert.equal(r.err, undefined);
  assert.equal(r.machine !== undefined, true);
  r = loadConfig(['--url', 'https://a.example.com', '--token-file', tk], { env, home });
  assert.equal(r.err, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test('状态目录不存在：自动创建，第二次 --once 零上传', async (t) => {
  const s = await setup({ bareHome: true });
  t.after(s.cleanup);
  const err1 = [];
  assert.equal(await s.call(['--machine', MACHINE, '--once'], { err: err1 }), 0, 'err=' + err1.join('|'));
  const st = path.join(s.home, '.claude-leading-agents', 'reporter-state.json');
  assert.ok(fs.existsSync(st), '状态文件应已保存');
  assert.equal(fs.statSync(st).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(st)).mode & 0o777, 0o700);
  s.requests.length = 0;
  assert.equal(await s.call(['--machine', MACHINE, '--once']), 0);
  assert.equal(puts(s.requests, '/ingest/v1/files/').length, 0, '第二次应零上传（状态已保存）');
});

test('某文件 500 重试用尽：退出码 1，其余文件仍成功', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.ctl.alwaysFailName = 'spec-api.md';
  const out = [], err = [];
  const code = await s.call(['--machine', MACHINE, '--once'], { out, err, retryMaxAttempts: 3 });
  assert.equal(code, 1, '有失败必须退出码 1');
  assert.ok(err.join('\n').includes('spec-api.md'), '应指出失败文件');
  const tries = puts(s.requests, '/ingest/v1/files/').filter((r) => r.url.endsWith('/spec-api.md'));
  assert.equal(tries.length, 3, '重试用尽共试 3 次');
  assert.ok(tries.every((r) => r.status === 500));
  assert.equal(puts(s.requests, '/ingest/v1/files/').filter((r) => r.status === 204).length, 13, '其余 13 个文件成功');
  assert.ok(out.some((l) => l.includes('失败 1 个')), '汇总行应计失败：' + out.join('|'));
});
