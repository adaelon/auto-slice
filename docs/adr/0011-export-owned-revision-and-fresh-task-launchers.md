# Export 单一 revision 与 App Server fresh-task 接力

状态：Accepted（2026-08-12，S17–S21 已实现；§5 由 S22 收敛）。取代 ADR-0008 的 Compression/Continuation 输入、`implementation-slices.md` 的 S15 双 revision 门禁，以及 ADR-0001 中把 App Server sandbox 与 Project Write Lease 混同的“Compression 始终只读”；保留 ADR-0004 的三任务隔离、ADR-0009 的 Content-blind Controller 和 ADR-0010 的 Trusted Completion。

### §1 Source Evidence Revision

**决策**:Export 独占 revision 权威。

**否决**:
- 中断前后各取 opaque revision：当前 Host 无可满足能力，形成启动死锁。
- 用 `updatedAt` 或 summary hash：不是 Source rollout 内容身份。
- 比较请求 token 与 export digest：`64-byte opaque` 和 `sha256:<64hex>` 不是同一契约。

**命门**:`SourceEvidenceRevision = /^sha256:[0-9a-f]{64}$/`；prepare 对 rollout 原始字节取 hash，publish 与 `verify-evidence` 都必须复核同值。
**何时回头**:export 工作流发布版本化、等价且可独立验证的新 revision 算法时。
**展开**:[实施切片方案](../切片方案-App-Server三任务接力解锁.md)

### §2 Source Interruption 证明

**决策**:中断只证明停止与可读。

**否决**:
- InterruptReceipt 携带 revision：把内容身份错误前置到控制面。
- `thread/read(includeTurns=true)`：越过 Content-blind Controller 边界。
- 把未收到 archive/delete 通知解释成 `archived:false/deleted:false`：连接建立前的负事实不可证明。

**命门**:`InterruptReceiptV2={thread_id,turn_id,terminal_status:"interrupted",execution_stopped:true,thread_persisted:true,observed_at}` 必须来自成功 `turn/interrupt` 后同 thread/turn 的 `turn/completed`；随后 `thread/read{includeTurns:false}` 只接受同 UUID、`ephemeral:false`、`turns:[]`，读取失败即闭合。
**何时回头**:不回头；内容身份始终属于 export 边界。
**展开**:[ADR-0009](0009-content-blind-controller.md)

### §3 Compression fresh thread

**决策**:Compression 只用 fresh root。

**否决**:
- `thread/resume`：复用 Source 或旧 Compression 历史。
- `thread/fork`：复制 Source 历史并破坏 Isolation Gate。

