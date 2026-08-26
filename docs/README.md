# docs/

文档入口与权威顺序。

## 权威顺序

1. `STATUS.md`（根目录）与 `verification-policy-benchmark-v0.1.md` —— 当前事实与证据边界
2. `SESSION.md`（根目录）—— 追加式检查点日志，只加不改
3. `visions/` —— 活跃版本范围、四门槛对账、动手顺序
4. 最新 `handoff-*.md` —— 交接导航
5. 其余 `*.md` —— 各子系统契约与历史决策

冲突时以上面的顺序为准；发现旧文档与新证据矛盾，按证据改文档并在 handoff 记录。

## 分层

| 目录 | 内容 |
| --- | --- |
| `project/` | 长期事实：研究问题、系统地图（[system-map.md](project/system-map.md)）、权威文档地图 |
| `process/` | 可复用流程：证据纪律、issue/PR 治理、口径门禁、[红线与已知坑](process/boundaries.md)、[验证分档](process/testing-policy.md) |
| `visions/` | 活跃版本：范围、硬门槛、动手顺序 |
| `reviews/` | 审查报告与审计记录，按日期归档 |
| （本目录平铺） | 各子系统 v1 契约文档，按主题检索 |

## 子系统契约索引

- 验证策略与状态机：`ai-coding-agent-test-strategy.md`、`experiment-and-calibration.md`
- 测评合同：`verification-policy-benchmark-v0.1.md`、`scenario-stratification-v1.md`、`coding-agent-verification-task-set-research.md`
- 采集与 trace：`agent-belt-timestamped-trace-v1.md`、`verifytrace-v1.md`、`trace-diagnostics-v1.md`、`trace-replay.md`
- 审计与判分：`baseline-cohort-v1.md`、`evaluation-harness-v1.md`、`agent-belt-pilot-audit-v1.md`、`agent-belt-independent-oracles-v1.md`、`agent-belt-task-qualification-v1.md`
- 环境与推荐：`benchmark-environment-v1.md`、`recommendation-modes-v1.md`、`benchmark-candidate-agent-belt.md`
- 独立审计记录：`independent-audit-2026-08-18.md`
