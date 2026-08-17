# Handoff 2026-08-18

## 目标

完成 Agent Verification Observatory MVP，并以一个 Issue 对应一个 PR 的 stacked 方式推进审阅与合并。

## 进度

- 百分比：MVP 实现与本地 calibration 100%；真实 benchmark 0%。
- 检查点：Issue #1-#8、Milestone `Observatory MVP` 与 PR #9-#15 已建立；最终实现分支为 `codex/evaluation-gates`。

## 已完成（含证据）

- 当前仓库：`/Users/qianyuhe/Documents/ChatGPT/llm test`；远端：`https://github.com/cat0825/ai-coding-agent-test-strategy.git`。
- 路线图与任务：Issue #1-#8 均已进入 `Observatory MVP` Milestone。
- PR #9：范围、状态与任务集研究；PR #10：CI 与贡献闸门。
- PR #11-#15：VerifyTrace v1、确定性诊断、HTML 回放、推荐模式与 evaluation gate。
- `npm run check`：38/38 tests 通过；PR #9-#15 的 Node 20/24 CI 已通过。
- `npm run evaluate`：报告为 `evidence_insufficient`，`efficiency_claim` 为 `not_supported`；canonical fixture 仅用于结构校准。
- 合并前审计已隔离 calibration 与 quality-claim 指标；不合格 comparison 不再影响声明 gate。
- VerifyTrace 现在拒绝缺失或类型错误的 `test_selection.data.affected_workspaces`；修复已从 PR #11 传播到 #12-#15。

## 未完成

- PR #9-#15 尚待按依赖关系审阅和合并，Issue 由 GitHub 合并流程关闭。
- 尚无真实仓库 benchmark：quality-claim-eligible comparison 为 0/30，eligible oracle failure 为 0/10。
- Maka baseline 仍受 workspace 构建接口不一致与 `dugite-native` postinstall 下载链路阻塞。
- 未启用 Agent hook/permission 强制；没有证据支持真实效率或质量声明。

## 下一步（可直接执行）

1. 先合并 PR #10；随后处理 PR #9，并按 #11 -> #12 -> #13 -> #14 -> #15 的顺序审阅合并实现栈。
2. 在干净 Maka worktree 修复或确认 baseline 构建阻塞，保留安装与 oracle 失败证据。
3. 采集至少 30 个 eligible baseline/candidate 对和 10 个 eligible oracle failures，再运行 evaluation gate。

## 风险/红线

- 不直接推送 `main`/`master`；一个实现 Issue 对应一个 PR。
- canonical fixture 不能替代真实 benchmark；证据不足时必须保持 shadow。
- 在 final oracle 或 failure recall 退化时，不得发布效率声明或启用硬拦截。