**命门**:`thread/start{model:"gpt-5.6-sol",cwd,approvalPolicy:"never",sandbox:"workspace-write",serviceName:"auto_slice_compression",ephemeral:false}`；响应必须满足 `sessionId===id`、`forkedFromId===null`、`parentThreadId===null`、`turns:[]`，且 UUID 与 Source 不同。
**何时回头**:App Server 提供语义等价、可证明空历史的稳定专用 task API 时。
**展开**:[OpenAI Docs: App Server](https://developers.openai.com/codex/app-server/)

### §4 Compression skill turn

**决策**:Skill item 不可省略。

**否决**:
- 仅发送 `$export-codex-handoff <UUID>`：依赖模型自行解析 skill 名。
- 只发送 skill item：丢失 skill 明确要求的 Source UUID 调用文本。
- 使用默认工作区输出名：同 Source 重试会撞旧文件并污染 Slice 工作区。

**命门**:先以 `skills/list{cwds:[cwd],forceReload:true}` 唯一解析 enabled skill，再由 Host 在 `Handoff Artifact Root` 分配两个不存在的 attempt 路径；`turn/start.input` 有序且恰为“含 UUID、`continuation-map-v2` 与两路径的冻结 text”＋解析出的 skill item，`workspaceWrite` 显式携带 `writableRoots`、`networkAccess:false`、两个 temp 排除位为 false。
**何时回头**:官方 skill invocation wire contract 发生版本化变更时。
**展开**:[OpenAI Docs: skill invocation](https://developers.openai.com/codex/app-server/#start-a-turn-invoke-a-skill)

### §5 Handoff Receipt

**决策**:Receipt 只取 completed Compression Turn 最终结果中的首个 Markdown 地址。

**否决**:
- prepare→Frame/MAP/REDUCE→publish 轨迹：实际技能会演化，不作为 receipt 模型。
- Evidence Index 与 `HANDOFF_VERIFY`：不向 path-only receipt 提供字段。
- 扫描默认 cwd 或“最新文件”：不是 completed Compression Turn 显式选择的结果。

**命门**:Host 只在已绑定 Compression Turn 为 completed 后，从其 bounded 最终 `agentMessage` 提取第一个绝对本地 Markdown 地址；schema 3 只绑定 Source/Compression task、Compression turn、该地址与 canonical receipt digest。Continuation 在首个 read-only Turn 前读取 bounded UTF-8 Markdown；helper 输出、Evidence Index、`HANDOFF_VERIFY` 与 Worker Content 均不进入 receipt。
**何时回头**:若 completed Compression Turn 不再是可信发布边界，先版本化签名 receipt，再扩展 Host 字段。
**展开**:[实施切片方案](../切片方案-App-Server三任务接力解锁.md)

### §6 Continuation fresh thread

**决策**:Continuation 采用双 turn。

**否决**:
- 复用 Source/Compression：任务身份和历史不隔离。
- 只传 Handoff 路径：无法确定性满足 synthesize-first 的首个无工具草案。
- 用 `turn/steer` 授权写入：官方契约不接受 sandbox override。
- 从模型自报 JSON 构造 ReadyReceipt：不能证明草案先于工具或写入。

**命门**:先以 `thread/start{sandbox:"read-only",ephemeral:false}` 创建第三个 root UUID，再以两个 text item 传 bounded goal＋已验证 Handoff 正文；私有事件投影必须证明第一 Turn terminal、首份实质 `agentMessage` 先于任何工具/写 item。之后才以完整 `workspaceWrite` policy 启动第二 Turn，并绑定同一 Slice 与新 write epoch。
**何时回头**:App Server 支持可审计的 turn 内权限升级时。
**展开**:[实施切片方案](../切片方案-App-Server三任务接力解锁.md)

### §7 协议事实层级

**决策**:官方语义与本机 schema 分层。

**否决**:
- 把官方示例当完整 schema：示例允许省略默认字段。
- 凭记忆兼容未来 CLI：会静默发送错误 enum 或 input variant。

**命门**:官方文档固定方法语义；精确字段以 `codex-cli 0.146.0` 的 `generate-ts`/`generate-json-schema` 为准，投影必须覆盖 thread/turn、`skills/list`、sandbox、completed item/command/agent message 与 terminal notification；版本或投影漂移时在创建任务前失败。
**何时回头**:升级 Codex CLI 时重新生成、审查并更新契约夹具。
**展开**:[OpenAI Docs: generated schemas](https://developers.openai.com/codex/app-server/#message-schema)

### §8 私有事件路由

**决策**:Launcher 内容与 Controller 信号分流。

**否决**:
- 让现有 Controller firewall 解析 publish/draft 正文：破坏 Content-blind 边界。
- 把所有 raw App Server notification 广播给 launcher：跨 thread/turn 泄漏且无法有界。

**命门**:单一初始化连接先按已注册 thread/turn demux；Controller 只收现有无正文投影，私有 launcher projector 只收其任务所需且有大小上限的 completed item。turn 注册状态机允许“一个 active turn → terminal → 下一个 turn”，拒绝并发、迟到和交叉事件；raw 内容不进 RunStore、日志或错误文本。
**何时回头**:App Server 提供原生、带任务作用域的独立订阅通道时。
**展开**:[实施切片方案](../切片方案-App-Server三任务接力解锁.md)

### §9 生产可用证明

**决策**:Hermetic 与 live 两层验收。

**否决**:
- 只用回显型 fake launcher：重现不了真实 App Server 或 export 边界。
- 只跑真实用户 Source：验收失败会污染或阻塞用户工作。

**命门**:先以 fake App Server＋真实 helper fixture 锁定故障矩阵，再以本机 0.146.0 App Server 和 disposable workspace 跑真实三 root、interrupt/read、skill turn、publish/verify 与 Continuation 双 Turn；两层未同时 PASS 前默认生产链不得宣称解锁，`PROVIDER_TIMING_UNAVAILABLE` 只能报告为 blocker。
**何时回头**:App Server 或 export workflow 版本变化时重跑两层。
**展开**:[实施切片方案](../切片方案-App-Server三任务接力解锁.md)
