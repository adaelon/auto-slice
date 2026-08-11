# Codex App Server 生产适配器

### §1 结构化任务事件

**决策**:生产任务使用 App Server stdio 事件流。

**否决**:
- Codex SDK：公开契约未暴露自动压缩生命周期。
- `codex exec --json`：公开事件集未包含 `contextCompaction`。

**命门**:只接受权威 `contextCompaction` item 生命周期，模型 reroute 立即失败闭合。
**何时回头**:SDK 提供稳定压缩事件和线程中断/读取回执时。
**展开**:[OpenAI App Server 文档](https://developers.openai.com/codex/app-server/)
