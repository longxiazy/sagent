# Sagent Backend TODO

按优先级逐项处理。每完成一项，补充对应测试并从本列表勾选。

## P0 — 安全边界

- [x] 重构 `terminal.run_safe`：改为无 shell 的命令 + 参数白名单，移除可写/可执行子命令。
- [x] 为局域网 API 增加认证、严格 CORS 和安全的默认监听地址。
- [x] 审批接口校验 `approvalId` 与 `runId` 的归属关系。

## P1 — 核心正确性

- [x] 建立 `AgentAction`、`AgentEvent`、`RunRecord` 判别联合与明确的 Run 状态机。
- [x] 使用原子 Run 锁消除并发启动竞态；取消中的 Run 继续占用运行锁。
- [x] 统一模型、工具、worker、子 Agent 的 `AbortSignal` 和 deadline，确保超时真正终止底层任务。
- [x] 修复 spawn 子 Agent 超时未传递的问题。
- [x] 项目创建、更新、激活和 Agent Run 启动前校验根目录，失效时返回明确错误。
- [x] 强化项目目录隔离：读写都使用 canonical realpath，阻止绝对路径和 symlink 越界。
- [x] 让子 Agent 使用真正的只读工具集合，禁止终端写入和浏览器交互副作用。
- [x] 修复项目 Run 取消和 SSE 重连错误使用全局 checkpoint/trace 目录的问题。
- [x] 为 checkpoint/trace/memory 建立串行持久化队列，结束前 flush，消除写入与清理竞态。

## P2 — 稳定性与可维护性

- [x] 为 SSE 事件增加单调序号和 cursor 重连，避免重放重复与乱序。
- [x] 限制内存事件和 trace promise 数量，增加日志大小与保留周期配置。
- [x] 将 memory 持久化纳入可等待的后台任务队列，shutdown 时统一 flush。
- [x] 自动恢复任务完成后，正确写入本轮项目记忆。
- [x] 对 LLM 日志、trace、终端输出和截图增加敏感信息脱敏。
- [x] 继续收紧 provider、工具实现和 checkpoint 边界中的遗留 `any`。
