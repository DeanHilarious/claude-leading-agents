# 返工单：api 第 1 次

上一轮验收未通过，以下两个问题需要修复：

## 1. PATCH 未知 id 返回 200（期望 404）
- 位置：`src/routes/todos.js:38`
- 现象：`store.update` 查不到 id 时返回 null，路由没有判空，直接 `res.end(JSON.stringify(null))`。
- 失败输出：
```
✖ PATCH 未知 id 返回 404
  expected 404, got 200
  body: {"ok":false}
```
- 要求：未知 id 返回 `404 {"error":"not found"}`。

## 2. store 并发写入竞态
- 位置：`src/store.js:22`
- 现象：「读改写」三步无排队，两个并发 `POST` 各自读到旧列表，后写覆盖先写，丢失 1 条。
- 失败输出：
```
✖ 并发写入不丢数据
  expected 2 todos, got 1
```
- 要求：写操作串行化（Promise 队列），并在补测试中验证 5 个并发请求全部落盘。

## 其他要求
1. 为上述两个场景补充测试用例到 `test/api-edge.test.js`。
2. 修复后重新运行 `node --test test/`，全部通过再交付报告。
