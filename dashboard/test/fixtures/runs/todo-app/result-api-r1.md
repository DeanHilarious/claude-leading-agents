# API 交付报告（第 2 轮）

## 改动文件
- `src/routes/todos.js:38`：`store.update` 返回 null 时回 `404 {"error":"not found"}`。
- `src/store.js:22`：新增 `writeQueue` Promise 队列，所有写操作串行执行。
- `test/api-edge.test.js`（新增）：未知 id、5 连并发写入两个场景。

## 测试输出
```
✔ PATCH 未知 id 返回 404
✔ 并发写入不丢数据（5/5 落盘）
ℹ tests 8, pass 8, fail 0
```

## 说明
- 并发用例实测：5 个同时 `POST`，磁盘上最终 5 条，无覆盖。
- 未改动 API 行为与文件格式，`data/todos.json` 仍是合法 JSON。

## 遗留问题
无。等待验收。
