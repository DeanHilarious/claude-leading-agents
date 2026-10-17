---
name: claude-leading-agents
description: 带着 Codex CLI 和 CodeBuddy CLI 干活（1 个大脑 + 2 双手）：Claude 拆任务、写规格与验收标准，按配比表把子任务派给 Codex（难活）或 CodeBuddy（量大、边界清楚的活），Claude 审 diff、跑测试、不合格就返工，最后出一张 token 账单。用户说"让 Codex/CodeBuddy 做/实现/修"、"带着 codex 干活"、"分一部分给 codebuddy"、"/claude-leading-agents <任务>"，或要求用 Codex 做第二意见代码评审时使用。
---

# 三方协作：1 个大脑 + 2 双手

| 角色 | 谁 | 负责 |
|---|---|---|
| 大脑 | **Claude** | 判断要不要派、拆解、写规格、验收、汇报。不写实现代码，不通读大日志/大 diff |
| 主力手 | **Codex**（GPT-6，`codex exec`） | 逻辑绕的 T2、全部 T3、第二意见评审 |
| 量产手 | **CodeBuddy**（国产模型，`cb.sh`） | T0 调研、T1、边界清楚且有测试的 T2 |

Claude 的 token 最贵，而 Claude 每多一轮工具调用都要把整段上下文重读一遍（缓存读取）。所以本方案省钱靠两点：**把读代码、写代码、调试这些"重轮次"的活交出去**，以及 **Claude 自己尽量少走轮次**。
代理的自述（"已完成""测试通过"）一律不作数，以 Claude 亲自看到的 diff 和测试结果为准。

## 0. 先过派活门槛
派活有固定开销：实测领队 Claude 约 20 轮（读需求、写规格、派活、等待、验收、返工、汇报）。两轮实测（5 个小功能 / 在 8000 行库里修 9 个 bug）Claude 单干分别 9 轮、16 轮就做完，派出去 Claude 自己反而多花 40%–290% token。
- **Claude 自己做**：改动集中、Claude 已经读过相关代码、预计 20 轮以内能写完测完的活。用户点名要派除外。
- **派出去**：要在陌生/大代码库里找原因、要读大量代码、预计要多轮调试、改动量大或文件多、可以并行的多个独立子任务。
- 拿不准时：先派一个 T0 调研（便宜），看完摘要再决定。

## 前置事实
- **Codex**：`codex exec` 非交互；自带 `-s workspace-write` 沙箱。
- **CodeBuddy**：用 PATH 里的 `codebuddy`（或用环境变量 `CB_BIN` 指定完整路径；某些桌面应用自带的裁剪版无法登录，要用官方 CLI）。**没有系统沙箱**，`cb.sh` 用权限模式 + 工具白名单/黑名单 + "每次只跑一条简单命令"的追加提示约束它；**永远不要加 `-y`**。积分余额命令行查不到，`total_cost_usd` 恒为 0，看 token。
- 调用 `codex`、`cb.sh`、`check.sh`、`quota.py`、`tokens.py` 的 Bash 都要 `dangerouslyDisableSandbox: true`（它们要联网、要读写 `~/.codex` / `~/.codebuddy`，Claude Code 的沙箱会拦）。
- 下文的模型名是写作时的示例，以你账号里实际可用的为准（见 §1 最后一条）。
- 运行时长常超 10 分钟：`run_in_background: true` 启动，等完成通知，不要轮询。
- `RUN=~/.codex-runs/<任务短名>` 放规格、日志、结果；`S=~/.claude/skills/claude-leading-agents`。

## 事件记录（给指挥台用）
每次派活、收到交付、验收结论时，往 `$RUN/events.jsonl` 追加一行（一条 echo，不要读回）：
```
echo '{"t":"'$(date +%Y-%m-%dT%H:%M:%S%z)'","sub":"<子任务>","event":"<事件>","agent":"codex","model":"<模型>","effort":"<强度>","round":1}' >> $RUN/events.jsonl
```
- `event`：`dispatched`（派出，含返工派出，round+1）、`delivered`（代理交回）、`rejected`（打回，可加 `"note":"原因"`）、`accepted`（通过）、`abandoned`（放弃）。`agent/model/effort` 只在 dispatched 时写。
- 文件统一用子任务名命名：`spec-<子任务>.md`、`result-<子任务>.md`、`log-<子任务>.txt`、`fix-<子任务>-N.md`，返工轮的报告和日志加 `-rN`。
- 本地网页 `dashboard/`（`node dashboard/server.js`）会读这些文件，把派活和执行过程画出来。

## 1. 配比表
用户点名了代理/模型/强度就照办；否则：

| 档位 | 典型任务 | 派给 | 模型 / 强度 |
|---|---|---|---|
| T0 调研 | 只读：找调用点、定位原因、汇总现状 | CodeBuddy `read` | `deepseek-v4.1-flash` / `low` |
| T1 简单 | 单文件小改、改名、补注释/测试、明确报错的小 bug | CodeBuddy | `deepseek-v4.1-flash` / `medium` |
| T2·清 | 接口和行为已写死、有测试可跑 | CodeBuddy | `glm-5.3` / `high` |
| T2·绕 | 状态多、边界多、要读懂现有设计 | Codex | `gpt-6.1-sol` / `medium`（较绕 `high`） |
| T3 困难 | 跨模块/架构、并发/性能/安全、原因不明、算法正确性 | Codex | `gpt-6-astra` / `high`（极难 `xhigh`） |
| 评审 | 第二意见 | Codex | `gpt-6.1-sol` / `high` |

