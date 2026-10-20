# reporter：本地上报器

把本机 `~/.codex-runs` 的任务文件与 Codex 派生数据，经脱敏后增量上报到指挥台服务器。零依赖，只用 Node ≥18 内置模块。

## 用法

```bash
node dashboard/reporter/reporter.js --url https://dashboard.example.com
node dashboard/reporter/reporter.js --url https://... --once        # 同步一遍后退出（退出码 0 = 全部成功）
node dashboard/reporter/reporter.js --runs DIR --codex-home DIR --dry-run   # 只打印将做什么，不联网
```

全部参数：`--url URL`、`--runs DIR`（默认 `~/.codex-runs`）、`--codex-home DIR`（默认 `~/.codex`）、`--machine NAME`（默认 `os.hostname()`，只保留 `[A-Za-z0-9._-]`）、`--once`、`--dry-run`、`--interval 30`。

配置优先级：**命令行 > 环境变量（`DASHBOARD_URL`、`DASHBOARD_INGEST_TOKEN`、`REPORTER_MACHINE`）> `~/.claude-leading-agents/reporter.json`**（`{"url","machine","runs","codexHome"}`）。

- `--url` 必须是 `https://`；仅 `localhost` / `127.0.0.1` / `[::1]` 允许 `http`，方便本地联调。
- 启动先 `GET /ingest/v1/ping` 校验令牌与连通性，失败中文提示并以退出码 1 退出。

## 首次使用

```bash
# 1. 放好令牌（也可以用环境变量 DASHBOARD_INGEST_TOKEN 代替）
mkdir -p ~/.claude-leading-agents
printf '服务器管理员发给你的令牌' > ~/.claude-leading-agents/token
chmod 600 ~/.claude-leading-agents/token

# 2. 写配置（可选：也可以每次用 --url / 环境变量 DASHBOARD_URL）
cat > ~/.claude-leading-agents/reporter.json <<'EOF'
{
  "url": "https://dashboard.example.com",
  "machine": "我的MacBook",
  "runs": "~/.codex-runs",
  "codexHome": "~/.codex"
}
EOF

# 3. 先 --dry-run 看一遍将上传什么、跳过什么（不联网、不写状态）
node dashboard/reporter/reporter.js --dry-run

# 4. 确认无误后同步一遍（退出码 0 = 全部成功）
node dashboard/reporter/reporter.js --once

# 5. 没问题就用 launchd 常驻（见下节），开机自动上报
```

## 上传什么

- 只上传**任务文件夹的直接子文件**，白名单：`*.md`、`*.txt`、`*.jsonl`、`*.log`、`START*`（含 `events.jsonl`）。
- 超过 2MB 的文件取**末尾 2MB** 上传。
- 上传前全部经过 `lib/redact.js` 脱敏，对**脱敏后内容**算 sha256 做增量：内容没变不重传。
- 每次上传打印一行：`↑ <run>/<filename>（脱敏 N 处）`。

## 跳过什么（及原因）

- `cb-*.json`、`result-*.json`：体积大、含完整对话；
- `*.err`、`*.patch`；
- 凭证类文件名：含 `auth`、`credential`、`token.json`、`.env`（忽略大小写）；
- 二进制（含 NUL 字节）、不是有效 UTF-8 的文件；
- 隐藏文件（`.` 开头）。

## `.no-upload`：按任务关闭上报

在某个任务文件夹里放一个空文件 `.no-upload`，该任务**整体**跳过（文件与 Codex 派生数据都不上传）。删掉该文件即恢复。

## 脱敏范围

见 `dashboard/lib/redact.js`：`sk-…`、GitHub / AWS / Slack / Google 密钥、私钥块、JWT、`Bearer` 长串、敏感键名的赋值、URL 内嵌密码等，命中处替换为 `[REDACTED:<kind>]`。邮箱和手机号不处理。

## 令牌放哪

**只**从这两个地方读（绝不出现在命令行参数、日志、报错里）：

1. 环境变量 `DASHBOARD_INGEST_TOKEN`；
2. 文件 `~/.claude-leading-agents/token`（**必须 `chmod 600`**，权限不对会拒绝启动并提示）。

```bash
mkdir -p ~/.claude-leading-agents
printf '你的令牌' > ~/.claude-leading-agents/token
chmod 600 ~/.claude-leading-agents/token
```

## 状态与增量

- `~/.claude-leading-agents/reporter-state.json`（0600，原子写）记录每个文件脱敏后内容的哈希、每个会话文件的 `mtime+size`、最近一次额度；一致则跳过。
- 本地任务文件夹整个消失时，若此前上传过，会 `DELETE /ingest/v1/runs/<machine>/<run>` 清理远端。
- 网络失败 / 5xx / 429 按指数退避重试（1s 起、最长 5 分钟、带抖动）；401 / 400 不重试。单个文件失败不影响其他文件。
- `SIGINT` / `SIGTERM` 时等待在途请求完成后退出。

## 用 launchd 常驻

保存为 `~/Library/LaunchAgents/com.claude-leading-agents.reporter.plist`（把 `URL` 换成你的服务器地址）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude-leading-agents.reporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/claude-leading-agents/dashboard/reporter/reporter.js</string>
    <string>--url</string>
    <string>https://dashboard.example.com</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/你/Library/Logs/claude-leading-agents-reporter.log</string>
  <key>StandardErrorPath</key><string>/Users/你/Library/Logs/claude-leading-agents-reporter.err.log</string>
  <!-- 令牌不放 plist：用 ~/.claude-leading-agents/token 文件（0600）或 EnvironmentVariables 之外的机制 -->
</dict>
</plist>
```

加载与查看：

```bash
launchctl load ~/Library/LaunchAgents/com.claude-leading-agents.reporter.plist
launchctl list | grep claude-leading-agents
tail -f ~/Library/Logs/claude-leading-agents-reporter.log
```

> 令牌用 `~/.claude-leading-agents/token` 文件提供，**不要**写进 plist（plist 对同机所有用户可读）。
