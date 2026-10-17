# API 交付报告（第 1 轮）

## 改动文件
- `src/server.js`（新增）：HTTP 服务入口，监听 127.0.0.1:8787。
- `src/routes/todos.js`（新增）：四个接口的路由、参数校验、错误响应。
- `src/store.js`（新增）：`data/todos.json` 读写封装，导出 `list/create/update/remove`。
- `test/api.test.js`（新增）：6 条接口测试。

## 测试输出
```
✔ GET 列表为空时返回 []
✔ POST 新建待办返回 201
✔ POST 缺 title 返回 400
✖ PATCH 未知 id 返回 200（期望 404）
✖ 并发写入丢失 1 条
ℹ tests 6, pass 4, fail 2
```

## 遗留问题
1. `PATCH /api/todos/:id` 未知 id 未校验，`src/routes/todos.js:38` 直接调用 `store.update`，命中不了也无报错。
2. `src/store.js:22` 的写文件是「读改写」三步，没有排队，并发请求会互相覆盖丢一条。

以上两条等待返工单确认后修复。
