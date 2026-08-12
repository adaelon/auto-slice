# Auto Slice 产品与架构契约

状态：可信完成与低干扰监控实现已收口，进入发布候选验收。术语以 [`CONTEXT.md`](../CONTEXT.md) 为准。

## 1. 产品边界

Auto Slice 是本地 Codex 插件及其持久化 Slice Controller。它接收一份已确认的 Slice 计划，在一个 Local checkout 中顺序投递 Goal Task，并在 Codex 自动压缩无法完成时通过 Handoff 接力。

包含：

- 持久化 Run/Slice 状态机；
- 单工作区独占写租约；
- 确定性模型路由；
- 一句话 Goal Task 启动与结构化终态可信完成；
- 自动压缩 30 秒超时后的三任务接力；
- 可恢复、可审计的错误闭合。

不包含：

- 并行修改同一 checkout；
- 自动 push；
- 静默模型降级；
- 修改、删除或归档 Source Thread；
- 让 Compression Task 或 Source Thread 消费 Handoff；
- 用“任意一段时间没有文本输出”代替自动压缩状态信号。

## 2. 外部操作契约

```text
start_run(plan, commit_mode) -> RunId | NEEDS_USER
get_run(run_id) -> RunSnapshot
pause_run(run_id) -> RunSnapshot
resume_run(run_id) -> RunSnapshot | NEEDS_USER
abort_run(run_id) -> RunSnapshot
override_slice_commit_mode(run_id, slice_id, mode) -> RunSnapshot
```

`start_run` 必须先验证计划、模型策略、工作区身份和 Project Write Lease。所有修改操作都携带 `run_id + state_version`，旧版本请求返回 `STALE_STATE`，不得重复执行副作用。

## 3. 持久状态

```text
RunState {
  schema_version
  run_id
  state_version
  workspace_identity
  plan_digest
  status
  commit_mode: after_slice | none
  current_slice_id
  protected_baseline_digest
  project_lock_owner
  write_epoch
  source_thread_id
  compaction?: {
    compaction_id
    observed_started_at
    deadline_at
    handoff_attempted
  }
  handoff?: {
    compression_task_id
    markdown_path
    evidence_index_path?  // schema 2/legacy replay only
    artifact_digest
    continuation_task_id
  }
  last_error?
}
```

Controller 必须先持久化意图，再执行外部副作用，最后持久化回执。每个副作用使用 `run_id/state_version/action` 形成幂等键。

## 4. 主状态机

```text
IDLE
  -> PREPARING
  -> SLICE_RUNNING
  -> PREPARING            # 当前 Slice 结构化 COMPLETED，准备下一 Slice
  -> SLICE_RUNNING | DONE # 最后一刀 COMPLETED 后直接 DONE

任意可恢复状态 -> PAUSED
任意失败闭合   -> NEEDS_USER
用户终止       -> ABORTED
```

`VERIFYING`、`COMMITTING`、`CHECKPOINTING` 只为旧 snapshot 解码、`status` 与 `abort` 保留；新 Run 不进入这些状态，也不能从旧态按新语义恢复。只有当前 Development Task 或 Continuation Task 可以持有 Project Write Lease；Compression Task 永远不取得写租约。

## 5. 自动压缩接力状态机

### 5.1 入口信号

Host Adapter 显式声明 `contextCompaction` 事件能力。能力为 `AVAILABLE` 时只消费带稳定 `compaction_id` 的 `AUTO_COMPACTION_STARTED` 与 `AUTO_COMPACTION_COMPLETED`，Compaction Content Probe 调用数必须为零；只有显式 `UNAVAILABLE` 才启用隔离 probe。

```text
UNAVAILABLE:
  20m -> 首次 probe
  30m / 35m / 40m -> 每 5 分钟 probe
  42m / 44m / ... -> 每 2 分钟 probe

NO_COMPACTION  -> 挂下一时点
COMPACTION_SEEN -> 投影 AUTO_COMPACTION_STARTED
PROBE_FAILED    -> NEEDS_USER(compaction_probe_failed)
```

Probe 可在隔离端口内部读取 Worker Content，但只返回封闭枚举、规范时间与白名单失败码；原始正文不得进入 Controller、RunStore、日志或错误消息。Turn 终止、结构化事件到达或已发现压缩都会取消后续 probe，且同一时刻最多一个读取 in-flight。

