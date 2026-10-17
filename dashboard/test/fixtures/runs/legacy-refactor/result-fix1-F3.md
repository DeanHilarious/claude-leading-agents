# F3 重构交付报告（第 1 轮）

## 改动文件
- `gate/core.js`、`gate/io.js`（新增）：从 `gate.js` 拆出，原文件删除。
- `shared/constants.js`（新增）：a.js 与 gate 共享的常量提到此处。
- 引用方 import 路径更新 8 处（清单见 `deps.json` diff）。
- `test/regress/` 未改动。

## 门禁输出
```
✔ contract.js 接口契约不变
✔ gate-io.js 读写适配
✔ a-no-cycle.js 循环依赖已消除
✖ gate-timing.js 超时阈值
  AssertionError: expected 480ms <= 500ms
  at test/regress/gate-timing.js:22
ℹ 3/4 通过
```

## 说明
- 循环依赖已消除：`node scan.js` 后 `cycles.json` 为空数组。
- `gate-timing.js` 失败原因：该用例在 `test/regress/gate-timing.js:18` 把超时阈值写死为 500ms，重构后 IO 路径多一层转发，压测值 480–540ms 波动越界。

## 遗留问题
- 门禁用例把阈值写死，属于用例自身缺陷，需返工单确认「改用例」是否被允许后再动。
