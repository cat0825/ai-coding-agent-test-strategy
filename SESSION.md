# Handoff 2026-08-18 18:15 CST（Issue #30 任务资格检查点）

## 目标与方向

先完成并稳定当前 Agent Verification Observatory，再考虑迁移到 DeepSeek Harness。当前只做可信采集、独立验收、30-task baseline、paired candidate 和安全门；不开发 DSH 插件，不做开放式安全审查，不把任务扩张成全自动平台。

未来迁移方向保持不变：核心继续使用 Node.js，可复用逻辑稳定后再用 TypeScript 包一层 DSH 插件；离线 benchmark/oracle 继续放在插件外。

## 进度

- Issue #33 实现与 5-task 验收：100%，draft PR #34 等待人工审阅。
- Issue #30 任务资格实现：100%，draft PR #35 的 Node 20/24 CI 已通过，等待人工审阅。
- 30-task planning：30/30 个不同任务已固定；真实 baseline evidence 仍为 4/30（13.3%）。
- Candidate paired cohort：0/30；eligible oracle failures：0/10。

## 当前真相

- 仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`。
- 分支：`codex/issue-30-qualify-baseline-tasks`，基于 `codex/issue-33-state-aware-verifytrace@29eec10`。
- 实现提交：`9d60d61 feat: qualify agent-belt baseline tasks`。
- GitHub：[Issue #30](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/30)；[draft PR #35](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/35)，base 为 Issue #33 的分支。
- 下一批已写入 [Issue #36](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/36)，只做 4 个 Tasktracker 核心任务，不吞并剩余全部工作。
- 最新全量检查：`npm run check` 86/86 通过；`git diff --check` 与计划/报告隐私扫描通过。

## Issue #30 已完成

- 审计固定 agent-belt revision 的 41/41 experience 场景：保留 4 个已有 Tasktracker 编辑任务，37 个场景各有稳定排除原因。
- 不计 Cursor/Claude 重复题、重复 trial、read-only 回复任务、MCP/plugin 专用场景、开放式自选问题和无法通过依赖预检的 fixture。
- 新增 26 个受控核心任务：Tasktracker 12 个、Calculator 14 个；连同已有 4 个形成 30 个唯一 `semantic_task_key`。
- 每个任务固定定义 SHA-256、fixture revision、risk class、明确测试要求、reset command 和 oracle id。
- 规划清单禁止声明 collection status 或 `quality_claim_eligible`；真实 4/30 继续由 baseline cohort auditor 单独推导。

## 真实预检证据

- 41/41 上游场景摘要匹配，2/2 fixture revision 匹配。
- Tasktracker 在临时 clone 中 reset 后 10 个 pytest 通过。
- Calculator 在临时 clone 中 reset 后 `python3 -m compileall -q src` 通过。
- 规划报告为 `planning_ready`，同时固定 `quality_claim_eligible: false`，原因是受控 oracle 和 baseline traces 尚未采集。
- 全仓库测试 86/86 通过；新增 task-plan 回归测试 3/3 通过。

## 未完成

1. PR #35 的 Node 20/24 CI 已通过，等待人工 review；PR #34 是它的 stacked 依赖。不要直接 merge 默认分支。
2. 26 个受控任务只有定义和 oracle id，没有 oracle 实现与 baseline trace；真实 evidence deficit 仍为 26。
3. Issue #36 还未开始：先实现 `tasktracker_edit_title`、`tasktracker_reopen`、`tasktracker_status_filter`、`tasktracker_search` 四个 oracle 和单次 baseline。
4. Candidate/shadow adapter 尚无独立 Issue；必须等 30 个 baseline 完成后再建。
5. 隔离执行 provider 与 stacked PR 集成治理仍未写成独立 Issue，但不是当前阻塞项。

## 下一步（可直接执行）

1. 人工审阅/合并按 #34 → #35 的 stacked 顺序进行，不主动 merge。
2. 从 Issue #36 开始四任务小批次：先 oracle fail/pass 夹具，再单次 baseline，最后更新 cohort；不要并行扩成 26 个任务。
3. 每批只有完整 collector-v2 trace 和独立 oracle 同时通过才增加 baseline 计数。

## 风险与红线

- `planning_ready` 只表示任务定义和 fixture 可以开始下一步，不是 30/30 evidence。
- Calculator 的 14 个任务是受控规划；未实现 oracle 前不执行 Agent、不计入 cohort。
- 不拿计划条目、重复运行、只读任务或 Agent 自写测试充当独立 oracle。
- 不迁移 DSH，不做边缘安全用例，不直接 merge，不回滚用户改动。
