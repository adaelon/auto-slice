# 本地控制器与任务隔离

状态：任务隔离继续有效；Compression 的“只读”由 [ADR-0011](0011-export-owned-revision-and-fresh-task-launchers.md) 收窄为“不取得 Project Write Lease”，其 App Server turn 可仅为 Handoff 发布使用 workspace-write sandbox。

Auto Slice 采用本地 Codex 插件作为入口、持久化确定性 Slice Controller 作为状态机，并在单一 Local checkout 上用 Project Write Lease 串行化开发写入。Compression Task 始终不取得 Project Write Lease，只能使用 Handoff 发布所需的管理型写能力；Continuation Task 必须是另一个全新任务并取得新 write epoch。该隔离牺牲并行吞吐，以换取可恢复性和工作区一致性。
