# Handoff 2026-08-17

## 目标

只在本仓库把现有测试策略和 shadow ledger 发展为 **Agent Verification Observatory**：用可回放的诊断型可视化解释 Coding Agent 的过度验证行为。

## 进度

- 方向与研究边界：100%
- 策略研究与 shadow 基础：已完成
- Observatory 可视化与策略闭环：0%，这是当前唯一主线
- 检查点：不再续跑 Maka baseline，先在本仓库完成事件 schema、trace 回放和最小 fixtures。

## 已完成（含证据）

- 策略仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`，分支 `codex/observatory-roadmap`。
- 2026-08-17 fresh check：`npm test` 7/7 通过；`node --check src/verifier.mjs`、`node --check src/cli.mjs`、`bash -n scripts/verify.sh` 通过。
- 四类 dry-run 已验证：docs-only 走 `format:check`；core 变更包含直接依赖闭包；storage migration 和 unknown 文件 fallback 到 `npm test`。
- 已建立 [Observatory MVP 路线图 #1](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/1) 和执行 Issue #2-#8；当前分支只处理文档发布 Issue #2。

## 未完成

- 尚未定义并冻结 `diff → risk → test → result → retry/expand → stop` 的 v1 事件 schema。
- 尚未生成可回放的 trace fixture 和诊断型 HTML 视图。
- 尚未实现专家/傻瓜模式的版本化策略候选和证据面板。
- 尚未有真实 benchmark；不能宣称减少耗时或降低质量风险。

## 下一步（可直接执行）

1. 合并 [#2](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/2) 的范围与研究文档。
2. 通过 [#3](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/3) 建立 CI 与 PR 证据闸门。
3. 从 [#4](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/4) 开始实现 ledger 到 VerifyTrace v1 的数据闭环。

## 风险/红线

- 只修改本仓库；不触碰 `testguard`、`research-console-private`、Maka、VPS/Hermes。
- 在回放、标签和安全指标稳定前，不启用硬拦截，也不宣称“减少测试”。
