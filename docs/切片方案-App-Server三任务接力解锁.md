# App Server 三任务接力解锁切片方案

> 状态：Implementation in progress（2026-08-11，S17 已完成并由 `verify:s17` 锁定，下一刀 S18）。S15/S16 的回执保留为历史证据，但不再代表真实三任务链可用。
> 权威边界：[`CONTEXT.md`](../CONTEXT.md)、[ADR-0011](adr/0011-export-owned-revision-and-fresh-task-launchers.md)、[OpenAI Docs: Codex App Server](https://developers.openai.com/codex/app-server/)。

## 目标与排除

**做**:

- 删除 Source Interruption 的 revision 前置门禁，只证明 Turn 已停且 Source Thread 仍持久可读。
- 让 `export-codex-handoff` 成为 `Source Evidence Revision` 的唯一签发者和发布前复核者。
- 用真实 App Server `thread/start`/`turn/start` 实现 Compression 与 Continuation launcher。
- 从 export 机器输出、发布字节和 `verify-evidence` 构造可信 `Handoff Receipt`。
- 用默认生产 Host 证明 Source → Compression → Continuation，无注入 revision provider 或内存 launcher。

**不做**:

- 不改变 30 秒 Compaction Timeout、模型路由、Trusted Completion 或 Content-blind Controller。
- 不恢复 Controller 对 Source turns、Git、diff、checkpoint 或工作质量的读取。
- 不修改 `export-codex-handoff` skill 的算法、预算、Isolation Gate 或发布事务。
- 不把 S15/S16 历史回执删除、重写成成功，或用新语义解释旧 `"a".repeat(64)` 夹具。
- 不在本方案落档切片中启动生产 Run、执行 Handoff 导出或修改生产代码。

## 已证实故障链

~~~text
turn/interrupt -> structured terminal
  -> CodexAppServerDevelopmentTask.interrupt()
  -> FAIL_CLOSED_THREAD_REVISION_PROVIDER.read() = UNAVAILABLE
  -> NEEDS_USER(source_interrupt_failed/thread_revision_unavailable)
  -> CompressionTaskLauncher.start() 调用数 = 0
~~~

即使注入 provider，现有链仍有四个不可接受点：

1. `OpaqueStableRevision` 要求 64 UTF-8 bytes，而 export 生成 `sha256:<64 lowercase hex>`。
2. `CompressionRequest.source_persisted_revision` 被内存 launcher 原样回显成 Evidence revision。
3. 默认 `CodexAppServerTaskHost` 的 Compression/Continuation launcher 都是 fail-closed 占位符。
4. Compression `turn/start.input` 只有 text，没有官方要求的 skill item；S16 fake launcher 不创建线程、不执行 skill。

另有一个 0.146.0 wire 差异必须一并锁定：`ThreadReadResponse.thread.turns` 在生成类型中始终存在；`includeTurns:false` 应接受 `turns:[]`，只拒绝非空 turns/items，不能因空数组字段存在而拒绝真实响应。

## 问题闭合矩阵

| 已证实断裂 | 文档决策 | 实现切片 | 不得冒充成功的旧证据 |
| --- | --- | --- | --- |
| revision provider 缺失导致 Compression 调用数为零 | revision 只归 export；interruption 无 revision | S18 | S15 注入 provider |
| opaque 64 bytes 与 `sha256:<64hex>` 必然 mismatch | 删除双 revision 比较；receipt 只验 export revision | S18、S20 | request revision 回显 |
| 默认 Host 没有真实 launcher | fresh-root session 基座＋两个真实 launcher | S19–S21 | fail-closed 占位符 |
| Compression 只有 text、没有 skill item | `skills/list` 唯一解析＋text/skill 双 item | S17、S20 | fake launcher prompt 断言 |
| Controller firewall 丢弃 receipt/draft 所需 item | Controller/launcher 私有事件分流 | S17、S19–S21 | 模型 final reply |
| 默认输出名不可安全重试 | Host 预分配 Run/Slice/attempt 双路径 | S20 | 工作区根目录旧 Handoff |
| fake 链遮住真实 App Server/skill/export 行为 | hermetic＋本机 disposable live 两层验收 | S22 | 仅 fake E2E |

本方案不关闭 Codex 自动压缩；它解决的是自动压缩超过 30 秒未完成后的确定性退出与三任务接力。若真实 `turn/interrupt` 无法使卡住的 Turn 产生相关 `interrupted` 终态，链路会有界失败并保留诊断，不能宣称恢复成功。

## 协议事实分层

| 层级 | 已冻结事实 | 验证方式 |
| --- | --- | --- |
| OpenAI Docs | `thread/start` 创建新 conversation；`turn/start` 启动 Turn；显式 skill 调用同时发送 `$<skill-name>` text 与 `skill` item；`skills/list` 可按 cwd 强制刷新 | 官方 App Server 页面 |
| 本机版本事实 | `codex-cli 0.146.0`；`ThreadStartParams.sandbox` 为 kebab-case；`TurnStartParams.sandboxPolicy.type` 为 camelCase tagged enum；text 的 `text_elements`、workspaceWrite 的两个 temp 排除位在生成 TS 中必填；completed item 暴露 command/agent message 机器字段 | `codex app-server generate-ts/json-schema` |
| export workflow 事实 | rollout 原始字节 hash 为 `sha256:<64hex>`；publish 前复核 Source；输出双文件事务；成功后仍须 `verify-evidence` | 本机 `export-codex-handoff` skill/helper |
| 仓库契约 | 只采用下文列出的最小字段投影；未知或漂移字段不静默猜测 | S17 schema projection test |

官方示例可证明方法语义，但不是 0.146.0 的完整字段清单。本方案中的 exact wire shapes 以本机生成 schema 为准；升级 CLI 必须先重生成契约夹具。

## 冻结数据流

~~~mermaid
flowchart TD
  Timeout["Compaction Timeout"] --> Interrupt["turn/interrupt + terminal event"]
  Interrupt --> Summary["thread/read(includeTurns=false)<br/>same id, persistent, turns=[]"]
  Summary --> Resolve["skills/list + allocate attempt paths"]
  Resolve --> CThread["thread/start<br/>fresh Compression root"]
  CThread --> CTurn["turn/start<br/>frozen text + export skill item"]
  CTurn --> Prepare["export prepare<br/>hash raw Source rollout"]
  Prepare --> Publish["publish rechecks Source<br/>atomically writes Handoff pair"]
  Publish --> PrivateRoute["private item projector<br/>binds helper command evidence"]
  PrivateRoute --> Receipt["Host verifies paths + bytes + verify-evidence<br/>builds HandoffReceiptV2"]
  Receipt --> KThread["thread/start<br/>fresh Continuation root"]
  KThread --> Draft["turn/start readOnly<br/>goal + verified Handoff body"]
  Draft --> Grant["second turn/start workspaceWrite<br/>new write epoch"]
  Grant --> Running["same Slice resumes"]
~~~

单一 App Server 连接先按已注册 thread/turn 分流：Controller firewall 只接收身份、枚举状态、时间和 digest；Compression/Continuation 的私有 projector 只接收各自所需、大小受限的 completed item。Source/Handoff 正文和 raw notification 不能进入 RunStore、错误文本、Controller listener 或日志。

## 精确 App Server 请求

### 0. Skill 与发布目标预解析

Host 在创建 Compression Task 前执行：

~~~text
skills/list { cwds:[SourceCwd], forceReload:true }
  -> 对该 cwd 恰有一个 name="export-codex-handoff"、enabled=true 的 skill
  -> skill.path 为存在的 absolute native SKILL.md，且解析后仍位于该 skill 目录

artifactRoot = <configured storage root>/handoffs/<run_id>/<slice_id>/<attempt_id>
markdownPath = artifactRoot/handoff-<source_thread_id>.md
evidenceIndexPath = artifactRoot/handoff-<source_thread_id>.evidence.json
~~~

`attempt_id` 必须由 launcher journal 持久绑定 `effect idempotency key + attempt_number`；两个目标在 Turn 启动前都不得存在，父目录与最终文件均拒绝 symlink/reparse-point 逃逸。已完成 effect 的重放只复用已验证 receipt，不重新调用 skill；未完成 attempt 遗留的任何文件都原地保留诊断，重试先持久增加 attempt number、再使用新目录，绝不覆盖或“认领”旧产物。

### 1. Compression `thread/start`

~~~json
{
  "model": "gpt-5.6-sol",
  "cwd": "<SourceCwd absolute native path>",
  "approvalPolicy": "never",
  "sandbox": "workspace-write",
  "serviceName": "auto_slice_compression",
  "ephemeral": false
}
~~~

只调用 `thread/start`，禁止 `thread/resume`/`thread/fork`。响应必须满足：

~~~text
thread.id = canonical UUID
thread.id != source_thread_id
thread.sessionId == thread.id
thread.forkedFromId == null
thread.parentThreadId == null
thread.ephemeral == false
thread.turns == []
~~~

`sandbox:"workspace-write"` 是 export 发布 Handoff 的 OS 执行能力；`project_write_lease:false` 仍表示它无权继续 Slice 开发。Source 写租约在此阶段保持 frozen，Continuation 尚未创建。

### 2. Compression `turn/start`

~~~json
{
  "threadId": "<compression_task_id>",
  "input": [
    {
      "type": "text",
      "text": "$export-codex-handoff <source_thread_id> Use continuation-map-v2. Publish the Handoff Markdown to <JSON-encoded markdownPath> and the Evidence Index to <JSON-encoded evidenceIndexPath>.",
      "text_elements": []
    },
    {
      "type": "skill",
      "name": "export-codex-handoff",
      "path": "<absolute native path to export-codex-handoff/SKILL.md>"
    }
  ],
  "cwd": "<SourceCwd absolute native path>",
  "approvalPolicy": "never",
  "sandboxPolicy": {
    "type": "workspaceWrite",
    "writableRoots": ["<HandoffArtifactRoot absolute native path>"],
    "networkAccess": false,
    "excludeTmpdirEnvVar": false,
    "excludeSlashTmp": false
  },
  "model": "gpt-5.6-sol",
  "effort": "medium"
}
~~~

两个 input item 的次序、数量、discriminant、skill name、Source UUID、workflow mode、两个 JSON 编码路径和 canonical skill path 都是契约。`text_elements:[]` 与 workspaceWrite 的完整五字段显式满足 0.146.0 生成 TypeScript 类型；JSON Schema 的默认值不作为发送方假设。Host 必须核对 publish 返回路径逐字解析到预分配文件，不能接受 skill 回退到 cwd 默认输出名。

### 3. Continuation 初始请求

`thread/start` 使用相同 fresh-root 证明，但固定：

~~~json
{
  "model": "gpt-5.6-sol",
  "cwd": "<SourceCwd absolute native path>",
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "serviceName": "auto_slice_continuation",
  "ephemeral": false
}
~~~

第一个 `turn/start.input` 有序且恰为两个 text item，二者都显式携带 `text_elements:[]`：

1. bounded goal：绑定 Run/Slice、consumer contract digest 与 Handoff digest，只产出首份实质草案，本 Turn 禁止工具和写入；
2. 已从预分配路径读取、按 `handoff_digest` 重验的 Handoff Markdown 完整正文，并用固定 data boundary 包裹。

~~~json
{
  "threadId": "<continuation_task_id>",
  "input": [
    {"type":"text","text":"<bounded synthesize-first goal>","text_elements":[]},
    {"type":"text","text":"<BEGIN VERIFIED HANDOFF>\n<exact Markdown bytes decoded as UTF-8>\n<END VERIFIED HANDOFF>","text_elements":[]}
  ],
  "cwd": "<SourceCwd absolute native path>",
  "approvalPolicy": "never",
  "sandboxPolicy": {"type":"readOnly","networkAccess":false},
  "model": "gpt-5.6-sol",
  "effort": "max"
}
~~~

这样 synthesize-first 不依赖任务先用工具读取路径，也不把 Source 原历史复制进新 Thread。ReadyReceipt 只能由私有 projector 的实际 item 顺序生成：记录首个非空 `agentMessage` 的字节 digest、其前方 command/fileChange/MCP/webSearch/collab item 数为 0、第一 Turn `completed` terminal 与 bounded event-projection digest；模型回复中的计数、digest 或“ready”声明都不是证据。

ReadyReceipt 验证通过后，`grantWrite(task_id, epoch)` 必须等第一 Turn terminal，再发送第二个 `turn/start`；禁止 `turn/steer`：

~~~json
{
  "threadId": "<continuation_task_id>",
  "input": [{"type":"text","text":"<bounded continue-same-Slice prompt bound to write_epoch>","text_elements":[]}],
  "cwd": "<SourceCwd absolute native path>",
  "approvalPolicy": "never",
  "sandboxPolicy": {
    "type":"workspaceWrite",
    "writableRoots":[],
    "networkAccess":false,
    "excludeTmpdirEnvVar":false,
    "excludeSlashTmp":false
  },
  "model":"gpt-5.6-sol",
  "effort":"max"
}
~~~

私有 router 的注册状态机必须先看到第一 Turn terminal，才允许为同一 thread 注册第二 Turn；并发第二 Turn、第一 Turn 迟到 item 或交叉 thread event 全部 fail closed。第二 Turn start 成功只证明 App Server 接受写 sandbox；Project Write Lease 的 `lease_id/write_epoch` 仍由现有 WorkspaceGuard 与 LeaseReceipt 绑定。

## Source 与 Handoff 契约

~~~typescript
type SourceEvidenceRevision = string; // /^sha256:[0-9a-f]{64}$/

interface InterruptReceiptV2 {
  thread_id: string;
  turn_id: string;
  terminal_status: "interrupted";
  execution_stopped: true;
  thread_persisted: true;
  observed_at: IsoTimestamp;
}

interface ThreadInspectionV2 {
  thread_id: string;
  readable: true;
  persistent: true;
  observed_at: IsoTimestamp;
}
~~~

两个结构都没有 revision。`turn/interrupt` 成功响应本身不足以签发 receipt，必须再收到同 thread/turn 的 `turn/completed.status="interrupted"`。`thread/read(includeTurns:false)` 的成功、相同 UUID、`ephemeral:false` 与空 turns 共同支持 `ThreadInspectionV2`；读取失败或已观测 delete 事件直接失败，archive/closed 本身不否定持久可读性，“未观测事件”也不被伪装成任何负证明。

~~~typescript
interface HandoffReceiptV2 {
  receipt_schema_version: 2;
  compression_task_id: string;
  compression_turn_id: string;
  source_thread_id: string;
  workflow_version: 2;
  markdown_path: AbsolutePath;
  evidence_index_path: AbsolutePath;
  source_revision: SourceEvidenceRevision;
  structural_digest: Sha256Digest;
  handoff_digest: Sha256Digest;
  evidence_index_digest: Sha256Digest;
  verify_evidence: "PASS";
  verify_evidence_result_digest: Sha256Digest;
  consumer_contract: SynthesizeFirstConsumerContract;
  artifact_digest: Sha256Digest;
  retained_work_dir?: AbsolutePath;
}
~~~

Receipt builder 的唯一输入是：

1. 私有 projector 从已注册 Compression thread/turn 收到的有序 completed command 证明；每项都必须为 `commandExecution`、`source:"agent"`、`status:"completed"`、`exitCode:0`、`cwd===SourceCwd`，command 不得含管道、重定向或第二命令；
2. 第一项 command 解析后恰为 canonical `node`＋canonical helper＋`prepare <source_thread_id> --map-result-mode continuation-map-v2 --output <markdownPath> --evidence-index <evidenceIndexPath>`；其单一 JSON（不超过 App Server message cap）的 `formatVersion/sessionId/sourceCwd/outputPath/evidenceIndexPath/mapResultMode/sourceRevision/workDir` 必须匹配请求，且 workDir 位于 helper 管理的临时根；
3. 后续唯一 publish command 解析后恰为同一 helper 的 `publish <same workDir>`；其不超过 64 KiB 的单一 JSON提供 `formatVersion/sessionId/outputPath/evidenceIndexPath/sourceRevision/structuralDigest/handoffDigest/evidenceIndexDigest/consumerContract`，并与 prepare 完全同源；
4. effect 绑定的 artifactRoot、attempt_id 与预分配双路径，以及重新读取的双文件原始字节及其 digest；
5. launcher 以 `spawn(shell:false)` 直接执行同一 canonical helper 的 `verify-evidence <evidenceIndexPath>`，得到的 exit code 0、`valid:true` 单一 JSON及其 canonical digest。

必须满足 `publish.sessionId == source_thread_id`、返回路径等于预分配路径，且 publish、Evidence Index、`verify-evidence` 的 Source revision 三者完全相等。`verify_evidence_result_digest=sha256(canonical-json(verify JSON))`；`artifact_digest=sha256(canonical-json(receipt without artifact_digest))`。模型 final message、CompressionRequest、测试常量和非 helper command 输出一律不能补字段。现有无真实来源的 `frame_digest` 从 V2 receipt 删除；需要 Compression Frame 身份时使用 publish 的 `structural_digest`。旧 `workflow_version:"v2"` receipt 只保留历史解码，不得升级解释成 `receipt_schema_version:2`。

## 切片依赖

~~~text
S17 App Server 0.146.0 最小 schema 投影
  ├─> S18 export-owned revision 迁移
  └─> S19 fresh-task session 基座

S18 + S19 -> S20 真实 Compression launcher 与 receipt builder
S20       -> S21 真实 Continuation launcher
S20 + S21 -> S22 默认生产链端到端验收
~~~

每刀完成必须 build、typecheck、目标测试、全量 tests、lint 和 Markdown links 全绿；不得把相邻重构混入功能切片。

## S17 · App Server 0.146.0 最小 schema 投影

- **做**：从本机生成 schema 冻结 `ThreadStartParams/Response.Thread`、`ThreadReadParams/Response`、`SkillsListParams/Response.SkillMetadata`、`TurnStartParams.UserInput/SandboxPolicy`、`ItemStarted/CompletedNotification.ThreadItem` 中的 command/agent/tool variants、`TurnCompletedNotification` 的最小 codec 与 fixture；增加可重跑的 schema projection verifier。
- **不做**：不改变任何任务生命周期，不实现 launcher，不 vendoring 全量 600+ 类型。
- **判据**：verifier 对 0.146.0 生成物 PASS；kebab/camel sandbox enum、缺 `text_elements`、workspaceWrite 缺两个 temp 排除位、缺 skill item、ambiguous/disabled skill、非空 fresh turns、缺 completed command 证明、未知 required variant 分别红测；无 Codex binary 时显式 SKIP 只允许普通 unit test，release verifier 必须 FAIL。
- **触达**：新增 `production/app-server-protocol-v2.ts`、最小 schema fixture、协议测试与 `verify-s17`；不改 Controller state。
- **落盘**：schema projection digest、CLI executable identity/version、生成命令、官方事实链接和契约报告。

## S18 · Export-owned revision 迁移

- **状态**：COMPLETE；证据见 `contracts/slices/S18.json` 与 `artifacts/s18/completion-receipt.json`。
- **做**：删除 `ThreadRevisionProvider`、`OpaqueStableRevision`、`THREAD_REVISION_UNAVAILABLE`、两次读取/比较和 `CompressionRequest.source_persisted_revision`；把 Interrupt/Inspection codec 切换到无 revision、绑定 thread/turn interrupted terminal 的本方案类型。
- **不做**：不创建 Compression Task，不改 export skill，不改 Compaction Timeout。
- **判据**：默认 Host 只在 `turn/interrupt` 成功且同 thread/turn `turn/completed.status="interrupted"` 后进入 `HANDOFF_EXPORTING`；`thread/read` 只发 `includeTurns:false`，接受 `turns:[]`、拒绝非空 turns/items；inspection 不再伪造 archived/deleted false；新 state schema 除历史文档/只读兼容 fixture 外零生产 `persisted_revision`，旧完成回执不改写，旧版在途 interruption 明确进入 migration-required `NEEDS_USER` 而不套用新语义。
- **触达**：`thread-control/*`、Development Task adapter、handoff request/type、相关 state replay 与测试。
- **失败闭合**：interrupt terminal 缺失、thread/read 失败、UUID/持久性/delete 异常仍为 `NEEDS_USER(source_interrupt_failed)`；archive/closed 只由实际 read 结果裁决；revision unavailable/mismatch 原因从新路径删除。

## S19 · Fresh-task App Server session 基座

- **做**：让 Task Host 持有一个初始化后的 App Server client；在 raw notification 入口按注册 thread/turn 分流为既有 Controller firewall 与私有 launcher projector，新增只负责 `thread/start`、fresh-root 证明、顺序 turn 注册/终态等待和 bounded completed-item projection 的 session 基座。
- **不做**：不注入 export skill，不构造 HandoffReceipt，不授权 Continuation 写入。
- **判据**：同连接顺序创建三个 distinct root UUID；状态机允许 `TURN_ACTIVE -> TURN_TERMINAL -> TURN_ACTIVE`，拒绝两个 active Turn、迟到 item、resume/fork、ephemeral、parent/fork id、非空 history 和交叉 thread/turn event；Controller listener、RunStore、日志与错误详情零 raw content；dispose 只关闭一次 client。
- **触达**：`app-server-client.ts`、HostEventFirewall 边界、`codex-app-server-task-host.ts`、新增 private event router/session launcher module 与 fake App Server tests。
- **落盘**：Source terminal 后仍可创建 fresh Compression/Continuation session 的协议轨迹。

## S20 · 真实 Compression launcher 与可信 receipt

- **做**：实现默认 `AppServerCompressionTaskLauncher`；以 `skills/list` 唯一解析 skill，在 effect 绑定的 `Handoff Artifact Root` 分配新 attempt 双路径，按 exact wire 发送含 UUID/mode/路径的 text＋skill item；等待 Compression Turn terminal；只从同 Turn 已绑定的 prepare/publish completed command 链、预分配路径、双文件和 Host 独立 `verify-evidence` 构造 `HandoffReceiptV2`。
- **不做**：不解析模型 final reply，不回显请求 revision，不修改 Continuation coordinator。
- **判据**：默认 Host 不再返回“no production Compression Task launcher”；fake Host 精确看到 `skills/list`、两项 input 和完整 workspaceWrite policy；真实 helper fixture 的 prepare→publish 链产生 `sha256:<64hex>` receipt；同 effect 重放不再运行 skill；缺/重复/乱序 prepare、workDir 替换、旧文件碰撞、symlink/reparse escape、默认 cwd 输出、组合 shell command、echo/fake frame/final-message 攻击、SOURCE_CHANGED、单文件发布、digest/path/consumer contract 篡改全部失败。
- **触达**：`handoff/*`、Task Host composition、prompt/skill path resolver、Compression launcher tests、真实 export fixture verifier。
- **失败闭合**：skill path 非唯一、artifact allocation、worker capacity、budget、turn failure、publish command/JSON 超限/多份/缺失映射为 `handoff_export_failed`；路径、文件身份、产物或验证不一致映射为 `handoff_integrity_failed`，保留 managed workDir 诊断。

## S21 · 真实 Continuation launcher

- **做**：实现默认 `AppServerContinuationLauncher`；fresh read-only root 的第一 Turn 接收两个带 `text_elements:[]` 的 goal＋已验证 Handoff 正文 item；私有 projector 从 completed item 顺序确定性生成 ReadyReceipt；第一 Turn terminal 后以完整 workspaceWrite policy 启动第二 Turn、承接 write epoch，并从终态生成 ProgressReceipt。
- **不做**：不复用 Source/Compression，不用 `turn/steer` 升权，不让 Controller 读取 Handoff/Worker 正文。
- **判据**：三 UUID 两两不同；首 Turn 的第一份实质 `agentMessage` 在任何 command/fileChange/MCP/webSearch/collab item 之前并产生 draft digest，ReadyReceipt 不取模型自报字段；Handoff 字节与 receipt 不符时 turn/start 调用数为零；Ready 前 workspaceWrite 为零；第一 Turn 未 terminal 时第二 Turn 调用数为零；第二 Turn 精确使用完整 workspaceWrite/max；失败后旧 Source lease 不恢复。
- **触达**：`continuation/*`、Task Host composition、Continuation prompt builder、event projector 与集成测试。
- **失败闭合**：fresh-root、Handoff 注入、Ready、第二 Turn start、lease/progress 任一步失败均进入既有 `continuation_start_failed` 或 `handoff_integrity_failed`。

## S22 · 默认生产链验收与文档收口

- **做**：先用未注入 revision provider/launcher 的默认 `CodexAppServerTaskHost` 跑 30 秒超时 hermetic 场景，fake App Server 执行真实 export helper fixture 并返回真实 publish items；再以本机 0.146.0 App Server、disposable workspace/Source 跑真实 interrupt/read、Compression skill publish/verify 与 Continuation 双 Turn live canary；更新架构、代码链路、切片契约和 release checklist。
- **不做**：不启动用户真实 Source Run，不连接远端，不把 fixture 成功宣称为模型语义质量验收。
- **判据**：hermetic 与 live 轨迹都严格为 Source interrupt/read → Compression skills/list/thread/start/turn/start → export prepare/publish/verify → Continuation thread/start/两次 turn/start；三个 UUID distinct；Source revision 在 interruption/request 中不存在、只从 Compression 私有 prepare 输出开始出现并由 publish/verify 复核；分别发布 `HERMETIC_CHAIN_PASS` 与 `LIVE_CHAIN_PASS`，两者齐全后默认链才返回 `PRODUCTION_CONTINUATION_STARTED`。
- **触达**：`contracts/slices/S17-S22.json`、fake App Server/process harness、`verify-s17..s22`、`docs/架构.md`、`docs/代码链路.md` 和发布证据。
- **回归门禁**：短/大 Worker Content 的 Controller 投影仍等价，canary 零泄漏；live canary 的 `PROVIDER_TIMING_UNAVAILABLE`、worker 不可用或 600 秒预算失败只能发布 blocker、不得降级成 PASS；S01-S16 verifier、build/typecheck/tests/lint/Markdown links 全绿。

## 验收矩阵

| 场景 | 必须结果 |
| --- | --- |
| 默认 Host + timeout | 不再因 revision provider 缺失进入 NEEDS_USER |
| interrupt terminal + readable Source | 同 thread/turn 的 interrupted terminal；无 revision 字段，进入 HANDOFF_EXPORTING |
| summary 含 `turns:[]` | 接受；Controller 不读取内容 |
| summary 含非空 turns/items | `source_interrupt_failed`，Compression 未创建 |
| archive/closed/delete 生命周期 | 不从“未收到通知”伪造；archive/closed 后 read 成功仍可继续，delete 或 read 失败才闭合 |
| skill resolution | `skills/list` 对 SourceCwd 强制刷新且恰有一个 enabled canonical path |
| Compression start | fresh root、persistent、与 Source UUID 不同 |
| Compression input | exact UUID/mode/双路径 text item + exact skill item + 完整 workspaceWrite policy |
| Handoff targets | effect 绑定的新 attempt 目录；拒绝覆盖、默认 cwd 输出和路径逃逸 |
| helper command chain | 同 Compression thread/turn 的唯一有序 direct prepare→publish，same workDir，exit 0 |
| Source revision | interruption/request 中不存在；prepare 首次签发 canonical `sha256:<64 lowercase hex>`，publish/verify 复核 |
| publish 前 Source 变化 | export `SOURCE_CHANGED`，无 HandoffReceipt |
| fake/echo receipt | `handoff_integrity_failed` |
| Continuation first Turn | fresh read-only root，goal＋verified Handoff body |
| Ready evidence | 首份实质 agentMessage 先于所有工具/write item；不读模型自报 JSON |
| write grant | 第一 Turn terminal 后的第二 `turn/start`，不是 `turn/steer` |
| event isolation | Controller/RunStore/log 零 raw content；launcher projector 有 thread/turn/size 边界 |
| 完整接力 | Source/Compression/Continuation UUID 两两不同，回到同一 Slice |
| CLI schema drift | 创建任何 Compression/Continuation Task 前 fail closed |
| 生产解锁 | `HERMETIC_CHAIN_PASS` 与本机 disposable `LIVE_CHAIN_PASS` 同时存在 |

## 领域对齐完成

`Source Interruption`、`Source Evidence Revision`、`Compression Task`、`Handoff Artifact Root`、`Handoff Receipt` 和 `Continuation Task` 已在 `CONTEXT.md` 对齐；ADR-0011 与本方案零 unresolved 术语。假设：Compression 的 App Server workspace-write 只承担 export 临时目录与 Handoff Artifact Root 的管理型发布，而 Project Write Lease 继续独占 Slice 开发权；若未来要把 OS 读权限也收敛为路径级能力，应另立 sandbox/permission-profile ADR，不在这些修复切片中暗改。