- 拿不准选低一档。返工先升强度再升模型；**CodeBuddy 返工 2 轮不过 → 转 Codex**（T2·绕起步）。
- `max` / `ultra` 默认不用，需先征得用户同意。
- 派 Codex 前跑 `python3 $S/quota.py`：周额度 >70% 把能下沉的 T2 都给 CodeBuddy 并告知用户；>90% 先问用户。
- 模型报错不存在：Codex 查 `~/.codex/models_cache.json` 里 `visibility: "list"` 的模型按角色对应；CodeBuddy 看 `codebuddy --help` 的 `--model` 列表。

## 2. 写规格 `$RUN/spec-<子任务>.md`
目标 / 上下文（文件路径、约定，公共部分写进 `$RUN/context.md` 并引用）/ 范围（允许改什么、不许碰什么）/ 验收标准（含测试命令和期望结果）/ 交付要求（改了什么、为什么、没做或不确定的）。
派给 CodeBuddy 的再写明：只在工作目录内读写；不装依赖、不联网、不做 git 提交/回滚；接口签名一字不改。
**合并同类项**：同一个代理、同一片代码的几个小活写进一份规格一次派，别拆成多次往返。

## 3. 派活：一次派齐
先记基线（git：`git status --short`；非 git：`rsync -a ... <dir>/ $RUN/before/`）和开工时间 `START=$(date +%Y-%m-%dT%H:%M)`。
互不相交的子任务放进**同一条**后台 Bash 并行跑，结束时只收到一次通知：
```
( codex exec -C <wt1> -s workspace-write [--skip-git-repo-check] -m <模型> -c model_reasoning_effort='"<强度>"' -o $RUN/result-a.md - < $RUN/spec-a.md > $RUN/log-a.txt 2>&1 &
  bash $S/cb.sh <wt2> $RUN/spec-b.md $RUN/cb-b <模型> <强度> > $RUN/sum-b.txt 2>&1 &
  wait )
```
- 并行必须在不同目录：git 用 `git worktree add`，非 git 复制一份；同一目录同一时间只允许一个代理。
- Codex 日志开头有 `session id: <uuid>`；CodeBuddy 的 session 在 `sum-*.txt` 里。返工靠它们接回原会话。

## 4. 验收：一条命令看全
```
bash $S/check.sh <dir> "<测试命令>" $RUN/result-*.md $RUN/cb-*.md     # 非 git 加 BEFORE=$RUN/before
```
它一次输出：各代理报告的结尾、改动文件列表、测试结果结尾和退出码。只在需要时再细看关键文件的 diff；生成物、锁文件、测试数据不逐行看。
逐条核对验收标准，检查越界（范围外文件、删了不该删的、无关重构、新依赖、改了接口签名）。合并 worktree 的改动后**只在最后跑一次全量测试**。

## 5. 返工
问题写进 `$RUN/fix-<子任务>-N.md`（文件:行、失败输出、违背的验收条目，不贴整段代码），接回原会话：
```
cd <dir> && codex exec resume --skip-git-repo-check <session-id> -c sandbox_mode='"workspace-write"' -m <模型> -c model_reasoning_effort='"<强度>"' -o $RUN/result-<子任务>-rN.md - < $RUN/fix-<子任务>-N.md > $RUN/log-<子任务>-rN.txt 2>&1
CB_RESUME=<session-id> bash $S/cb.sh <dir> $RUN/fix-<子任务>-N.md $RUN/cb-<子任务>-rN <模型> <强度>
```
- `resume` 不认 `-s`，沙箱要用 `-c sandbox_mode=...` 传；非 git 目录必须带 `--skip-git-repo-check`，否则 Codex 会直接退出、什么都不改。

单个子任务最多返工 3 轮；仍不合格就停下，向用户说明卡在哪，问是 Claude 接手、换思路还是放弃。

## 6. 汇报 + token 账单
`python3 $S/tokens.py --since $START <dir> [<worktree>...]` 出 Codex / CodeBuddy 账单。
向用户报告：做了什么、改了哪些文件、测试结果（附关键输出）、每个子任务派给谁/模型/强度、返工轮数、遗留问题、账单。不要提交 git，除非用户要求。

## 变体：第二意见评审
```
cd <dir> && codex exec review -m gpt-6.1-sol -c model_reasoning_effort='"high"' --uncommitted -o $RUN/review.md > $RUN/review-log.txt 2>&1   # 或 --base main
```
非 git 目录用 `codex exec -C <dir> -s read-only --skip-git-repo-check ... "评审以下文件……只指出问题，不要修改"`；要第三意见再用 `cb.sh ... glm-5.3 high read`。每条意见 Claude 自己核实后再决定采纳与否。
