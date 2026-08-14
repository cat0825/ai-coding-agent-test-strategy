# Handoff 2026-08-14

## 目标

实现 AI 编码代理测试策略的 shadow 验证器，并在 Maka Agent 干净 worktree 中准备基线评测。

## 进度

- 百分比：约 85%
- 检查点：策略工具、policy 校验、dry-run 和 baseline 账本已完成；真实 baseline 受 Maka 安装/上游构建阻塞。

## 已完成（含证据）

- 策略仓库：`/Users/qianyuhe/Documents/GitHub/ai-coding-agent-test-strategy`，分支 `codex/publish-research`。
- Maka pilot：`/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot`，分支 `codex/test-strategy-pilot`，基于 `origin/main@938487ea`，未修改 Maka 文件。
- `npm test`：7/7 通过；`node --check src/verifier.mjs`、`node --check src/cli.mjs`、`bash -n scripts/verify.sh` 通过。
- 四类 dry-run 已验证：docs-only 走 `format:check`；core 变更包含直接依赖闭包；storage migration 和 unknown 文件 fallback 到 `npm test`。
- baseline 账本：`output/ledger/maka-agent-baseline.jsonl`（本地文件已被 `.gitignore` 忽略）。

## 未完成

- Maka 完整 `npm ci` 被 `dugite-native` 资产下载/缓存校验阻塞；`npm ci --ignore-scripts` 只能作为诊断安装。
- `format:check` 已通过（4282ms）；`typecheck` 因诊断安装没有先生成 dist 失败（7722ms）。
- `npm test` 在 `packages/ui` build 阶段因接口不一致失败（12638ms），未进入测试执行。
- 尚未有 30+ baseline / 30+ shadow 任务，不能宣称减少耗时或成本。

## 下一步（可直接执行）

1. 在 Maka 干净 worktree 确认 `packages/ui` 的接口错误是否存在于 `origin/main@938487ea`，或是否需要先完成项目规定的构建/patch 步骤。
2. 解决 `dugite-native` 下载后重跑不带 `--ignore-scripts` 的 `npm ci`；保留官方 SHA-256 校验。
3. 重跑 `verify.sh fast/full --mode baseline --execute`，然后开始成对采集 baseline 与 shadow 任务。

## 风险/红线

- 不修改、不推送 Maka pilot 分支；策略仓库不直接推送 `main`/`master`。
- 在基线与 shadow 样本达到门槛前，不启用强制 hook，也不宣称“减少测试”。
