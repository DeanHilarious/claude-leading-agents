'use strict';
// 目录监视：文件变化后对比缓存签名，广播 SSE change/quota 事件。
const fs = require('fs');

// deps: {watchDir, listEntries, runSig, cache, scanOne, quota, broadcast}
function startWatch(deps) {
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(deps.watchDir, { recursive: true }, () => {
      clearTimeout(timer);
      // 防抖：300ms 内的连续变化合并
      timer = setTimeout(() => {
        const changed = [];
        for (const entry of deps.listEntries()) {
          const sig = deps.runSig(entry.dir);
          const hit = deps.cache.get(entry.key);
          if (!hit || hit.sig !== sig) changed.push(entry.key);
        }
        const oldQuota = JSON.stringify(deps.quota());
        for (const key of changed) {
          const e = deps.listEntries().find((x) => x.key === key);
          if (e) deps.scanOne(e); // 刷新缓存
        }
        if (changed.length) deps.broadcast('change', { runs: changed });
        if (oldQuota !== JSON.stringify(deps.quota())) deps.broadcast('quota', { quota: deps.quota() });
      }, 300);
    });
  } catch (e) { /* watch 失败则静默，接口仍可用 */ }
  return () => { if (watcher) watcher.close(); };
}

module.exports = { startWatch };
