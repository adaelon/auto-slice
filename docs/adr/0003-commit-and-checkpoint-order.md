# 提交模式与 Checkpoint 顺序

状态：Controller 编排部分先后由 [ADR-0008](0008-goal-task-input-and-finish-ownership.md) 与 [ADR-0010](0010-trusted-worker-completion.md) 取代；本文仅保留历史背景。

历史实现曾由 Controller 验收、提交并刷新 checkpoint。现行 `commit_mode=after_slice|none` 只改变 Goal Prompt；commit 与 checkpoint 是否实际完成由工作进程负责，Controller 不再观察或裁决。
