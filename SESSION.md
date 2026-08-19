# Handoff 2026-08-18 (timestamped trace checkpoint)

## 目标

完成 Agent Verification Observatory MVP，并以一个 Issue 对应一个 PR 的 stacked 方式推进真实 benchmark。

## 进度

- 百分比：约 92%。MVP、环境资格、baseline 审计闸门、runtime probes、候选环境、independent oracles 和 timestamped trace collection 均已实现并通过本地验证；真实 quality-claim-eligible baseline 为 4/30。
- 检查点：PR [#32](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/32) 已创建，base 为 `codex/agent-belt-independent-oracles`，状态 `OPEN/CLEAN`，Node 20/24 CI 已通过；不主动合并。

## 已完成（含证据）

- 当前仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`；远端：`https://github.com/cat0825/ai-coding-agent-test-strategy.git`。
- Milestone `Observatory MVP`：Issue #1-#8；PR #9-#15 均为 OPEN/CLEAN，Node 20/24 CI 成功。
- Milestone `Real Benchmark Pilot`：Issue #18 -> #16 -> #17，依次为环境资格、通用 coding-agent baseline cohort、paired candidate cohort/evaluation gates。
- PR #19：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/19`，base `codex/evaluation-gates`，`Fixes #18`，Node 20/24 CI 成功，未合并。
- 通用化提交 `8c66d43` 已推送：Issue #16 已更名并加入仓库准入标准，Issue #17 已改为相同 coding-agent 仓库/任务集的配对比较，PR #19 已声明实现仓库无关且 Maka 仅为验证样本。
- `npm run check`：54/54 tests 通过；覆盖 CLI、determinism、fail-closed、真实命令状态、依赖环、路径逃逸、脱敏、baseline cohort 资格推导和通用 runtime probes。
- Issue #20 / PR #21：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/21`；实现 repository identity 绑定、baseline cohort 审计、调用方 eligibility 拒绝、30-task 最低门槛和显式 evidence deficit。
- Issue #22 / PR #24：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/24`；实现声明式 runtime probes、Node/npm 兼容与 argv/raw output 脱敏，base 为 PR #21 分支。
- Issue #23 / PR #25：`https://github.com/cat0825/ai-coding-agent-test-strategy/pull/25`；候选资格记录位于 `docs/benchmark-candidate-agent-belt.md`，preflight spec/manifest 位于 `fixtures/benchmark/`，base 为 PR #24 分支。
- agent-belt 资格证据：公开 Apache-2.0 仓库，revision `90bd105b172adc41394f458e33b653dda2b199b0`，官方 Build & Test run `30529568299` 成功；无代理 preflight 的 install/lint/test/build 均通过且 worktree clean。
- 默认代理环境的完整 pytest 为 3211 passed、1 failed、45 skipped；唯一失败是本机 Ollama 检查经代理返回 HTTP 502。清除 HTTP/HTTPS/ALL proxy 后 isolated provider tests 4/4 通过，完整 preflight 为 `eligible`，因此该失败归类为环境干扰。
- 仓库无关选择标准：公开 coding-agent 项目、固定 CI-green revision、可重复 install/build/test、独立 clean worktree；manifest 必须记录仓库身份与 revision。
- Maka clean detached worktree（仅作为验证样本）：`/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot-latest`，revision `5d9ce0d2020b641b37eccbc89e25416358db2d55`，官方 CI green。
- Maka 样本真实 preflight：包含 postinstall 的 `npm ci`、`format:check`、`build:test`、`typecheck` 均 exit 0；manifest 为 `eligible`，不含 home path、proxy、token、argv/env 或命令输出。
- `dugite` artifact SHA-256：`e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437`；lockfile SHA-256：`5873cc4a49b5c7957069105a6b7264766e577d77fff15cc71f1ae5319df9dce8`。
- Issue #28 定向测试：9/9 通过；全量 `npm run check`：72/72 通过；`git diff --check` 通过；临时目录重建 trace 与 checked-in fixtures 无差异。
- 隐私扫描未发现本轮新增证据中的 home path、token、密钥或原始输出；STATUS 中既有 Maka 历史样本路径是唯一命中。
- PR [#32](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/32) 已关联 Issue #28；Issue 评论已记录实现、证据和 `evidence_insufficient` 边界。

## 未完成

- PR #9-#15、#19、#21、#24、#25、#27、#31 尚待审阅与合并；Issue 由对应 PR 合并流程关闭。
- Issue #30 尚未补足 26 个不同 task；Issue #16 尚未采集 30 个 quality-claim-eligible baseline tasks；Issue #17 尚无 30 个 paired comparisons / 10 个 oracle failures。
- Maka 样本的完整 `npm test` 仍有 PTY timeout、macOS `/var` 路径规范化、authenticated websocket 本机能力等已知失败；这些只能作为样本环境证据，不能限制 #16/#17 的仓库范围，也不能算作 candidate regression。
- 没有证据支持真实效率提升、质量保持或 hard enforcement。

## 下一步（可直接执行）

1. 等待 PR #32 的维护者审阅；CI 已通过，不主动合并。
2. 按 Issue #30 审计 agent-belt 任务资格，补足 26 个不同 task，再推进 #16/#17；证据不足时保持 `evidence_insufficient`，不启用强制。
3. 审阅或合并依赖链 PR #19、#21、#24、#25、#27、#31 时，保持一个 Issue 对应一个 PR。

## 风险/红线

- 不直接推送 `main`/`master`；一个实现 Issue 对应一个 PR；不主动合并。
- canonical fixture 不能替代真实 benchmark；环境 `eligible` 不等于完整测试或质量声明通过。
- final oracle 或 failure recall 退化时，不得发布效率声明或启用硬拦截。
