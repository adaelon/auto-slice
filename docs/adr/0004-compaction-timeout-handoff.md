# 自动压缩超时后的三任务接力

Source Thread 的自动压缩持续 30 秒仍未完成时，Controller 中断其当前执行但保留线程与 UUID，随后依次创建专用 Compression Task 运行 `export-codex-handoff`、再创建独立 Continuation Task 消费产物。每个压缩事件只允许一次该接力尝试，失败即进入 `NEEDS_USER`；不重试平台自动压缩，也不让压缩任务继续源工作。
