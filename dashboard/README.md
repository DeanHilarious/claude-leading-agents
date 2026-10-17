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
