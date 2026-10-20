'use strict';
// 上传范围过滤：白名单、跳过规则、读取（>2MB 取末尾 2MB、二进制/非 UTF-8 跳过）。
const fs = require('fs');

const MAX_BYTES = 2 * 1024 * 1024;
// 与 dashboard/lib/util.js 的凭证规则保持一致
const CRED_RE = /auth|credential|token\.json|\.env/i;
// 体积大或含完整对话，按约定整体跳过
const SKIP_RES = [/^cb-.*\.json$/i, /^result-.*\.json$/i, /\.err$/i, /\.patch$/i];

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

module.exports = { classify, readFileForUpload, MAX_BYTES };