```text
SLICE_RUNNING
  -- AUTO_COMPACTION_STARTED --> COMPACTION_WAIT

COMPACTION_WAIT
  -- completed_at <= deadline_at --> SLICE_RUNNING
  -- clock >= deadline_at --------> SOURCE_INTERRUPTING
```

`deadline_at = observed_started_at + 30s`。Controller 以持久化事件序号串行处理完成事件和定时器；在边界竞争时，先成功提交状态转换者获胜，另一事件成为 no-op。

### 5.2 Source Interruption

```text
SOURCE_INTERRUPTING:
  interrupt_active_run(source_thread_id)
  require receipt.execution_stopped == true
  require receipt.thread_persisted == true
  rotate write_epoch
```

中断失败时进入 `NEEDS_USER(source_interrupt_failed)`。Controller 不删除、不归档、不清空 Source Thread，也不创建 Compression Task，直到停止回执成立。

### 5.3 Compression Task

```text
HANDOFF_EXPORTING:
  create fresh task in Source Thread workspace
  input exactly: $export-codex-handoff <source_thread_id>
  wait for completed Compression Turn
  take the first Markdown file address from its bounded final result
  persist a schema 3 path-only receipt; Evidence Index and HANDOFF_VERIFY add zero fields
```

Compression Task 必须满足 `export-codex-handoff` 的 Isolation Gate：它不是 Source Thread，不带源历史副本，也不会继续源工作。每个 `compaction_id` 最多创建一次 Compression Task；失败进入 `NEEDS_USER(handoff_export_failed)`，不自动重试。

### 5.4 Continuation Task

```text
CONTINUATION_STARTING:
  create second fresh task in the same workspace
  input exactly: one goal sentence with the Handoff Markdown absolute-path link, current_slice_id, optional commit, and checkpoint refresh
  provide the frozen synthesize-first consumer contract out of band
  acquire Project Write Lease(write_epoch)
  continue current_slice_id
  replace source_thread_id with continuation_task_id
```

Continuation Task 必须先读取 selected path 的 bounded UTF-8 Markdown，并在 read-only Turn 产出首份实质草案，再按允许的定向证据读取范围继续。只有任务创建成功、Handoff 可读且写租约取得后，状态才返回 `SLICE_RUNNING`。

一次成功接力后，只有出现新的 `compaction_id` 且期间已有持久进展，才允许再次进入本流程。这样不限制长任务的正常多次接力，同时禁止对同一压缩事件形成无限循环。

## 6. 模型路由

| 工作 | 模型策略 |
| --- | --- |
| Slice 开发 | `gpt-5.6-sol/max` |
| Continuation Task | `gpt-5.6-sol/max` |
| Compression Task | `gpt-5.6-sol/medium` |
| Controller、锁、Git、验证 | 不使用模型 |

策略不可满足时进入 `NEEDS_USER(model_policy_unavailable)`。不得选用近似模型或降低 reasoning effort。

### 6.1 内容盲控制边界

Controller 与 Production Orchestrator 必须是 Content-blind Controller：只接收任务身份、枚举状态、有序事件、时间戳和确定性回执。Worker Content 不得进入模型上下文、控制判断、持久 Run 状态、命令回执或日志。

App Server 传输若把控制事件与正文复用在同一帧流，Host Adapter 必须在 Controller port 之前按白名单投影并丢弃其余字段。禁止以 `thread/read(includeTurns=true)`、最终 agent 回复、reasoning、命令输出、diff 或普通静默作为控制输入。当前 Turn 的 Run/Slice/Thread/Turn 身份、回执摘要与结构化 `COMPLETED` 匹配，即构成 Trusted Completion；`FAILED`、`INTERRUPTED`、模型改道与协议错误仍失败闭合。

只有 Compaction Timeout 后的 Compression Task 可自动读取 Source Thread 正文。Host 无法在不返回完整 turns 的情况下提供稳定 persisted revision 时，以 `NEEDS_USER(source_interrupt_failed)` 失败闭合，不得降级为正文读取。

## 7. 工作区与提交

每个全新 Development Task 的首条输入只有一句 `设定goal`；Production Plan、契约、排除项和检查不会拼进该消息，具体工作以 checkpoint（接力时为 Handoff）为权威。Project Write Lease 继续保护同一 checkout 不被两个开发任务并发写入，但 Production Orchestrator 不检查任务写了哪些文件。

