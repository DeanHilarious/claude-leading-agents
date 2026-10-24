'use strict';
// 上传范围过滤：白名单、跳过规则、读取（>2MB 取末尾 2MB、二进制/非 UTF-8 跳过）。
const fs = require('fs');

const MAX_BYTES = 2 * 1024 * 1024;
// head 模式读日志时最多读的字节数（文件头结构在前 40 行内，64KB 足够）
const HEAD_READ_BYTES = 64 * 1024;
// 与 dashboard/lib/util.js 的凭证规则保持一致
const CRED_RE = /auth|credential|token\.json|\.env/i;
// 体积大或含完整对话，按约定整体跳过
const SKIP_RES = [/^cb-.*\.json$/i, /^result-.*\.json$/i, /\.err$/i, /\.patch$/i];
// 日志文件名：log1.txt / log-api-r1.txt / review-fix1-log.txt / x.log。
// sum-*.txt、spec-*、result-* 不是日志（不匹配以下任何一条）。
const LOG_NAME_RES = [/^log[\w.\-]*\.txt$/i, /-log\.txt$/i, /\.log$/i];

function isLogName(name) {
  return LOG_NAME_RES.some((re) => re.test(name));
}

// 是否允许上传：白名单 = *.md *.txt *.jsonl *.log、START*
function classify(name) {
  if (name.startsWith('.')) return { ok: false, reason: '隐藏文件' };
  if (CRED_RE.test(name)) return { ok: false, reason: '凭证类文件名' };
  for (const re of SKIP_RES) if (re.test(name)) return { ok: false, reason: '体积大/含完整对话，约定跳过' };
  if (/^START/.test(name)) return { ok: true };
  if (/\.(md|txt|jsonl|log)$/i.test(name)) return { ok: true };
  return { ok: false, reason: '不在白名单（*.md *.txt *.jsonl *.log、START*）' };
}

// 跳过被截断的多字节字符头部（从文件中部起读时，首字节可能是续字节）
function trimPartialUtf8(buf) {
  let i = 0;
  while (i < buf.length && i < 3 && (buf[i] & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

function isUtf8(buf) {
  // 往返校验：非法序列会变成 U+FFFD，重编码后与原字节不一致
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

// 读一个待上传文件。返回 {ok, text, truncated} 或 {ok:false, reason}
function readFileForUpload(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return { ok: false, reason: '无法读取' }; }
  if (!st.isFile()) return { ok: false, reason: '不是普通文件' };
  let buf;
  const over = st.size > MAX_BYTES;
  if (over) {
    // 超过 2MB 取末尾 2MB（与服务端限制一致）
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(MAX_BYTES);
      fs.readSync(fd, buf, 0, MAX_BYTES, st.size - MAX_BYTES);
    } catch (e) { return { ok: false, reason: '读取失败' }; }
    finally { fs.closeSync(fd); }
    buf = trimPartialUtf8(buf);
  } else {
    try { buf = fs.readFileSync(filePath); } catch (e) { return { ok: false, reason: '读取失败' }; }
  }
  if (buf.length && buf.indexOf(0) >= 0) return { ok: false, reason: '二进制（含 NUL 字节）' };
  const text = buf.toString('utf8');
  if (buf.length && !isUtf8(buf)) return { ok: false, reason: '不是有效 UTF-8' };
  return { ok: true, text, truncated: over };
}

// head 模式读日志：只读文件开头的 HEAD_READ_BYTES 字节，取完整行（避免截断多字节字符）。
// 返回 {ok, text} 或 {ok:false, reason}。
function readLogHead(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return { ok: false, reason: '无法读取' }; }
  if (!st.isFile()) return { ok: false, reason: '不是普通文件' };
  let buf;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = Math.min(st.size, HEAD_READ_BYTES);
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
    } catch (e) { return { ok: false, reason: '读取失败' }; }
    finally { fs.closeSync(fd); }
  } catch (e) { return { ok: false, reason: '读取失败' }; }
  if (buf.length && buf.indexOf(0) >= 0) return { ok: false, reason: '二进制（含 NUL 字节）' };
  let end = buf.length;
  if (st.size > buf.length) {
    // 文件比缓冲长：截到最后一个换行，保证行完整（一个 64KB 的“行”不可能有日志头结构）
    const nl = buf.lastIndexOf(0x0a);
    end = nl >= 0 ? nl + 1 : 0;
  }
  const slice = buf.subarray(0, end);
  if (slice.length && !isUtf8(slice)) return { ok: false, reason: '不是有效 UTF-8' };
  return { ok: true, text: slice.toString('utf8') };
}

// Codex 日志头的分隔线（--------，8 个及以上连字符）
const SEP_LINE_RE = /^-{8,}$/;

// 从日志文本提取“文件头”：
// - 新版 Codex 日志：取到第二条 -------- 分隔线（含）为止，最多 30 行；
// - 前 40 行里没有这种结构（旧版/普通日志）：取前 20 行。
// workdir: 行的值替换为 <hidden>；末尾追加一行说明。保证 runs.parseLogHeader 仍能解析
// model / reasoning effort / session id / 是否 Codex 日志。
function extractLogHead(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let second = -1;
  let seen = 0;
  for (let i = 0; i < lines.length && i < 40; i++) {
    if (SEP_LINE_RE.test(lines[i].trim())) {
      seen++;
      if (seen === 2) { second = i; break; }
    }
  }
  let head;
  if (second >= 0) head = lines.slice(0, Math.min(second + 1, 30));
  else head = lines.slice(0, 20);
  let out = head.join('\n');
  out = out.replace(/^[ \t]*workdir:.*$/m, 'workdir: <hidden>');
  if (out && !out.endsWith('\n')) out += '\n';
  return out + '[日志正文未上传：仅上传文件头]\n';
}

module.exports = { classify, readFileForUpload, readLogHead, extractLogHead, isLogName, MAX_BYTES };
