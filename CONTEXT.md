# Auto Slice Context

Auto Slice 把已确认的开发目标组织为顺序执行、逐片验收的本地 Codex 工作流。它以持久状态协调任务接力，并保护同一工作区免受并发写入。

## Language

**Auto Slice Run**:
一次按固定切片计划和提交策略推进的完整执行。
_Avoid_: Goal、backlog、session

**Slice**:
具有明确范围、排除项和确定性验收条件的最小工作单元。
_Avoid_: Step、顺手修改、模糊任务

**Source Thread**:
保存当前 Slice 工作历史、且在接力前仍是权威来源的 Codex 持久化任务。
_Avoid_: Compression Task、Continuation Task

**Source Interruption**:
停止 Source Thread 的当前执行，同时保留其持久化记录和 UUID。
_Avoid_: 删除、归档、清空

**Compression Task**:
专门读取一个 Source Thread 并发布 Handoff 的全新 Codex 任务；它不继续源工作。
_Avoid_: Source Thread、Continuation Task

**Handoff**:
由 Compression Task 发布的可移植续接包，由 Markdown 摘要和 Evidence Index 共同组成。
_Avoid_: 普通总结、聊天复制

**Continuation Task**:
消费已验证 Handoff、恢复同一 Slice 工作的第二个全新 Codex 任务。
_Avoid_: Compression Task、复用 Source Thread

**Compaction Timeout**:
Source Thread 进入可观测的自动压缩状态后，连续 30 秒仍未完成的状态。
_Avoid_: 任意 30 秒无输出、通用卡顿

**Project Write Lease**:
Auto Slice Run 内授予单个开发任务的工作区独占写权限；每次接力都会更换 epoch。
_Avoid_: 永久文件锁、并行写权限

**Protected Change**:
Auto Slice Run 启动前已经存在、且不属于当前 Slice 的用户改动。
_Avoid_: Slice-owned change

**Commit Mode**:
Auto Slice Run 开始时选定的提交策略，仅允许 `after_slice` 或 `none`，除非某个 Slice 显式覆盖。
_Avoid_: 自动推送、隐式策略切换
