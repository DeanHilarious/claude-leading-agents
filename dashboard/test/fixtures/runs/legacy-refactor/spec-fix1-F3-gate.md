# 重构 F3 网关模块（含回归门禁）

## 目标
重构 /home/demo/legacy 中的 F3 网关模块，消除与 a.js 的循环依赖，且不改变任何公开行为。

## 范围
- 拆分 `gate.js` 为 `gate/core.js`（校验与决策）与 `gate/io.js`（读写适配）。
- 更新全部引用方的 import 路径（以 T0 的 `deps.json` 为准）。
- 循环依赖 `a.js ↔ gate.js` 通过把共享常量提到 `shared/constants.js` 消除。
- 建立回归门禁：`test/regress/` 下全部用例跑通才算完成，任一失败即打回。

## 验收标准
1. `node scan.js` 生成的 `cycles.json` 不再包含 a.js ↔ gate 相关条目。
2. 回归门禁 4 条用例全部通过（含 `gate-timing.js`）。
3. 公开接口签名与返回值保持不变（对照 `test/regress/contract.js`）。
4. 新增代码覆盖 `gate/core.js` 的分支不低于 80%。

## 交付要求
- 报告附门禁完整输出原文。
- 不要顺手重构门禁用例本身。
