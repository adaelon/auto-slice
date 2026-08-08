# 确定性模型路由

开发与续接固定使用 `gpt-5.6-sol/max`，压缩固定使用 `gpt-5.6-sol/medium`，Controller 与确定性验证不调用模型。策略不可用时进入 `NEEDS_USER(model_policy_unavailable)`，不得静默降级；该约束以可复现行为优先于临时可用性。
