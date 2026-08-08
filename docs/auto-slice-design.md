# Auto Slice 产品与架构契约

状态：设计冻结，可进入实现切片。术语以 [`CONTEXT.md`](../CONTEXT.md) 为准。

## 1. 产品边界

Auto Slice 是本地 Codex 插件及其持久化 Slice Controller。它接收一份已确认的 Slice 计划，在一个 Local checkout 中顺序执行、验证、提交或记录每个 Slice，并在 Codex 自动压缩无法完成时通过 Handoff 接力。

包含：

- 持久化 Run/Slice 状态机；
- 单工作区独占写租约；
- 确定性模型路由；
- Slice 验收、提交与 checkpoint 编排；
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
    evidence_index_path
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
  -> VERIFYING
  -> COMMITTING?          # 仅 after_slice
  -> CHECKPOINTING
  -> SLICE_RUNNING | DONE

任意可恢复状态 -> PAUSED
任意失败闭合   -> NEEDS_USER
用户终止       -> ABORTED
```

只有 `SLICE_RUNNING` 的当前任务可以持有 Project Write Lease。Compression Task 永远不取得写租约。

## 5. 自动压缩接力状态机

### 5.1 入口信号

Host Adapter 必须提供带稳定 `compaction_id` 的 `AUTO_COMPACTION_STARTED` 与 `AUTO_COMPACTION_COMPLETED`。缺少可观测信号时进入 `NEEDS_USER(compaction_observability_unavailable)`，不得用模型自述、日志文案猜测或普通静默时间代替。

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
  invoke export-codex-handoff(source_thread_id)
  require Markdown + Evidence Index atomic publication
  require verify-evidence == PASS
```

Compression Task 必须满足 `export-codex-handoff` 的 Isolation Gate：它不是 Source Thread，不带源历史副本，也不会继续源工作。每个 `compaction_id` 最多创建一次 Compression Task；失败进入 `NEEDS_USER(handoff_export_failed)`，不自动重试。

### 5.4 Continuation Task

```text
CONTINUATION_STARTING:
  create second fresh task in the same workspace
  provide verified Handoff path + consumer contract
  acquire Project Write Lease(write_epoch)
  continue current_slice_id
  replace source_thread_id with continuation_task_id
```

Continuation Task 必须先按 Handoff 的 Resume Policy 产出首份实质草案，再按允许的定向证据读取范围继续。只有任务创建成功、Handoff 校验通过且写租约取得后，状态才返回 `SLICE_RUNNING`。

一次成功接力后，只有出现新的 `compaction_id` 且期间已有持久进展，才允许再次进入本流程。这样不限制长任务的正常多次接力，同时禁止对同一压缩事件形成无限循环。

## 6. 模型路由

| 工作 | 模型策略 |
| --- | --- |
| Slice 开发 | `gpt-5.6-sol/max` |
| Continuation Task | `gpt-5.6-sol/max` |
| Compression Task | `gpt-5.6-sol/medium` |
| Controller、锁、Git、验证 | 不使用模型 |

策略不可满足时进入 `NEEDS_USER(model_policy_unavailable)`。不得选用近似模型或降低 reasoning effort。

## 7. 工作区与提交

Run 启动时记录 Protected Change 基线。Slice 只能声明并提交 Slice-owned changes；若改动与 Protected Change 重叠，进入 `NEEDS_USER(protected_change_overlap)`。

```text
after_slice:
  verify slice
  commit only slice-owned changes
  capture new HEAD
  rewrite SESSION_CHECKPOINT.md with new HEAD and next slice
  never push

none:
  verify slice
  record normalized slice-owned diff digest
  rewrite SESSION_CHECKPOINT.md with next slice
  never commit or push
```

checkpoint 刷新失败不得回滚已经成功的 Slice commit；Controller 记录 `NEEDS_USER(checkpoint_refresh_failed)` 和真实 HEAD。

## 8. Slice 验收

每个 Slice 必须声明：

```text
SliceContract {
  slice_id
  objective
  exclusions[]
  owned_paths[]
  deterministic_checks[]
  expected_artifacts[]
  commit_mode_override?
}
```

验收只接受测试 runner、编译器、linter、文件/摘要比对、Git 状态和真实工具回执。LLM 评价不得作为唯一通过条件。

## 9. 错误闭合

| 错误 | 闭合行为 |
| --- | --- |
| `model_policy_unavailable` | 不启动或暂停当前工作，等待用户 |
| `project_lock_unavailable` | 不产生写入，等待或由用户终止 |
| `compaction_observability_unavailable` | 不启动推测性 30 秒计时 |
| `source_interrupt_failed` | 不创建新任务，保留 Source Thread |
| `handoff_export_failed` | 保留源与压缩诊断，不重试 |
| `handoff_integrity_failed` | 禁止创建 Continuation Task |
| `continuation_start_failed` | 保留 Handoff，等待用户重试或终止 |
| `protected_change_overlap` | 禁止提交，等待用户划分所有权 |
| `verification_failed` | 保持当前 Slice，不提交、不前进 |

`NEEDS_USER` 状态必须保存原因、最后成功状态、相关任务 UUID、文件路径和确定性回执；恢复操作必须显式指定处理方式。

## 10. 决策索引

- [本地控制器与任务隔离](adr/0001-local-controller-and-task-isolation.md)
- [确定性模型路由](adr/0002-deterministic-model-routing.md)
- [提交模式与 Checkpoint 顺序](adr/0003-commit-and-checkpoint-order.md)
- [自动压缩超时后的三任务接力](adr/0004-compaction-timeout-handoff.md)

## 11. 设计验收条件

- 术语表中 Source、Compression、Continuation 三种任务零重叠；
- 30 秒超时可由持久事件和虚拟时钟确定性复现；
- 同一 `compaction_id` 无法创建两个 Compression Task；
- Source Thread 未收到停止回执时无法启动导出；
- Compression Task 无写租约且无法成为 Continuation Task；
- Handoff 未通过完整性校验时无法启动续接；
- `after_slice` 的 commit 始终先于 checkpoint；
- Protected Change 不会进入自动提交；
- 任一失败均闭合为可解释状态，不静默降级、不 push。
