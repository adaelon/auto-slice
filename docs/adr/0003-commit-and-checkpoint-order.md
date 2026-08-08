# 提交模式与 Checkpoint 顺序

每个 Auto Slice Run 启动时选择 `commit_mode=after_slice|none`，允许 Slice 显式覆盖，但永不自动 push。`after_slice` 仅在验收通过后提交 Slice-owned changes，再刷新 `SESSION_CHECKPOINT.md` 记录新 HEAD；`none` 记录工作区差异摘要后刷新 checkpoint，以避免 checkpoint 指向尚未形成的提交。
