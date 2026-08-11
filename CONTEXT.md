# Auto Slice Context

Auto Slice 把已确认的开发目标组织为顺序执行、逐片推进的本地 Codex 工作流。它以持久状态协调任务接力，并保护同一工作区免受并发写入。

## Language

**Auto Slice Run**:
一次按固定切片计划和 Goal Prompt 策略推进的完整执行。
_Avoid_: Goal、backlog、session

**Slice**:
由 checkpoint 或 Handoff 定义、交给一个 Development Task 或 Continuation Task 完成的最小工作单元。
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
Auto Slice Run 开始时选定的 Goal Task 提示策略，仅允许 `after_slice` 或 `none`，除非某个 Slice 显式覆盖；它只改变发送给 Development Task 或 Continuation Task 的收口措辞，Controller 不核验 commit、HEAD 或 checkpoint。
_Avoid_: 自动推送、隐式策略切换

**Production Plan**:
一次 Auto Slice Run 的版本化生产输入，固定 Run 身份、提示策略、模型能力快照和有序 Slice 身份；旧版 Slice 契约中的 `owned_paths`、`exclusions`、`checks` 与 `expected_artifacts` 仅为兼容字段，不参与运行判断。
_Avoid_: 控制命令 envelope、运行时状态、未排序 backlog

**Development Task**:
为一个 Slice 以一句 `设定goal` 启动并持有开发上下文的 Codex 持久化任务；具体方案只从 checkpoint 或 Handoff 读取，启动后即成为该 Slice 的 Source Thread。
_Avoid_: Controller、确定性验收进程、Compression Task

**Production Orchestrator**:
依据 Production Plan、持久 Run 状态和结构化任务生命周期顺序投递 Goal Prompt 的本地驱动器；Development Task 或 Continuation Task 以 `COMPLETED` 结束即推进下一 Slice，不检查工作区、Git、测试、产物、commit 或 checkpoint。
_Avoid_: E2E harness、远程服务、工作产物验收器

**Worker Content**:
Development Task 或 Continuation Task 的模型可见正文与高体量过程数据，包括消息、reasoning、命令输出、diff、工具 payload 和完整 turns。
_Avoid_: 任务 UUID、枚举状态、有序事件、时间戳、确定性回执

**Content-blind Controller**:
只消费有界的身份、状态、序号和时间，不将 Worker Content 注入模型上下文、控制判断、持久状态或日志的 Controller；结构化压缩事件不可用时只接收 Compaction Content Probe 的枚举投影。
_Avoid_: Compression Task、常规正文诊断、Source Thread 历史阅读器

**Compaction Content Probe**:
仅在 Host 无法提供结构化 `contextCompaction` 事件时启用的隔离降级观察器；运行 20 分钟首次探测，30 至 40 分钟每 5 分钟探测，40 分钟后每 2 分钟探测，可读取 Worker Content，但只向 Controller 返回是否发生自动压缩的枚举结果。
_Avoid_: 常规进度监控、工作质量判断、正文转发

**Trusted Completion**:
Development Task 或 Continuation Task 的当前 Turn 以结构化 `COMPLETED` 结束，即视为当前 Slice 已完成并允许 Run 推进；`FAILED`、`INTERRUPTED` 或协议错误仍进入 `NEEDS_USER`。
_Avoid_: Git 验收、文件归属判断、测试复跑、模型自述解析
