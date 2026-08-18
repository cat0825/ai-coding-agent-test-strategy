# Verification Policy Benchmark v0.1

## 目标

这个 benchmark 不以“Agent 能修多少 Issue”为主指标。它只检验一件事：在不降低故障发现和最终正确性的前提下，验证策略能否减少无依据的全量测试、重复测试和测试代码扩张。

主测评把业务改动预先放进固定工作区。`verify_only` 任务禁止 Agent 修改代码，避免把编码能力混进结果；`test_decision` 任务只允许决定和编写必要测试。端到端修复任务要等隔离测评成立后再作为第二层安全检查。

## 六题 pilot

| Task | 现场 | 应验证的行为 |
|---|---|---|
| `vp_local_correct_stop` | 小范围正确改动 | 跑相关测试后停止，不跑全量 |
| `vp_affected_failure` | 相关模块存在真实回归 | 找到失败后停止，不继续扩张或修代码 |
| `vp_unknown_impact_full_fallback` | 共享测试配置影响范围未知 | 定向检查不足时运行完整门禁 |
| `vp_repeat_pass_stop` | 相关测试已通过且代码未变化 | 不重复执行同一命令 |
| `vp_flaky_retry_once` | 同一测试第一次失败、第二次通过 | 只重试一次并报告不稳定 |
| `vp_public_behavior_test_required` | 新公共行为缺少回归测试 | 新测试在正确实现上通过，在旧实现上失败 |

公开任务定义在 [`verification-policy-pilot-plan.json`](../fixtures/benchmark/verification-policy-pilot-plan.json)，隐藏判分合同在 [`verification-policy-pilot-oracles.json`](../fixtures/benchmark/verification-policy-pilot-oracles.json)。运行 Agent 时只提供公开任务定义和已物化工作区，不能把隐藏合同复制进去。

## 工作区隔离

资格检查从固定 Git revision 创建临时 clone，随后删除原始 `.git`，重新初始化一个只有单次基线提交的仓库，再放入题目声明的改动。这样 Agent 可以查看当前 diff，但不能从原仓库历史直接找到开发者答案。

受控故障只用于难以从历史提交稳定提取的三类现场：可归因回归、完整门禁失败、一次性 flaky。它们有固定代码变换和实际退出码，不使用 mock 成功或模型判分。

## 当前可复现检查

验证公开任务和隐藏合同没有串线：

```sh
npm run benchmark:verification -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --output fixtures/benchmark/verification-policy-pilot-report.json
```

实际创建六个隔离工作区并执行资格检查：

```sh
npm run benchmark:verification:qualify -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --repo . \
  --output fixtures/benchmark/verification-policy-pilot-qualification.json
```

当前固定结果是 `fixture_ready: 6/6`：

- 正确题的相关检查退出 0；
- 回归题的相关检查非零；
- 未知影响题的 fast/affected 检查通过，完整门禁非零；
- flaky 题连续两次结果为非零、0；
- 两组隐藏参考测试都在新实现上通过、在旧实现上失败。

为一次真实 Agent run 准备单题工作区：

```sh
npm run benchmark:verification:prepare -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --task vp_local_correct_stop \
  --repo . \
  --output-parent /tmp/verification-policy-workspaces
```

命令返回任务说明、公开定义摘要、临时工作区、稳定的单提交 revision 和初始 diff 摘要。工作区不包含隐藏 oracle，也不包含原仓库历史；后续 collector 必须绑定返回的 `task_id`、`scenario_definition_sha256`、`workspace_revision` 和 `workspace_state_sha256`。

真实 run 完成后，把 Codex JSONL 和 lifecycle sidecar 转成脱敏 VerifyTrace：

```sh
npm run benchmark:verification:trace -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --task-manifest /private/run/task.json \
  --stream /private/run/stream.ndjson \
  --lifecycle /private/run/lifecycle/codex-run.ndjson \
  --collector /private/run/collector.json \
  --run-id baseline-vp-local-correct-stop \
  --harness codex-cli@0.147.0 \
  --model gpt-5.6-sol \
  --output /private/run/traces/vp_local_correct_stop.json
```

转换器会校验题目摘要、工作区 revision、初始/最终 diff、collector 摘要和事件配对。模型名必须显式传入；不能用未知默认模型充当正式配对数据。

## 单题链路试跑

`vp_local_correct_stop` 已完成一次端到端试跑，脱敏结果在 [`verification-policy-smoke-report.json`](../fixtures/benchmark/verification-policy-smoke-report.json)：

- trace 完整且无 warning，工作区未被 Agent 修改；
- 独立相关测试 6/6 通过，正确性没有问题；
- Agent 共执行 6 个 shell 命令，并在额外内存断言后执行了项目级 `npm run check`；
- 该题的最小充分证据是相关测试，隐藏合同要求避免全量，因此这次确实出现了验证范围扩张。

这仍不是正式 baseline：试跑没有显式固定模型。随后固定 `gpt-5.6-sol` 的正式尝试在任何 Agent 命令执行前因 workspace 额度耗尽而失败，已归类为环境失败，不能计入 1/6。

## 不能声称什么

`fixture_ready` 和单题 smoke 只证明题目现场、隐藏判分及采集链可复现。当前还没有在这六题上采集同一 Agent/模型的 baseline/candidate 配对 VerifyTrace，因此：

- 不能声称策略已经节省时间；
- 不能声称故障发现率没有下降；
- 不能把这六题计入正式 30-task 质量样本；
- 不能把原来的 Calculator/Tasktracker 26 题继续扩写成正式 benchmark。

下一步先在额度恢复后重跑这一题的显式模型 baseline；它合格后再复制到剩余五题。六题配对成立后，才从多个真实 JS/TS 仓库扩展正式任务。
