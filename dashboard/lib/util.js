'use strict';
// 通用小工具：全部为纯函数，便于测试。

const CRED_RE = /auth|credential|token\.json|\.env/i;

function isCredentialName(name) {
  return CRED_RE.test(name);
}

// 安全文件名：必须匹配 ^[\w.\-]+$
function isSafeFileName(name) {
  return /^[\w.\-]+$/.test(name);
}

// 截断字符串，超出部分加省略号
function truncate(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

// 解析 START 文件内容的时间：本地时间 "2026-10-16T21:29"
// offsetMin 不为空时按该时区偏移解释，保证 demo/测试确定。
function parseStartLocal(str, offsetMin) {
  if (!str) return null;
  const s = String(str).trim();
  if (/[+-]\d{2}:\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  let iso = m[0];
  if (offsetMin != null) {
    const sign = offsetMin < 0 ? '-' : '+';
    const abs = Math.abs(offsetMin);
    iso += sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// 从 ISO 字符串里取时区偏移分钟数（如 +08:00 → 480），取不到返回 null
function offsetMinutesOf(iso) {
  if (typeof iso !== 'string') return null;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}

// ms → ISO 字符串（带本地时区偏移，用 now 的偏移保证 demo 确定）
function toIso(ms, offsetMin) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (offsetMin != null) {
    const sign = offsetMin < 0 ? '-' : '+';
    const abs = Math.abs(offsetMin);
    const shifted = ms + offsetMin * 60000;
    const d = new Date(shifted);
    const p = (x) => String(x).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) +
      sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
  }
  return new Date(ms).toISOString();
}

function sumTokens(list) {
  const out = { input: 0, cached: 0, output: 0, total: 0 };
  for (const t of list) {
    if (!t) continue;
    out.input += t.input || 0;
    out.cached += t.cached || 0;
    out.output += t.output || 0;
    out.total += t.total || 0;
  }
  return out;
}

module.exports = {
  isCredentialName,
  isSafeFileName,
  truncate,
  parseStartLocal,
  offsetMinutesOf,
  toIso,
  sumTokens,
};
