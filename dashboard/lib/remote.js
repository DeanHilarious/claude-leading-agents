'use strict';
// 远程模式辅助：多机器数据源枚举、Host 校验、安全响应头。
const fs = require('fs');
const path = require('path');

// 遍历 DATA/<machine>/runs/*。任务 key：默认 <run>；多台机器同名时 <run>@<machine>。
function listRunEntries(dataDir) {
  let machines;
  try { machines = fs.readdirSync(dataDir, { withFileTypes: true }); } catch (e) { return []; }
  const entries = [];
  const nameCount = new Map();
  for (const m of machines) {
    if (!m.isDirectory() || m.name.startsWith('.')) continue;
    const runsDir = path.join(dataDir, m.name, 'runs');
    let ents;
    try { ents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
      entries.push({ machine: m.name, name: e.name, dir: path.join(runsDir, e.name) });
    }
  }
  for (const en of entries) {
    en.key = (!en.machine || nameCount.get(en.name) === 1) ? en.name : en.name + '@' + en.machine;
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

// Host 校验：原有 localhost 规则 + --allowed-host 列出的域名（可不带端口）
function hostAllowed(host, port, allowedHosts) {
  if (host === 'localhost:' + port || host === '127.0.0.1:' + port) return true;
  if (!allowedHosts || !allowedHosts.length) return false;
  const bare = host.replace(/:\d+$/, '');
  return allowedHosts.includes(host) || allowedHosts.includes(bare);
}

function securityHeaders(https) {
  const h = {
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (https) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

module.exports = { listRunEntries, hostAllowed, securityHeaders };
