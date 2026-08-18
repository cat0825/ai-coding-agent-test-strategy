# Handoff 2026-08-18 18:50 CST（Verification Policy 单题 smoke 链路检查点）

## 目标与方向

先完成并稳定当前 Agent Verification Observatory，再考虑迁移到 DeepSeek Harness。当前只做可信采集、独立验收、30-task baseline、paired candidate 和安全门；不开发 DSH 插件，不做开放式安全审查，不把任务扩张成全自动平台。

未来迁移方向保持不变：核心继续使用 Node.js，可复用逻辑稳定后再用 TypeScript 包一层 DSH 插件；离线 benchmark/oracle 继续放在插件外。

## 进度

- Issue #33 实现与 5-task 验收：100%，draft PR #34 等待人工审阅。
- Issue #30 原任务资格实现保留为历史审计；draft PR #35 已改为专用 Verification Policy benchmark，本轮实现已推送。
- Verification Policy pilot：设计 6/6，工作区资格检查 6/6，单题 direct-Codex smoke 链路已通；正式 baseline/candidate 配对仍为 0/6。
- 历史 agent-belt editing baseline 仍为 4 个，但不再拿它和 26 个简单功能题拼正式 30-task benchmark。

## 当前真相

- 仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`。
- 分支：`codex/issue-30-qualify-baseline-tasks`，基于 `codex/issue-33-state-aware-verifytrace@29eec10`。
- 本轮核心实现提交为 `90ad5ed feat: add verification policy benchmark pilot`；CI 修复提交为 `6bce414 ci: fetch benchmark source history`，均已推送。
- GitHub：[Issue #30](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/30)；[draft PR #35](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/35)，base 为 Issue #33 的分支。
- [Issue #36](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/36) 的旧 Tasktracker oracle 批次暂停，不能按原方向执行。
- PR #35 在上一提交的 Node 20/24 CI 通过；本轮 direct-Codex trace 适配尚未提交，本地全量 `npm run check` 99/99 通过。

## 本轮已完成

- 新增 `verification-benchmark.mjs` 与 CLI，校验公开任务、隐藏 oracle、任务摘要、行为覆盖和禁止自报资格。
- 新增 `verification-workspace.mjs` 与 CLI，从固定 revision 建隔离工作区，移除原始 Git 历史后应用公开 change/fault。
- 六题覆盖 `local_pass`、`affected_failure`、`full_fallback`、`repeat_stop`、`flaky_retry`、`test_required`。
- 两组隐藏参考测试都在新实现上退出 0、在旧实现上非零，证明它们不是只会通过的空测试。
- 旧 30-task planning manifest 未删除，但文档已明确降级为历史规划，不得继续批量实现 26 个 oracle。
- 单题 task manifest 新增 `workspace_state_sha256`；direct-Codex trace 会绑定初始/最终 diff，并在工作区发生未观察改动时 fail closed。
- 新增 `benchmark:verification:trace` 入口；`npm run check` 被识别为项目验证命令，不再从 trace 中漏掉。
- `vp_local_correct_stop` smoke 产生完整脱敏 trace：6 个 shell 调用、1 个 `npm run check`、Agent 零文件改动、独立相关测试 6/6 通过。

## 真实资格证据

- `npm run benchmark:verification` 输出 `design_ready: 6 pilot tasks`。
- `npm run benchmark:verification:qualify` 输出 `fixture_ready: 6/6 tasks`。
- 六题预期退出模式分别被实际复现；资格报告不保存命令输出和绝对工作区路径。
- `npm run check` 94/94 通过；`git diff --check` 通过。
- smoke trace 位于 `fixtures/benchmark/verification-policy-smoke-traces/vp_local_correct_stop.json`，报告位于 `fixtures/benchmark/verification-policy-smoke-report.json`；它明确标记 `formal_baseline_eligible: false`。

## 未完成

1. PR #34、#35 都是 draft；PR #35 本轮提交的 Node 20/24 CI 已通过，仍等待人工 review。
2. 六题还没有显式绑定同一模型的 baseline/candidate Agent trace，配对计数仍为 0/6。
3. 当前任务来源只适合 pilot；多个真实 JS/TS 仓库的正式任务尚未选取。
4. candidate/shadow adapter 还不能直接强制执行，只能先做六题观察模式。
5. 固定 `gpt-5.6-sol` 的正式单题 run 在 Agent 执行任何命令前因 workspace 额度耗尽失败；成功 smoke 没有显式绑定模型，只能证明链路与现象。

## 下一步（可直接执行）

1. 人工审阅 PR #34、#35；仍不主动 merge。
2. 提交并推送本轮 direct-Codex trace 适配，更新 PR #35 并检查 Node 20/24 CI。
3. workspace 额度恢复后，只重跑 `vp_local_correct_stop` 的显式模型 baseline；合格后才复制到其余五题和 candidate。

## 风险与红线

- `fixture_ready` 只表示六题现场真实可复现，不是策略有效，也不是正式 30/30 evidence。
- Calculator/Tasktracker 旧任务不再扩写；不能因为已经花过工作量就继续错误方向。
- 不拿计划条目、重复运行、只读任务或 Agent 自写测试充当独立 oracle。
- 不把未固定模型的 smoke 或额度失败 run 计入 baseline 1/6。
- 不迁移 DSH，不做边缘安全用例，不直接 merge，不回滚用户改动。
