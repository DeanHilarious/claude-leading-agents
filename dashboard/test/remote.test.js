'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { createApp } = require('../server');

const PASSWORD = 'view-pass-123456';
const TOKEN = 'ingest-token-abcdefgh1234567890';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-dash-'));
const dataDir = path.join(tmp, 'data');

let app;
let port;
let cookie = '';

function req(method, p, opt) {
  opt = opt || {};
  return new Promise((resolve, reject) => {
    const body = opt.body == null ? null : Buffer.from(opt.body, 'utf8');
    const headers = Object.assign({ Host: '127.0.0.1:' + port }, opt.headers || {});
    if (body) headers['content-length'] = body.length;
    if (cookie) headers.cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const put = (p, body, headers) => req('PUT', p, { body, headers: Object.assign({ authorization: 'Bearer ' + TOKEN }, headers) });
const get = (p, headers) => req('GET', p, { headers });
const json = (r) => JSON.parse(r.body);

test.before(async () => {
  app = createApp({ data: dataDir, password: PASSWORD, token: TOKEN, secret: 'unit-test-secret' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
});

test.after(() => { app.server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

test('未登录：页面 302、API 401、healthz/login 开放', async () => {
  const page = await get('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  const api = await get('/api/overview');
  assert.equal(api.status, 401);
  assert.equal(json(api).error, 'unauthorized');
  const hz = await get('/healthz');
  assert.equal(hz.status, 200);
  assert.deepEqual(json(hz), { ok: true });
  const login = await get('/login');
  assert.equal(login.status, 200);
  assert.ok(login.body.includes('进入指挥台'));
});

test('登录：成功/失败、cookie 属性、登出', async () => {
  const bad = await req('POST', '/login', { body: JSON.stringify({ password: 'wrong' }), headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' } });
  assert.equal(bad.status, 401);
  assert.ok(bad.body.includes('密码'));
  const ok = await req('POST', '/login', { body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.2' } });
  assert.equal(ok.status, 200);
  const sc = ok.headers['set-cookie'][0];
  assert.ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=604800/.test(sc) && /Path=\//.test(sc), sc);
  assert.ok(!/Secure/.test(sc), '非 HTTPS 不应加 Secure');
  cookie = sc.split(';')[0];
  const ov = await get('/api/overview');
  assert.equal(ov.status, 200);
  // HTTPS 下加 Secure
  const sec = await req('POST', '/login', { body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.1.1.3' } });
  assert.ok(/Secure/.test(sec.headers['set-cookie'][0]));
  // 登出
  const saved = cookie;
  cookie = saved;
  const out = await req('POST', '/logout');
  assert.equal(out.status, 302);
  assert.ok(/Max-Age=0/.test(out.headers['set-cookie'][0]));
  cookie = saved; // 恢复，登出不清服务器态（无状态会话），后续测试继续用
});

test('cookie 篡改被拒', async () => {
  const saved = cookie;
  const [payload, mac] = saved.split('.');
  cookie = payload + '.' + Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex').toString('base64url');
  const r = await get('/api/overview');
  assert.equal(r.status, 401);
  cookie = payload + 'x.' + mac;
  const r2 = await get('/api/overview');
  assert.equal(r2.status, 401);
  cookie = saved;
});

test('令牌：错的 401，对的能 ping', async () => {
  const no = await req('GET', '/ingest/v1/ping');
  assert.equal(no.status, 401);
  const bad = await req('GET', '/ingest/v1/ping', { headers: { authorization: 'Bearer wrong-token-1234567890abc' } });
  assert.equal(bad.status, 401);
  const ok = await req('GET', '/ingest/v1/ping', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert.equal(ok.status, 200);
  assert.equal(json(ok).ok, true);
  assert.equal(json(ok).limits.maxFileBytes, 2097152);
});

test('非法名称 400：..、.env、敏感名、超长、路径穿越', async () => {
  const r1 = await put('/ingest/v1/files/m1/r1/..', 'x');
  assert.equal(r1.status, 400);
  const r2 = await put('/ingest/v1/files/m1/r1/.env', 'x');
  assert.equal(r2.status, 400);
  const r3 = await put('/ingest/v1/files/m1/r1/auth.json', 'x');
  assert.equal(r3.status, 400);
  const r4 = await put('/ingest/v1/files/m1/r1/token.json', 'x');
  assert.equal(r4.status, 400);
  const long = 'a'.repeat(101);
  const r5 = await put('/ingest/v1/files/m1/' + long + '/f.txt', 'x');
  assert.equal(r5.status, 400);
  // 编码后的路径穿越
  const r6 = await put('/ingest/v1/files/m1/r1/..%2F..%2F..%2Fescape.txt', 'x');
  assert.equal(r6.status, 400);
  const r7 = await put('/ingest/v1/files/%2e%2e/r1/f.txt', 'x');
  assert.equal(r7.status, 400);
});

test('超大请求 413', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 100);
  let r;
  try {
    r = await put('/ingest/v1/files/m1/big/f.txt', big);
  } catch (e) {
    // 服务端返回 413 后立即断开连接，客户端可能先遇到 EPIPE —— 也算通过
    assert.ok(e.code === 'EPIPE' || e.code === 'ECONNRESET', '意外的错误：' + e.code);
    return;
  }
  assert.equal(r.status, 413);
});

test('写入后 overview 能看到任务，machine 字段正确', async () => {
  const mt = '2026-10-20T10:00:00+08:00';
  const r1 = await put('/ingest/v1/files/box1/spec-a/files/spec-a.md', '# 实现 A\n做点什么');
  assert.equal(r1.status, 400, '目录数不匹配应 400');
  const spec = await put('/ingest/v1/files/box1/spec-a/spec-a.md', '# 实现 A\n做点什么', { 'x-mtime': mt });
  assert.equal(spec.status, 204);
  const ev = await put('/ingest/v1/files/box1/spec-a/events.jsonl',
    '{"t":"2026-10-20T10:00:00+08:00","sub":"a","event":"dispatched","agent":"codex","model":"gpt-5","round":1}\n' +
    '{"t":"2026-10-20T10:30:00+08:00","sub":"a","event":"accepted","round":1}\n', { 'x-mtime': mt });
  assert.equal(ev.status, 204);
  const sum = await put('/ingest/v1/files/box1/spec-a/sum-a.txt', 'exit=0', { 'x-mtime': mt });
  assert.equal(sum.status, 204);
  const ov = await get('/api/overview');
  const run = json(ov).runs.find((r) => r.id === 'spec-a');
  assert.ok(run, 'overview 应包含 spec-a');
  assert.equal(run.machine, 'box1');
  assert.equal(run.subtaskCount, 1);
  const detail = json(await get('/api/runs/spec-a'));
  assert.equal(detail.machine, 'box1');
  const st = fs.statSync(path.join(dataDir, 'box1', 'runs', 'spec-a', 'spec-a.md'));
  assert.equal(new Date(st.mtimeMs).toISOString(), new Date(mt).toISOString(), 'X-Mtime 应生效');
});

test('同名任务多机器：key 变为 run@machine', async () => {
  const r = await put('/ingest/v1/files/box2/spec-a/spec-a.md', '# 另一台机器的 A');
  assert.equal(r.status, 204);
  const ov = json(await get('/api/overview'));
  const ids = ov.runs.map((x) => x.id).sort();
  assert.deepEqual(ids, ['spec-a@box1', 'spec-a@box2']);
  const d = json(await get('/api/runs/spec-a@box2'));
  assert.equal(d.machine, 'box2');
});

test('PUT codex 派生数据后 token 出现、feed 有 steps', async () => {
  const log = 'OpenAI Codex v1\nmodel: gpt-5\nreasoning effort: medium\nsession id: ' + SESSION_ID + '\ncodexAvailable: true\n';
  const r1 = await put('/ingest/v1/files/box1/spec-a/log-a.txt', log);
  assert.equal(r1.status, 204);
  const r2 = await put('/ingest/v1/codex/box1/' + SESSION_ID, JSON.stringify({
    tokens: { input: 1000, cached: 200, output: 300, total: 1300 },
    steps: [{ t: '2026-10-20T10:05:00Z', kind: 'exec', summary: 'ls -la', detail: 'ls -la' }],
  }));
  assert.equal(r2.status, 204);
  const d = json(await get('/api/runs/spec-a@box1'));
  assert.equal(d.tokensDetail.total, 1300);
  const feed = json(await get('/api/runs/spec-a@box1/subtasks/a/feed'));
  assert.equal(feed.agent, 'codex');
  assert.equal(feed.steps.length, 1);
  assert.equal(feed.steps[0].summary, 'ls -la');
});

test('PUT quota 后 overview 出现额度', async () => {
  const r = await put('/ingest/v1/quota/box1', JSON.stringify({ plan: 'pro', primary: { usedPercent: 42, windowMinutes: 10080, resetsAt: null }, secondary: null }));
  assert.equal(r.status, 204);
  const ov = json(await get('/api/overview'));
  assert.equal(ov.quota.plan, 'pro');
  assert.equal(ov.quota.primary.usedPercent, 42);
});

test('脱敏生效：写入的密钥读不回原文', async () => {
  const r = await put('/ingest/v1/files/box1/leaky/spec-b.md', '# B\n密钥 sk-ant-api03ABCDEFGHIJKLMNOPQRSTUVWXYZ 结束');
  assert.equal(r.status, 204);
  const f = await get('/api/runs/leaky/file?name=spec-b.md');
  assert.equal(f.status, 200);
  assert.ok(!f.body.includes('sk-ant-api03ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '不应包含原文');
  assert.ok(f.body.includes('[REDACTED:api-key]'));
  const onDisk = fs.readFileSync(path.join(dataDir, 'box1', 'runs', 'leaky', 'spec-b.md'), 'utf8');
  assert.ok(!onDisk.includes('sk-ant-api03'), '落盘也应已脱敏');
});

test('响应安全头', async () => {
  const r = await get('/');
  assert.equal(r.status, 200); // 已登录
  assert.equal(r.headers['content-security-policy'], "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['strict-transport-security'], undefined, '非 HTTPS 无 HSTS');
  const h = await get('/', { 'x-forwarded-proto': 'https' });
  assert.ok(/^max-age=/.test(h.headers['strict-transport-security']));
});

test('Host 校验：allowed-host 之外的域名 403，带端口也可', async () => {
  const bad = await req('GET', '/healthz', { headers: { Host: 'evil.example.com' } });
  assert.equal(bad.status, 403);
});

test('DELETE 任务后 overview 不再显示', async () => {
  const r = await req('DELETE', '/ingest/v1/runs/box1/leaky', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert.equal(r.status, 204);
  const ov = json(await get('/api/overview'));
  assert.ok(!ov.runs.some((x) => x.id.startsWith('spec-b') || x.id === 'leaky'), '已删任务不应出现');
  assert.ok(!fs.existsSync(path.join(dataDir, 'box1', 'runs', 'leaky')));
});

test('登录限流：同 IP 连续失败后 429', async () => {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' };
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await req('POST', '/login', { body: JSON.stringify({ password: 'wrong' }), headers: h });
    last = r.status;
    if (r.status === 429) break;
  }
  assert.equal(last, 429);
  // 正确密码也被挡（限流先于校验）
  const blocked = await req('POST', '/login', { body: JSON.stringify({ password: PASSWORD }), headers: h });
  assert.equal(blocked.status, 429);
});

test('并发竞态：同时 PUT 时 X-Mtime 各归各（循环 50 次）', async () => {
  const t1 = '2026-01-01T00:00:00.000Z';
  const t2 = '2026-06-06T12:00:00.000Z';
  for (let i = 0; i < 50; i++) {
    const [r1, r2] = await Promise.all([
      put('/ingest/v1/files/box1/race/f1.txt', 'one-' + i, { 'x-mtime': t1 }),
      put('/ingest/v1/files/box1/race/f2.txt', 'two-' + i, { 'x-mtime': t2 }),
    ]);
    assert.equal(r1.status, 204);
    assert.equal(r2.status, 204);
    const m1 = fs.statSync(path.join(dataDir, 'box1', 'runs', 'race', 'f1.txt')).mtimeMs;
    const m2 = fs.statSync(path.join(dataDir, 'box1', 'runs', 'race', 'f2.txt')).mtimeMs;
    assert.equal(new Date(m1).toISOString(), t1, '第 ' + i + ' 轮 f1 的 mtime 应来自自己的请求头');
    assert.equal(new Date(m2).toISOString(), t2, '第 ' + i + ' 轮 f2 的 mtime 应来自自己的请求头');
  }
});

test('令牌暴力破解限流：同 IP 失败超 20 次后全部 429', async () => {
  const h = { 'x-forwarded-for': '10.7.7.7', authorization: 'Bearer wrong-token-000000000000' };
  for (let i = 0; i < 21; i++) {
    const r = await req('GET', '/ingest/v1/ping', { headers: h });
    assert.equal(r.status, 401, '前 21 次失败应 401');
  }
  // 令牌正确也被挡（限流先于校验）
  const blocked = await req('GET', '/ingest/v1/ping', { headers: { 'x-forwarded-for': '10.7.7.7', authorization: 'Bearer ' + TOKEN } });
  assert.equal(blocked.status, 429);
  // 换个 IP 不受影响
  const other = await req('GET', '/ingest/v1/ping', { headers: { 'x-forwarded-for': '10.8.8.8', authorization: 'Bearer ' + TOKEN } });
  assert.equal(other.status, 200);
});

test('远程模式不泄露服务器路径：dir 为逻辑标签，remote 标记为 true', async () => {
  const ov = json(await get('/api/overview'));
  assert.equal(ov.remote, true);
  const detail = json(await get('/api/runs/spec-a@box1'));
  assert.equal(detail.dir, 'box1:~/.codex-runs/spec-a');
  // 深度遍历：任何接口响应里都不得出现 DATA 目录的绝对路径
  const walk = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  for (const payload of [ov, detail]) {
    assert.ok(!walk(payload).includes(dataDir), '响应不得包含 DATA 绝对路径');
    assert.ok(!walk(payload).includes(tmp), '响应不得包含临时目录路径');
  }
});

test('507 磁盘配额：超出 cfg.maxBytes 拒绝写入', async () => {
  const tinyDir = path.join(tmp, 'tiny-data');
  const tiny = createApp({ data: tinyDir, password: PASSWORD, token: TOKEN, secret: 'unit-test-secret', maxBytes: 500 });
  await new Promise((r) => tiny.server.listen(0, '127.0.0.1', r));
  const p2 = tiny.server.address().port;
  const putTiny = (p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p2, path: p, method: 'PUT', headers: { Host: '127.0.0.1:' + p2, authorization: 'Bearer ' + TOKEN, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(body);
  });
  const ok = await putTiny('/ingest/v1/files/m1/r1/a.txt', 'x'.repeat(100));
  assert.equal(ok.status, 204);
  const over = await putTiny('/ingest/v1/files/m1/r1/b.txt', 'y'.repeat(600));
  assert.equal(over.status, 507);
  // 配额内覆盖写旧文件仍然允许（扣减旧文件大小）
  const repl = await putTiny('/ingest/v1/files/m1/r1/a.txt', 'z'.repeat(450));
  assert.equal(repl.status, 204);
  tiny.server.close();
});

test('启动校验：远程模式缺密码/令牌或令牌过短时拒绝启动', () => {
  const { execFileSync } = require('node:child_process');
  const serverJs = path.resolve(__dirname, '..', 'server.js');
  const cases = [
    [{}, '缺 DASHBOARD_PASSWORD'],
    [{ DASHBOARD_PASSWORD: 'p' }, '缺令牌'],
    [{ DASHBOARD_PASSWORD: 'p', DASHBOARD_INGEST_TOKEN: 'short-token' }, '令牌过短'],
  ];
  for (const [env, name] of cases) {
    let err = null;
    try {
      execFileSync(process.execPath, [serverJs, '--data', path.join(tmp, 'no-start'), '--port', '0'], {
        env: Object.assign({}, process.env, env), stdio: 'pipe', timeout: 5000,
      });
    } catch (e) { err = e; }
    assert.ok(err, name + ' 应拒绝启动');
    assert.equal(err.status, 1);
    assert.ok(String(err.stderr).includes('DASHBOARD'), name + ' 应给出中文提示：' + err.stderr);
  }
  // --data 与 --demo 互斥
  let err2 = null;
  try {
    execFileSync(process.execPath, [serverJs, '--data', path.join(tmp, 'no-start'), '--demo'], {
      env: Object.assign({}, process.env, { DASHBOARD_PASSWORD: 'p', DASHBOARD_INGEST_TOKEN: TOKEN }), stdio: 'pipe', timeout: 5000,
    });
  } catch (e) { err2 = e; }
  assert.ok(err2, '--data 与 --demo 互斥');
  assert.equal(err2.status, 1);
});

test('本地模式不受影响（无 --data 时无需登录）', async () => {
  const FIX = path.resolve(__dirname, 'fixtures');
  const local = createApp({ demo: true, runs: path.join(FIX, 'runs'), codexHome: path.join(FIX, 'codex-home') });
  await new Promise((r) => local.server.listen(0, '127.0.0.1', r));
  const p = local.server.address().port;
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: p, path: '/api/overview', headers: { Host: '127.0.0.1:' + p } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  local.server.close();
  assert.equal(body.status, 200, '本地模式 /api/overview 不应要求登录');
  const j = JSON.parse(body.body);
  assert.equal(j.runs.length, 3);
  assert.equal(j.runs[0].machine, null);
  assert.equal(j.remote, false, '本地模式 remote 应为 false');
});
