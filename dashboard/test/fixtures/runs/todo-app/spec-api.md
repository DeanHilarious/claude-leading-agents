# 实现待办 API

## 目标
用 Node ≥18 内置模块（http、fs、path）实现待办事项的 REST API，作为整个待办应用的数据层。

## 范围
- `GET /api/todos`：返回全部待办，支持 `?done=1` 只看已完成。
- `POST /api/todos`：新建待办，字段 `title` 必填、不超过 100 字。
- `PATCH /api/todos/:id`：更新完成状态或置顶标记。
- `DELETE /api/todos/:id`：删除待办。
- 数据落盘到 `data/todos.json`，启动时文件不存在则创建空列表。
- 所有响应均为 JSON；非法输入返回 400，未知 id 返回 404。
- 不引入任何第三方依赖。

## 验收标准
1. `node server.js` 启动后，四个接口行为与上述一致。
2. `node --test test/` 全部通过，至少覆盖增删改查、非法输入、未知 id。
3. 两个并发 `POST` 不丢数据（写入需串行化）。
4. `data/todos.json` 始终是合法 JSON，进程重启后数据不丢。

## 交付要求
- 报告写明改动文件、测试输出原文、遗留问题（如有）。
- 不要改动 `public/` 目录下的任何文件。
