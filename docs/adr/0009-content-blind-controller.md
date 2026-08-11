# 内容盲控制面

### §1 Worker 内容隔离

**决策**:Controller 只消费元数据；压缩正文探测隔离降级。

**否决**:
- 监督 Codex 常规读取 Worker Content：复制内容面并干扰工作进程。
- `thread/read(includeTurns=true)` 计算 revision：完整历史越过控制边界。
- 用正文判断进度或质量：把 Controller 重新变成工作内容审查者。

**命门**:结构化 `contextCompaction` 事件优先；不可用时仅在第 20、30、35、40 分钟及此后每 2 分钟探测，并只投影压缩枚举。Compression Task 仍可为 Handoff 读取 Source Thread。
**何时回头**:Host 的结构化压缩事件在全部支持环境稳定可用时删除正文降级探测。
**展开**:[实施切片方案](../切片方案-可信完成与低干扰监控.md)

### §2 Host 压缩能力声明

**决策**:Host 适配器显式声明压缩事件能力。

**否决**:
- 从 `userAgent` 或版本号推断：版本与实际能力可能漂移。
- 把握手无字段当作不可用：会让当前 App Server 无条件读取正文。

**命门**:当前 App Server adapter 默认声明事件可用；仅显式 `UNAVAILABLE` 启动注入的隔离 probe。
**何时回头**:App Server 握手发布服务端 capability 时改为读取官方字段。
**展开**:[实施切片方案](../切片方案-可信完成与低干扰监控.md)
