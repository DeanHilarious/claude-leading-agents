#!/usr/bin/env bash
# 用本机无头 Chrome 给指挥台演示服务截图。
#
# 用法：
#   bash dashboard/scripts/screenshot.sh
#   BASE=http://127.0.0.1:4177 CHROME="/path/to/Chrome" bash dashboard/scripts/screenshot.sh
#
# 输出（默认 docs/screenshots/）：
#   overview.png  总览
#   run.png       任务详情
#   drawer.png    任务详情 + 子任务抽屉
#   bill.png      账单
#   mobile.png    窄屏总览
#
# 说明：页面启动后会保持一条 SSE 长连接（/api/events），Chrome 的
# --virtual-time-budget 会一直等这条请求结束而卡住，所以这里用 Chrome
# 调试端口（CDP）在真实时间里等待渲染完成后再截图。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
BASE="${BASE:-http://127.0.0.1:4177}"
OUT="${OUT:-$ROOT/docs/screenshots}"

if [ ! -x "$CHROME" ]; then
  echo "错误：找不到 Chrome 可执行文件：$CHROME" >&2
  echo "请安装 Google Chrome，或用 CHROME=/path/to/chrome 指定路径。" >&2
  exit 1
fi

if ! node -e '
const base = process.argv[1].replace(/\/+$/, "");
const req = require("http").get(base + "/api/overview", { timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on("error", () => process.exit(1));
req.on("timeout", () => { req.destroy(); process.exit(1); });
' "$BASE"; then
  echo "错误：无法访问服务 $BASE/api/overview（请先启动演示服务，例如 node dashboard/server.js --demo）。" >&2
  exit 1
fi

mkdir -p "$OUT"

shot() {
  local name="$1" path="$2" size="${3:-1440,900}" wait_ms="${4:-2500}"
  local width="${size%,*}" height="${size#*,}"
  local target="$OUT/$name.png"
  local profile port_file port pid i

  profile="$(mktemp -d)"
  echo "截图 $name.png ..."

  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --no-first-run --no-default-browser-check \
    --user-data-dir="$profile" \
    --disable-background-networking --disable-sync --disable-component-update \
    --disable-default-apps --disable-extensions --no-service-autorun \
    --force-device-scale-factor=2 --window-size="$size" \
    --remote-debugging-port=0 about:blank >"$profile/chrome.log" 2>&1 &
  pid=$!

  port_file="$profile/DevToolsActivePort"
  i=0
  while [ ! -s "$port_file" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "错误：Chrome 启动失败，日志见 $profile/chrome.log" >&2
      exit 1
    fi
    sleep 0.2
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
      echo "错误：等待 Chrome 调试端口超时。" >&2
      kill -9 "$pid" 2>/dev/null || true
      exit 1
    fi
  done
  port="$(head -n 1 "$port_file")"

  set +e
  node - "$port" "$BASE$path" "$width" "$height" "$wait_ms" "$target" <<'NODE'
const http = require('http');
const fs = require('fs');
const [port, url, width, height, waitMs, out] = process.argv.slice(2);

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

(async () => {
  let targets = null;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await get('/json/list');
      if (targets.length) break;
    } catch (e) { /* Chrome 还没就绪，继续等 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!targets) throw new Error('无法获取 Chrome 页面列表');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可截图的页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: false
  });
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, Number(waitMs)));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  ws.close();
})().catch((e) => {
  console.error('截图失败：' + e.message);
  process.exit(1);
});
NODE
  local status=$?
  set -e

  kill "$pid" 2>/dev/null || true
  sleep 0.3
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$profile"

  if [ "$status" -ne 0 ] || [ ! -s "$target" ]; then
    echo "错误：截图失败：$target" >&2
    exit 1
  fi
}

shot overview "/#/" "1440,900" 2500
shot run "/#/run/todo-app" "1440,900" 2500
shot drawer "/#/run/todo-app/api" "1440,900" 3500
shot bill "/#/bill" "1440,900" 2500
shot mobile "/#/" "390,844" 2500

echo "完成：$OUT"
