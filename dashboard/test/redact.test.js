'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redact } = require('../lib/redact');

function hit(text, kind, notInclude) {
  const r = redact(text);
  assert.ok(r.count >= 1, '应至少命中 1 处：' + text);
  assert.ok(r.kinds.includes(kind), '应包含 kind=' + kind + '，实际 ' + r.kinds);
  if (notInclude) for (const s of notInclude) assert.ok(!r.text.includes(s), '不应保留原文：' + s);
  return r;
}

function miss(text) {
  const r = redact(text);
  assert.equal(r.count, 0, '不应命中：' + text + ' → ' + r.text);
  assert.equal(r.text, text);
}

test('字面量密钥：sk / sk-ant / github / AKIA / slack / google', () => {
  hit('key = sk-proj-AbCdEf1234567890GhIjKl', 'api-key', ['sk-proj-AbCdEf1234567890GhIjKl']);
  hit('sk-ant-api03ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'api-key', ['sk-ant-api03']);
  hit('ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'api-key', ['ghp_16C7e42F292c6912E7710c838347Ae178B4a']);
  hit('github_pat_11AABBCCDD0123456789_abcdefghijklmnopqrstuvwxyz', 'api-key', ['github_pat_11AABBCCDD']);
  hit('aws key AKIAIOSFODNN7EXAMPLE', 'api-key', ['AKIAIOSFODNN7EXAMPLE']);
  const slack = 'xoxb-' + '123456789012-1234567890123-abcdefghijklmnopqrstuvwx'; // 拼接：避免源码里出现完整令牌字面量（会触发 GitHub 推送保护）
  hit(slack, 'api-key', [slack]);
  hit('google AIzaSyA1234567890abcdefghijklmnopqrstuvw', 'api-key', ['AIzaSyA1234567890']);
});

test('私钥整块替换', () => {
  hit('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7abcdefghijklmnop\n-----END RSA PRIVATE KEY-----\nrest', 'private-key', ['MIIEpAIBAAKCAQEA7']);
});

test('JWT', () => {
  hit('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c', 'jwt', ['eyJhbGciOiJIUzI1NiJ9']);
});

test('Bearer 长串', () => {
  hit('Authorization: Bearer abcdef1234567890ABCDEF1234567890', 'bearer', ['abcdef1234567890ABCDEF1234567890']);
});

test('键名赋值四种形态（只替换值）', () => {
  assert.equal(redact('DB_PASSWORD=hunter2secret').text, 'DB_PASSWORD=[REDACTED:secret]');
  assert.equal(redact('password: opensesame').text, 'password: [REDACTED:secret]');
  assert.equal(redact('"api_key": "abcd1234efgh5678"').text, '"api_key": "[REDACTED:secret]"');
  assert.equal(redact('export MY_TOKEN=xyz123abc456').text, 'export MY_TOKEN=[REDACTED:secret]');
  assert.ok(redact('db_password=hunter2secret').kinds.includes('secret'));
});

test('URL 内嵌凭证只替换密码段', () => {
  const r = hit('postgres://alice:S3cretPw@db.example.com/prod', 'url-credential', ['S3cretPw']);
  assert.ok(r.text.includes('alice:[REDACTED:url-credential]@db.example.com'), r.text);
  assert.ok(r.text.includes('postgres://'));
});

test('不应命中：占位符、引用、邮箱、手机号、普通文本', () => {
  miss('PASSWORD=***');
  miss('token=$GITHUB_TOKEN');
  miss('password=${DB_PASS}');
  miss('password=<enter-here>');
  miss('user: bob@example.com');
  miss('电话 13812345678');
  miss('MAX_RETRIES=3 port=8080 host=localhost');
  miss('see https://example.com/no creds here');
  miss('task-management and risk-avoidance');
});

test('云厂商 AccessKey ID：阿里 / 火山 / 腾讯', () => {
  hit('aliyun LTAI5tGxAbCdEfGhIjKlMn', 'api-key', ['LTAI5tGxAbCdEfGhIjKlMn']);
  hit('volc AKLT1234abcd5678_WXYZ-90', 'api-key', ['AKLT1234abcd5678_WXYZ-90']);
  hit('tencent AKIDAbCdEf1234567890GhIj', 'api-key', ['AKIDAbCdEf1234567890GhIj']);
  miss('LTAIabc AKLT1234 AKIDabc');            // 长度不够
  miss('xLTAI5tGxAbCdEfGhIjKlMn');             // 前面是字母，是更长单词的一部分
});

test('命令行参数口令：空格与等号两种形态', () => {
  assert.equal(redact('run --password hunter2 --verbose').text, 'run --password [REDACTED:secret] --verbose');
  assert.equal(redact('--password=hunter2').text, '--password=[REDACTED:secret]');
  assert.equal(redact('--token abc123 next').text, '--token [REDACTED:secret] next');
  assert.equal(redact('--secret xyz789').text, '--secret [REDACTED:secret]');
  assert.equal(redact('--api-key k123456').text, '--api-key [REDACTED:secret]');
  assert.equal(redact('-passwd pw123456').text, '-passwd [REDACTED:secret]');
  assert.equal(redact('--access-key ak123456').text, '--access-key [REDACTED:secret]');
  assert.equal(redact('--my-password=qwertyuiop').text, '--my-password=[REDACTED:secret]');
  assert.ok(redact('--token abc123').kinds.includes('secret'));
});

test('命令行参数不误伤：后缀词、引用、占位符', () => {
  miss('--password-file /etc/secret.txt');
  miss('--token-limit 100');
  miss('--secret-name foo');
  miss('--password -p');          // 值像另一个参数
  miss('--token $TOK');           // 变量引用
  miss('--password <ask>');       // 占位符
  miss('--tokens 5');             // 不是以敏感词结尾
});

test('幂等：重复脱敏不变', () => {
  const sample = [
    'sk-ant-api03ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nbbb321\n-----END OPENSSH PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Bearer Zz9876543210abcdefABCDEF',
    'DB_PASSWORD=hunter2secret',
    'postgres://alice:S3cretPw@db.example.com/prod',
    'AKIAIOSFODNN7EXAMPLE',
    '--password hunter2 --token abc123',
    'LTAI5tGxAbCdEfGhIjKlMn',
  ].join('\n');
  const once = redact(sample);
  const twice = redact(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.count, 0, '二次脱敏不应再命中');
  assert.deepEqual(twice.kinds, []);
});

test('性能：2MB 文本 <200ms', () => {
  const sample = [
    '# 报告',
    'db_password=hunter2secret',
    'Bearer aaaa1111bbbb2222cccc3333',
    'sk-ant-api03ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'postgres://alice:S3cretPw@db.example.com/prod',
    '普通中文内容，手机号 13912345678，邮箱 a@b.com。',
  ].join('\n');
  const big = sample.repeat(Math.ceil((2 * 1024 * 1024) / sample.length));
  assert.ok(big.length > 2 * 1024 * 1024 - 1024);
  const t0 = Date.now();
  const r = redact(big);
  const ms = Date.now() - t0;
  assert.ok(r.count > 1000);
  assert.ok(ms < 200, '2MB 脱敏耗时 ' + ms + 'ms，应 <200ms');
});

test('redactHomePaths：names 名单原样替换成 <name>，幂等', () => {
  const { redactHomePaths } = require('../lib/redact');
  const o = { home: '/Users/fakeuser', user: 'fakeuser', names: ['张三', 'Zhang San', 'x'] };
  const a = redactHomePaths('提到张三和Zhang San；x 太短不处理', o);
  assert.equal(a, '提到<name>和<name>；x 太短不处理');
  assert.equal(redactHomePaths(a, o), a);
});
