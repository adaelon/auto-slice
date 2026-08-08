# 本地控制器与任务隔离

Auto Slice 采用本地 Codex 插件作为入口、持久化确定性 Slice Controller 作为状态机，并在单一 Local checkout 上用 Project Write Lease 串行化写入。Compression Task 始终只读，Continuation Task 必须是另一个全新任务并取得新 write epoch；该隔离牺牲并行吞吐，以换取可恢复性和工作区一致性。
