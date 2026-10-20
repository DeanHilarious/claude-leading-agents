'use strict';
// 敏感内容脱敏。纯函数、线性时间（无灾难性回溯）、幂等：redact(redact(x)) === redact(x)。
// 顺序：私钥块 → URL 内嵌凭证 → JWT → Bearer → 字面量密钥 → 键名赋值。

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_CRED_RE = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'/:@]+):([^\s"'/@]+)@/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
// 各字面量密钥；lookbehind 排除更长单词的一部分（如 task-management 里的 sk-）
const LITERAL_RULES = [
  { re: /(?<![A-Za-z0-9_-])sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, kind: 'api-key' },
  { re: /(?<![A-Za-z0-9])(?:ghp|gho|ghs)_[A-Za-z0-9]{16,}/g, kind: 'api-key' },
  { re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, kind: 'api-key' },
  { re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g, kind: 'api-key' },
  { re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g, kind: 'api-key' },
  { re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/g, kind: 'api-key' },
  { re: /(?<![A-Za-z0-9])LTAI[A-Za-z0-9]{12,}/g, kind: 'api-key' },      // 阿里云 AccessKey ID
  { re: /(?<![A-Za-z0-9])AKLT[A-Za-z0-9_-]{16,}/g, kind: 'api-key' },    // 火山引擎
  { re: /(?<![A-Za-z0-9])AKID[A-Za-z0-9]{16,}/g, kind: 'api-key' },      // 腾讯云
];
// 命令行参数里的口令：--password x / --password=x / -passwd x 等。
// 参数名必须以敏感词结尾且后跟 = 或空白（--password-file / --token-limit 不算）。
const CLI_RE = /(^|\s)(-{1,2})([\w-]*?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key))(?:(=)([^\s]*)|(\s)([^\s]*))/g;
// 键名赋值：KEY=value / KEY: value / "KEY": "value" / export KEY=value
const ASSIGN_RE = /(^|[\s;,{])(export\s+)?("?)([A-Za-z_][A-Za-z0-9_.-]*)\3(\s*)([:=])(\s*)("([^"\n]*)"|'([^'\n]*)'|([^\s;&,}"']+))/g;
const KEY_WORD_RE = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)/i;

// 值为空 / *** / <占位符> / $VAR 引用 / 已脱敏结果时不替换（保证幂等）
function isPlaceholder(v) {
  return v === '' || /^\*+$/.test(v) || /^<[^>]*>$/.test(v) || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v) || /^\[REDACTED:[a-z-]+\]$/.test(v);
}

function redact(text) {
  const kinds = new Set();
  let count = 0;
  const bump = (k) => { count++; kinds.add(k); };
  let out = String(text == null ? '' : text);
  out = out.replace(PRIVATE_KEY_RE, () => { bump('private-key'); return '[REDACTED:private-key]'; });
  out = out.replace(URL_CRED_RE, (m, head, pass) => {
    if (/^\[REDACTED:[a-z-]+\]$/.test(pass)) return m;
    bump('url-credential');
    return head + ':[REDACTED:url-credential]@';
  });
  out = out.replace(JWT_RE, () => { bump('jwt'); return '[REDACTED:jwt]'; });
  out = out.replace(BEARER_RE, () => { bump('bearer'); return 'Bearer [REDACTED:bearer]'; });
  for (const r of LITERAL_RULES) {
    out = out.replace(r.re, () => { bump(r.kind); return '[REDACTED:' + r.kind + ']'; });
  }
  out = out.replace(CLI_RE, (m, pre, dashes, name, eq, v1, sp, v2) => {
    const v = eq != null ? v1 : v2;
    // 值为空 / 以 - $ < 开头（像是另一个参数、变量引用、占位符）/ 已脱敏时不替换
    if (v === '' || /^[-$<]/.test(v) || v.indexOf('[REDACTED') === 0) return m;
    bump('secret');
    return pre + dashes + name + (eq != null ? '=' + '[REDACTED:secret]' : ' ' + '[REDACTED:secret]');
  });
  out = out.replace(ASSIGN_RE, (m, pre, exp, q, key, ws1, op, ws2, val, dq, sq, bare) => {
    if (!KEY_WORD_RE.test(key)) return m;
    const v = dq != null ? dq : (sq != null ? sq : bare);
    if (v == null || isPlaceholder(v)) return m;
    bump('secret');
    const rep = dq != null ? '"[REDACTED:secret]"' : (sq != null ? "'[REDACTED:secret]'" : '[REDACTED:secret]');
    return pre + (exp || '') + q + key + q + ws1 + op + ws2 + rep;
  });
  return { text: out, count, kinds: [...kinds].sort() };
}

module.exports = { redact };
