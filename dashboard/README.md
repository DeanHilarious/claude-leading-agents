# claude-leading-agents 指挥台（Dashboard）

一个本地只读网站，把 `claude-leading-agents` 派给 Codex / CodeBuddy 的任务过程可视化：任务、子任务、轮次、状态、token 与额度一目了然。

界面设计见 DESIGN.md。

## 启动

```bash
# 默认读取 ~/.codex-runs 与 ~/.codex（可用 $CODEX_HOME 覆盖）
node dashboard/server.js

# 演示模式：使用内置合成数据，now 固定为 2026-10-17T22:10:00+08:00，不读 ps
node dashboard/server.js --demo

# 全部参数
node dashboard/server.js [--port 4177] [--runs DIR] [--codex-home DIR] [--demo] [--now ISO]
```

启动后访问 http://127.0.0.1:4177 。零第三方依赖，只用 Node ≥18 内置模块。

## 数据从哪来

- 每个「任务（run）」是 `--runs` 目录（默认 `~/.codex-runs`）下的一个子文件夹。
- 文件名约定（旧约定）：
  - `spec-<子任务>.md` 规格，`result-<键>.md` Codex 报告，`cb-<键>.md/.json/.err` CodeBuddy 报告，`sum-<键>.txt` 一行汇总，`log-<键>.txt` Codex 日志，`fix-<键>-<N>.md` 第 N 次返工单，`review*.md` 评审记录，`START*` 开工时间，其余归「其他」。
  - 产出文件按「键去轮次后缀、词序列连续匹配」归属到子任务。
- `events.jsonl`（新约定，优先）：每行一个事件，见下。
- Codex 执行过程与 token 从 `$CODEX_HOME/sessions/**/rollout-*-<sessionId>.jsonl` 解析（启动建索引，缺会话时重建一次）；CodeBuddy token 从 `sum-*.txt` 或 `cb-*.json` 解析。

## events.jsonl 格式

每行一个 JSON 对象，坏行自动跳过：

```json
{"t":"2026-10-17T21:15:00+08:00","sub":"api","event":"dispatched","agent":"codex","model":"gpt-6.1-sol","effort":"medium","round":1}
{"t":"2026-10-17T21:40:00+08:00","sub":"api","event":"delivered","round":1}
{"t":"2026-10-17T21:45:00+08:00","sub":"api","event":"rejected","round":1,"note":"2 条测试失败"}
{"t":"2026-10-17T22:05:00+08:00","sub":"api","event":"accepted","round":2}
```

`event` 取值：`dispatched`（派出）、`delivered`（代理交付）、`rejected`（打回）、`accepted`（通过）、`abandoned`（放弃）。

## 远程模式

指挥台可以部署成「本地上报 → 服务器展示」：技能继续在本机跑，本机的上报器（reporter）监视 `~/.codex-runs` 并把任务文件**脱敏后**增量上传到服务器，服务器上的看板加登录密码，体验与本地版一致（含 SSE 实时刷新）。

```
本机 ~/.codex-runs ──▶ reporter（监视 + 脱敏 + 增量上传）──HTTPS+令牌──▶ nginx ──▶ server.js（接收 + 登录 + 看板）
```

```bash
node dashboard/server.js --data /var/lib/claude-leading-agents \
  --allowed-host dashboard.example.com --port 4177
```

参数：`--data DIR`（启用远程模式，与 `--demo`/`--runs`/`--codex-home` 互斥）、`--allowed-host a.com,b.com`（额外允许的 Host 头）、`--listen-host`（默认 127.0.0.1）。

环境变量：

| 变量 | 说明 |
|---|---|
| `DASHBOARD_PASSWORD` | 观看者登录密码（必填） |
| `DASHBOARD_INGEST_TOKEN` | 接收接口令牌，≥24 字符（必填，与观看密码分开） |
| `DASHBOARD_SESSION_SECRET` | 会话签名密钥（可选；不设则自动生成 `DATA/.session-secret`，权限 0600） |
| `DASHBOARD_MAX_BYTES` | 数据目录磁盘配额，字节（默认 2GB，超出返回 507） |
| `DASHBOARD_HOST` | 对外域名，传给 `--allowed-host`（部署模板用） |

任务来源为 `DATA/<machine>/runs/*`，多台机器同名任务显示为 `<run>@<machine>`；额度取各机器 `quota.json` 里修改时间最新的一份。逐步部署（systemd + nginx + 证书）见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。

安全说明：

- **必须放在 HTTPS 反代后面**（nginx 配置见 `deploy/nginx.conf.example`）。明文 HTTP 会让密码、会话 cookie 和上报数据裸奔；服务端已按 `X-Forwarded-Proto` 自动加 `Secure` / HSTS。
- **令牌与密码分开**：令牌给上报器，密码给观看者；令牌泄露只影响上报（可轮换），不等于能看板。
- **脱敏是尽力而为，不是保证**：两边都会跑 `lib/redact.js`，但无法保证识别所有形态的密钥。特别敏感的任务请在 `~/.codex-runs/<任务>/` 里放一个 `.no-upload` 文件，上报器会跳过整个任务。

## 测试

```bash
node --test 'dashboard/test/*.test.js'
```

注意：加引号是为了让 Node 自己展开通配符。本机 Node 23.11 不支持给 `--test` 传目录参数
（`node --test dashboard/test/` 会把目录当模块加载而失败）；支持目录参数的 Node 版本上两种写法等价。

`test/fixtures/` 是全部合成（`/home/demo/...` 路径，无真实数据）的演示数据，同时供 `--demo` 使用。

## 安全说明

- **只读**：服务端不写、不删、不移动任何文件；不启动、不停止任何进程（`ps` 只读，仅用于识别在跑的代理进程）。
- **只听 127.0.0.1**：不对外网开放；请求的 `Host` 不是 `localhost:<port>` / `127.0.0.1:<port>` 时返回 403（防 DNS 重绑定）。
- **不读凭证**：路径中含 `auth`、`credential`、`token.json`、`.env` 的文件一律跳过。
- 文件接口只允许任务文件夹的直接子文件，文件名必须匹配 `^[\w.\-]+$`，超过 2MB 只返回最后 2MB。

## 截图

先启动演示服务，再运行 `bash dashboard/scripts/screenshot.sh` 重新生成 `docs/screenshots/` 下的截图。
