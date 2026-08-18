# Handoff 2026-08-18 17:00 CST（Issue #33 state-aware 证据检查点）

## 目标与方向

先完成并稳定当前 Agent Verification Observatory，再考虑迁移到 DeepSeek Harness。当前阶段只做真实业务闭环：可信采集、独立验收、30-task baseline、paired candidate 和安全门；不开发 DSH 插件，不做边缘安全用例，不扩张成全自动平台。

未来迁移方向已确定但暂缓：核心继续保持 Node.js 可复用逻辑，稳定后用 TypeScript 包一层 DSH 插件，接入 `tools/pre-execute`、`tools/result` 和 `agent/turn-stopping`；离线 benchmark/oracle 不塞进在线插件。

## 进度

- Issue #33 当前实现与真实 5-task 验收：100%。
- 真实 baseline：4/30（13.3%）；还缺 26 个不同任务。
- Candidate paired cohort：0/30；eligible oracle failures：0/10。
- 默认分支集成：仍为 0/14 旧 PR；Issue #33 已提交为 draft PR #34，尚未合并。

## 当前真相

- 仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`。
- 分支：`codex/issue-33-state-aware-verifytrace`，基于 `codex/agent-belt-timestamped-trace@1d11fa3`。
- GitHub：[Issue #33](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/33)；[draft PR #34](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/34) 以 `codex/agent-belt-timestamped-trace` 为 base，Node 20/24 CI 已通过。
- 主实现提交：`aa47c02 feat: make agent-belt traces state-aware`。
- 最新全量检查：`npm run check` 83/83 通过；`git diff --check` 与 fixture 隐私扫描通过。

## Issue #33 已完成

- `scripts/codex-lifecycle-wrapper.py` 升级为 collector v2：记录 UTC/monotonic 生命周期、cwd 摘要和 workspace-relative `file_change`；不记录命令、输出、凭据或绝对路径。
- `src/test-command.mjs` 保留 cwd、环境赋值和目标参数的摘要。`pytest`、带 `PYTHONPATH` 的 `pytest`、不同 target/cwd 不再被错误折叠成同一命令。
- `src/agent-belt-trace.mjs` 按时间写入文件状态；测试间的非测试 Shell 命令会产生 unknown-state 边界；最终 `files_modified` 与已观察 file-change 路径必须对得上，否则 trace 变 partial。
- `src/diagnostics.mjs` 只在状态证据和两次命令语义都完整时输出 `exact_repeat` / `unattributed_retry`。旧 collector-v1 trace 不再产生伪重复结论。
- Python `__pycache__`、`.pyc`、pytest/mypy/ruff cache 被单独计数，不再抬高测试文件预算；真实本轮忽略 9 个缓存文件，保留 5 个真实测试文件改动。

## 真实 v2 rerun 证据

- Run：`20260818-162534-870bcfcf`；固定 `jfrog/agent-belt@90bd105b172adc41394f458e33b653dda2b199b0`，Codex CLI 0.147.0。
- Agent-belt：5/5 scenarios、32/32 rules checks、0 errors，总 agent time 935730ms。
- VerifyTrace：5/5 complete、0 partial、0 warnings；7 个 test result，总 observed test duration 2874.598ms。
- 状态/语义：4 个 editing task 各绑定 1 次 completed file-change；7/7 测试结果 command semantics complete；最终 outcome 文件清单全部对账。
- Diagnostics：`exact_repeat=0`、`unattributed_retry=0`、`necessary_revalidation=0`。本轮没有证据支持“重复测试浪费”结论。
- Independent oracle：4/4 editing tasks passed；read-only `l1_find_bug` 继续排除。
- 隐私扫描：trace 和 lifecycle 中未发现绝对用户路径、`/private` 路径、API key 标记、原始命令输出。
- Cohort：`quality_claim_eligible_tasks=4`、`evidence_deficit=26`、`evidence_insufficient`；不得宣称总体效率或质量提升。

## 已更新的证据

- `fixtures/benchmark/traces/*.json` 与 `report.json`：已替换为 collector-v2 run。
- `fixtures/benchmark/oracles/*.json`：已用 v2 run 的四个 editing diff 重建并通过。
- `fixtures/benchmark/agent-belt-pilot-report.json`：已更新为 29 shell、7 test runner、3 non-zero、9 generated caches ignored。
- `fixtures/benchmark/agent-belt-baseline-cohort.json` 与 `agent-belt-baseline-report.json`：已绑定新 trace id，仍为 4/30。

## 未完成

1. PR #34 等待人工 review/merge；不要直接推或合并默认分支。
2. Issue #30：审计 41 个现有场景，规划至少 30 个不同、可独立 oracle 的任务；当前还缺 26 个。
3. Candidate/shadow adapter 尚无独立 Issue，也未实现；完成 30 个 baseline 后再做。
4. 隔离执行 provider、stacked PR 集成治理仍未写成独立 Issue。

## 下一步

1. 等待 PR #34 人工 review/merge；Issue #33 不再新增功能。
2. 继续 #30，不再重跑这 5 个任务。
3. 30 个 baseline 完成后，实现 candidate/shadow adapter，再执行 30 对比较与 10 个 oracle-failure gate。
4. 只有 paired 数据和 safety gate 通过后，才讨论有限强制；当前保持 observation/shadow。

## 风险与红线

- 5-task run 只能证明采集链和这四个 editing oracle 可用，不能证明更快、更安全或普遍减少测试。
- 不把生成缓存、重复 trial、read-only 无 oracle 任务算进 30-task 门槛。
- 不直接 merge，不回滚用户改动，不把 DSH 迁移提前混入当前 PR。
- 不为追求“零 bug”继续扩展边缘场景；证据不够就明确 `evidence_insufficient`。