```text
after_slice:
  -> 设定goal：阅读checkpoint，实现<SliceId>，完成后commit，刷新checkpoint

none:
  -> 设定goal：阅读checkpoint，实现<SliceId>，完成后刷新checkpoint
```

`commit_mode` 与 Slice override 只在 `turn/start` 前决定提示文案；当前 Slice 已投递后拒绝 override。Controller 不运行 Git 命令，不读取 diff、HEAD、checkpoint 或 artifact，也不再次 commit、覆盖 checkpoint 或 push。无 commit、多 commit、额外文件、checkpoint 不存在或未变化都不阻断匹配的结构化 `COMPLETED`。

## 8. Slice 字段兼容边界

Production Plan V1 继续解析以下 Slice 字段，以兼容既有计划：

```text
SliceContract {
  slice_id
  objective
  exclusions[]
  owned_paths[]
  checks[]
  expected_artifacts[]
  commit_mode_override?
}
```

这些字段由 Development Task 的工程纪律使用，Production Orchestrator 对其保持惰性：不执行 `checks`，不读取或 hash `expected_artifacts`，不分类 `owned_paths`，也不建立 Protected Change 基线。历史 `SliceExecutor`、`SliceVerifier`、`GitGoalCompletionGuard` 与 CommitCoordinator 仍作为直接 API 和回归基线保留，不接入新 Production Run。

## 9. 错误闭合

| 错误 | 闭合行为 |
| --- | --- |
| `model_policy_unavailable` | 不启动或暂停当前工作，等待用户 |
| `project_lock_unavailable` | 不产生写入，等待或由用户终止 |
| `slice_execution_failed` | `FAILED`、`INTERRUPTED` 或身份/摘要不匹配时停止当前 Run，不启动下一 Slice |
| `compaction_probe_failed` | 保存白名单 reason code，不提高读取频率，等待用户 |
| `source_interrupt_failed` | 不创建新任务，保留 Source Thread |
| `handoff_export_failed` | 保留源与压缩诊断，不重试 |
| `handoff_integrity_failed` | 禁止创建 Continuation Task |
| `continuation_start_failed` | 保留 Handoff，等待用户重试或终止 |
| `protected_change_overlap` / `verification_failed` | 仅历史直接 API 与旧 Run 恢复目录保留；新 Production Run 不触发 |

`NEEDS_USER` 状态只保存白名单错误码、最后成功状态、相关任务 UUID、允许暴露的证据路径和确定性回执；不得保存 Worker Content 或原始进程输出。恢复操作必须显式指定处理方式。

## 10. 决策索引

- [本地控制器与任务隔离](adr/0001-local-controller-and-task-isolation.md)
- [确定性模型路由](adr/0002-deterministic-model-routing.md)
- [提交模式与 Checkpoint 顺序](adr/0003-commit-and-checkpoint-order.md)
- [Goal Task 输入与完成所有权](adr/0008-goal-task-input-and-finish-ownership.md)
- [自动压缩超时后的三任务接力](adr/0004-compaction-timeout-handoff.md)
- [内容盲控制面](adr/0009-content-blind-controller.md)
- [可信工作进程收口](adr/0010-trusted-worker-completion.md)

## 11. 设计验收条件

- 术语表中 Source、Compression、Continuation 三种任务零重叠；
- 30 秒超时可由持久事件和虚拟时钟确定性复现；
- 同一 `compaction_id` 无法创建两个 Compression Task；
- Source Thread 未收到停止回执时无法启动导出；
- Compression Task 无写租约且无法成为 Continuation Task；
- Handoff 未通过完整性校验时无法启动续接；
- Development、Compression、Continuation 三种新任务的首条输入均符合各自的一句话协议；
- 两刀结构化 `COMPLETED` 直接 `DONE`，状态链不出现历史验收三态；
- `FAILED` 与 `INTERRUPTED` 均进入 `NEEDS_USER`，下一 Slice 启动数为零；
- Controller 的模型上下文、持久状态、回执与日志均不含 Worker Content；
- Source 持久性核验不读取完整 turns，元数据 revision 不可用时失败闭合；
- 结构化压缩事件可用时正文 probe 为零；不可用时严格按 20/30/35/40/42... 分段探测；
- 普通完成与压缩接力均不调用 Git/workspace inspection，不读取 commit、checkpoint 或 artifacts；
- V1 旧字段与旧验收态可读取，但不参与新 Run 判断或恢复推进；
- 任一失败均闭合为可解释状态，不静默降级、不 push。
