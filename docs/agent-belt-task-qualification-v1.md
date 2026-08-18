# Agent-belt 30-task qualification v1

> 状态：历史规划审计，已被 [Verification Policy Benchmark v0.1](verification-policy-benchmark-v0.1.md) 取代，不再作为正式 30-task 任务池。原文件保留用于解释为什么旧方案被放弃；不得继续为其中 26 个受控任务批量实现 oracle。

## 结论

固定 `jfrog/agent-belt@90bd105b172adc41394f458e33b653dda2b199b0` 的 41 个 experience 场景已逐个审计。只有 Tasktracker 的 4 个编辑任务可直接保留；其余 37 个因为只读、Agent 专用、重复、开放式选题或 fixture 依赖不可重复而排除。

为满足 30 个“不同任务”而不是 30 次 trial，规划清单补了 26 个受控任务：Tasktracker 12 个、Calculator 14 个。最终计划覆盖 2 个 fixture、30 个不同语义任务，风险分布为 low 15、medium 13、high 2。

这只是任务规划完成，不是 baseline 完成。真实 evidence 仍由 [baseline cohort report](../fixtures/benchmark/agent-belt-baseline-report.json) 单独审计，目前仍为 4/30。

## 为什么大量旧场景没有采用

| 原因 | 数量 | 说明 |
|---|---:|---|
| Claude MCP / plugin / skill 专用 | 16 | 测的是 Claude 功能发现，不是通用代码修改 |
| 只读且无稳定功能 oracle | 8 | 只能判断回复文字，不能验收代码终态 |
| Bookstore 依赖未锁定 | 4 | `package.json` 使用范围版本且没有 lockfile |
| URL Shortener 依赖当前不可用 | 3 | 固定 revision 缺 `go.sum`，原始测试需要无法完成的外部下载 |
| Agent/Cursor 重复题 | 2 | 换 Agent 不会产生新的任务语义 |
| 开放式“自己找问题再修” | 3 | 每次可能选择不同问题，无法稳定配对；其中 1 个还叠加未锁定依赖 |
| 未验收的 Docker runtime | 1 | 不是当前核心验证链路 |

保留的 4 个上游任务是：`l2_add_completed_at`、`l2_fix_formatter_bug`、`l3_add_delete_command`、`l3_add_json_format`。它们已经有独立 oracle 和完整 baseline trace。

## 新增受控任务的边界

- Tasktracker：编辑、重新打开、优先级、截止日期、状态筛选、时间排序、标题搜索、清理完成项、导入、导出、原子保存、项目改名。
- Calculator：除零错误、核心测试、幂、平方根、百分比、平均数、中位数、限幅、精度、简单表达式、CLI、内存、历史和批量计算。
- 每个任务都有唯一 `semantic_task_key`、定义 SHA-256、fixture revision、风险级别、明确测试要求和预留的独立 `oracle_id`。
- 受控任务只选核心功能和数据正确性；不加入边缘安全扫描、模糊“全面审查”或任意扩张任务。

26 个受控 oracle 目前只有身份和行为边界，尚未实现，也没有 baseline trace。因此下一步是按小批次实现独立 oracle 后再执行 Agent，而不是直接把计划数量算成证据。

## 预检

规划审计器会检查：

1. Agent-belt revision 和 41 个源场景 SHA-256 是否匹配。
2. 任务 ID 与语义 key 是否唯一，Agent 变体和重复 trial 是否被拒绝。
3. 受控任务定义摘要是否匹配，是否覆盖至少两个 fixture。
4. 在临时 clone 中执行 reset，再运行 fixture 原始检查。

本轮真实结果：

- Tasktracker 固定 `6587fe35c2e88d8e4ee9c0f16f397081592b3ed8`，reset 后 10 个 pytest 通过。
- Calculator 固定 agent-belt revision，reset 后 `python3 -m compileall -q src` 通过。
- 41/41 场景摘要、2/2 fixture revision 均匹配。
- 结论为 `planning_ready`，同时固定输出 `quality_claim_eligible: false`。

执行命令：

```sh
npm run benchmark:tasks -- \
  --plan fixtures/benchmark/agent-belt-task-plan.json \
  --agent-belt /path/to/pinned/agent-belt \
  --output fixtures/benchmark/agent-belt-task-plan-report.json \
  --allow-host
```

`--allow-host` 只允许在临时 clone 中执行 reset 和 fixture 测试；不执行 Agent，不运行受控任务代码，也不接触 candidate/shadow 模式。
