# 返工单：F3 第 1 次

回归门禁未全部通过，需要修复以下问题：

## 1. gate-timing 阈值写死导致门禁失败
- 位置：`test/regress/gate-timing.js:18`
- 现象：超时阈值写死为 500ms，重构后 IO 多一层转发，压测值 480–540ms 波动越界。
- 失败输出：
```
✖ gate-timing.js 超时阈值
  AssertionError: expected 480ms <= 500ms
  at test/regress/gate-timing.js:22
```
- 要求：改为读 `GATE_TIMEOUT` 环境变量，默认 800ms；本次授权修改该门禁用例。

## 2. 失败断言信息不足
- 位置：`test/regress/gate-timing.js:22`
- 要求：断言失败时打印实际耗时与阈值，例如 `expected ${actual}ms <= ${limit}ms`。

## 其他要求
1. 除上述两处外不得改动其他门禁用例。
2. 门禁 4/4 全部通过后再交付报告。
