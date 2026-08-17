# Handoff 2026-08-17

## 目标

完成 Agent Verification Observatory MVP，并以一个 Issue 对应一个 PR 的 stacked 方式推进真实 benchmark。

## 进度

- 百分比：MVP 实现与本地 calibration 100%；benchmark 环境资格审查 100%；baseline/candidate cohort 0%。
- 检查点：Issue #18 已由 PR #19 实现；Maka CI-green revision 已通过真实 preflight，下一执行项为 Issue #16。

## 已完成（含证据）

- 当前仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`；远端：`https://github.com/cat0825/ai-coding-agent-test-strategy.git`。
- Milestone `Observatory MVP`：Issue #1-#8；PR #9-#15 均为 OPEN/CLEAN，Node 20/24 CI 成功。
- Milestone `Real Benchmark Pilot`：Issue #18 -> #16 -> #17，依次为环境资格、baseline cohort、candidate cohort/evaluation gates。
- PR #19：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/19`，base `codex/evaluation-gates`，`Fixes #18`，Node 20/24 CI 成功，未合并。
- `npm run check`：44/44 tests 通过；覆盖 CLI、determinism、fail-closed、真实命令状态、依赖环、路径逃逸与脱敏。
- Maka clean detached worktree：`/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot-latest`，revision `5d9ce0d2020b641b37eccbc89e25416358db2d55`，官方 CI green。
- 真实 preflight：包含 postinstall 的 `npm ci`、`format:check`、`build:test`、`typecheck` 均 exit 0；manifest 为 `eligible`，不含 home path、proxy、token、argv/env 或命令输出。
- `dugite` artifact SHA-256：`e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437`；lockfile SHA-256：`5873cc4a49b5c7957069105a6b7264766e577d77fff15cc71f1ae5319df9dce8`。

## 未完成

- PR #9-#15、#19 尚待审阅与合并；Issue 由对应 PR 合并流程关闭。
- Issue #16 尚未采集 30 个 quality-claim-eligible baseline tasks；Issue #17 尚无 30 个 paired comparisons / 10 个 oracle failures。
- Maka 完整 `npm test` 仍有 PTY timeout、macOS `/var` 路径规范化、authenticated websocket 本机能力等已知失败，必须在 #16 中区分基础设施、平台和 oracle 证据。
- 没有证据支持真实效率提升、质量保持或 hard enforcement。

## 下一步（可直接执行）

1. 审阅并合并 PR #19 后关闭 #18；保留 preflight manifest 作为 #16 cohort 的环境引用。
2. 从 `codex/benchmark-preflight` 建立 #16 feature 分支，定义稳定 task ids，采集 baseline VerifyTrace，并明确报告 30-task deficit。
3. #16 完成后推进 #17 的 paired candidate cohort 与 safety gates；证据不足时保持 `evidence_insufficient`。

## 风险/红线

- 不直接推送 `main`/`master`；一个实现 Issue 对应一个 PR；不主动合并。
- canonical fixture 不能替代真实 benchmark；环境 `eligible` 不等于完整测试或质量声明通过。
- final oracle 或 failure recall 退化时，不得发布效率声明或启用硬拦截。
