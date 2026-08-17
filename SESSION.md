# Handoff 2026-08-18

## 目标

完成 Agent Verification Observatory MVP，并以一个 Issue 对应一个 PR 的 stacked 方式推进真实 benchmark。

## 进度

- 百分比：MVP 实现与本地 calibration 100%；benchmark 环境资格审查 100%；baseline 审计闸门 100%；通用 runtime probes 100%；首个候选环境资格 100%；真实 baseline/candidate cohort 0%。
- 检查点：agent-belt 固定 revision 的环境 preflight 已通过；下一执行项是 #16 的 5-task go/no-go pilot，真实数据仍为 0/30。

## 已完成（含证据）

- 当前仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`；远端：`https://github.com/cat0825/ai-coding-agent-test-strategy.git`。
- Milestone `Observatory MVP`：Issue #1-#8；PR #9-#15 均为 OPEN/CLEAN，Node 20/24 CI 成功。
- Milestone `Real Benchmark Pilot`：Issue #18 -> #16 -> #17，依次为环境资格、通用 coding-agent baseline cohort、paired candidate cohort/evaluation gates。
- PR #19：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/19`，base `codex/evaluation-gates`，`Fixes #18`，Node 20/24 CI 成功，未合并。
- 通用化提交 `8c66d43` 已推送：Issue #16 已更名并加入仓库准入标准，Issue #17 已改为相同 coding-agent 仓库/任务集的配对比较，PR #19 已声明实现仓库无关且 Maka 仅为验证样本。
- `npm run check`：54/54 tests 通过；覆盖 CLI、determinism、fail-closed、真实命令状态、依赖环、路径逃逸、脱敏、baseline cohort 资格推导和通用 runtime probes。
- Issue #20 / PR #21：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/21`；实现 repository identity 绑定、baseline cohort 审计、调用方 eligibility 拒绝、30-task 最低门槛和显式 evidence deficit。
- Issue #22 / 分支 `codex/generic-runtime-probes`：提交 `61235a1` 已推送；实现声明式 runtime probes、Node/npm 兼容与 argv/raw output 脱敏。GitHub 创建 PR 接口持续 503，PR 尚未创建。
- Issue #23 / 分支 `codex/agent-belt-environment`：提交 `ea18cdf` 已推送；候选资格记录位于 `docs/benchmark-candidate-agent-belt.md`，preflight spec/manifest 位于 `fixtures/benchmark/`。GitHub 创建 PR 接口持续 503，PR 尚未创建。
- agent-belt 资格证据：公开 Apache-2.0 仓库，revision `90bd105b172adc41394f458e33b653dda2b199b0`，官方 Build & Test run `30529568299` 成功；无代理 preflight 的 install/lint/test/build 均通过且 worktree clean。
- 默认代理环境的完整 pytest 为 3211 passed、1 failed、45 skipped；唯一失败是本机 Ollama 检查经代理返回 HTTP 502。清除 HTTP/HTTPS/ALL proxy 后 isolated provider tests 4/4 通过，完整 preflight 为 `eligible`，因此该失败归类为环境干扰。
- 仓库无关选择标准：公开 coding-agent 项目、固定 CI-green revision、可重复 install/build/test、独立 clean worktree；manifest 必须记录仓库身份与 revision。
- Maka clean detached worktree（仅作为验证样本）：`/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot-latest`，revision `5d9ce0d2020b641b37eccbc89e25416358db2d55`，官方 CI green。
- Maka 样本真实 preflight：包含 postinstall 的 `npm ci`、`format:check`、`build:test`、`typecheck` 均 exit 0；manifest 为 `eligible`，不含 home path、proxy、token、argv/env 或命令输出。
- `dugite` artifact SHA-256：`e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437`；lockfile SHA-256：`5873cc4a49b5c7957069105a6b7264766e577d77fff15cc71f1ae5319df9dce8`。

## 未完成

- PR #9-#15、#19、#21 尚待审阅与合并；Issue #22/#23 的分支已推送但 PR 因 GitHub 503 尚未创建。
- Issue #16 尚未按通用选择标准确定最终仓库/任务集，也未采集 30 个 quality-claim-eligible baseline tasks；Issue #17 尚无 30 个 paired comparisons / 10 个 oracle failures。
- Maka 样本的完整 `npm test` 仍有 PTY timeout、macOS `/var` 路径规范化、authenticated websocket 本机能力等已知失败；这些只能作为样本环境证据，不能限制 #16/#17 的仓库范围，也不能算作 candidate regression。
- 没有证据支持真实效率提升、质量保持或 hard enforcement。

## 下一步（可直接执行）

1. GitHub 写接口恢复后，为 `codex/generic-runtime-probes` 创建关闭 #22 的 stacked PR（base PR #21），再为 `codex/agent-belt-environment` 创建关闭 #23 的 stacked PR。
2. 继续 #16：在 agent-belt 上选 5 个不会依赖 LLM judge 的真实场景，验证 Agent 认证、独立 worktree、稳定 task ids、baseline VerifyTrace 与 oracle；当前真实 deficit 为 30。
3. 5-task pilot 通过后再扩到 30，并推进 #17 的 paired candidate cohort 与 safety gates；证据不足时保持 `evidence_insufficient`。

## 风险/红线

- 不直接推送 `main`/`master`；一个实现 Issue 对应一个 PR；不主动合并。
- canonical fixture 不能替代真实 benchmark；环境 `eligible` 不等于完整测试或质量声明通过。
- final oracle 或 failure recall 退化时，不得发布效率声明或启用硬拦截。
