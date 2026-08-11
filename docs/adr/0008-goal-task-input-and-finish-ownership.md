# Goal Task 输入与完成所有权

状态：一句话输入继续有效；Controller 验收部分由 [ADR-0010](0010-trusted-worker-completion.md) 取代。

### §1 一句话启动与任务侧收口

**决策**:Development Task 只接收一句 `设定goal`，并自行负责全部收口。

**否决**:
- 在首条消息嵌入 Production Plan、Slice contract 或 controller invariants：重复 checkpoint/Handoff 权威并污染任务输入。
- Controller 再次 commit 或重写 checkpoint：与 goal 的完成条件重复，且会覆盖任务留下的接续信息。

**命门**:`commit_mode` 只改变 Goal Prompt；Controller 不核验 commit、HEAD 或 checkpoint。

**何时回头**:Codex 提供可直接创建 goal 且能原子附带 checkpoint/Handoff 引用的稳定宿主 API 时。

开发输入固定为 `设定goal：阅读checkpoint，实现Sx，完成后[commit，]刷新checkpoint`；压缩输入固定为 `$export-codex-handoff <UUID>`；接力输入固定为“设定 goal、阅读 Handoff Markdown 绝对路径链接、继续实现 Sx、完成后可选 commit 并刷新 checkpoint”的一句话。
