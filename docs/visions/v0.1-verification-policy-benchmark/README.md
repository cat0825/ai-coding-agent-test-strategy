# v0.1 · Verification Policy Benchmark

活跃版本。数字现状一律以根目录 `STATUS.md` 为准，本文件定范围、硬门槛与动手顺序。

## 范围

用 6 题 Verification Policy pilot + 后续外部仓库题，采集同题同模型的 baseline/candidate
配对 VerifyTrace，由独立审计器和 oracle 判分，验证四档验证策略是否在保留风险覆盖的前提下
减少低价值验证。

## 硬门槛（全部满足前不许做效率声明）

| 门槛 | 现状 | 说明 |
| --- | --- | --- |
| 配对比较 ≥ 30 | 6/30 | 质量全合格，纯数量 |
| 有效 oracle 失败样本 ≥ 10 | 0/10 | 最难：只能靠"因正确原因失败"的 oracle，不能堆数量或造假 |
| 泛化场景类 ≥ 2 | 1/2 | 按题算，不按 fixture 资格算；现 6 题全 cli_tool、全出自本仓库历史 |
| 外部仓库出题 ≥ 3 | 0/3 | pino / zustand / yargs 已过环境资格，出题才算数 |

## 退出条件

- 全部门槛满足且 oracle safety gate 通过后版本关闭，进入下一阶段（效率声明与 DSH 评估）。
- 在此之前：不做效率宣传，不迁移 DSH，不对外 benchmark。

## 动手顺序（解锁关系，不按工作量排）

1. **合并 PR #60 并重采六题**（#58）。闸门整串正则 vs 段分解已修为单一路径；重采验证
   false-denial=0。不修不采：之后每对都掺同样噪声，且新旧数字不可比。
2. **#59：pino 第一道外部题**。`service_library`，一题解场景覆盖与样本自指，并验证外部出题流水线。
3. **失败样本题设计**。0/10 只能由新题或现有题出现"因正确原因失败"满足。
4. **扩到 30 对**（#17）。六题一轮约四轮，可后台批跑；先跑一次 smoke 验证 `gpt-5.6-sol` 凭据
   （有 401 前科）。
5. **oracle safety gate**。四门槛全过后才运行。

## 治理债（并行小项，不阻塞采集）

README/STATUS 漂移修复；`check` 脚本改自动扫描；AGENTS.md + docs 分层骨架签入（本批文件）；
僵尸副本与已合并分支清理。

## Session Handoff

| 文件 | 状态 |
| --- | --- |
| `docs/handoff-2026-08-25.md` | 最新交接（一句话现状、四门槛对账、易失证据清单） |
| `docs/handoff-2026-08-24.md` | 历史：采集签入前的"未提交"描述已失效 |
| `docs/handoff-2026-08-19.md` | 仅存历史价值 |
| `docs/reviews/2026-08-26-issue-pr-audit-and-gate-fix.md` | Issue/PR 区审计 + #58 修复审查报告 |

新交接按 `docs/process/index.md` 的 Handoff 规则追加，不修改旧文件。
