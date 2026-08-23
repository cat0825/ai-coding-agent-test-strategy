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
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --repo . \
  --task-manifest /private/run/task.json \
  --stream /private/run/stream.ndjson \
  --lifecycle /private/run/lifecycle/codex-run.ndjson \
  --collector /private/run/collector.json \
  --run-id baseline-vp-local-correct-stop \
  --harness codex-cli@0.147.0 \
  --model gpt-5.6-sol \
  --mode baseline \
  --policy-name unmanaged-coding-agent-baseline \
  --policy-version 1 \
  --output /private/run/traces/vp_local_correct_stop.json
```

转换器会从源仓库重新计算 task base revision 的 Git tree，并要求它与隔离工作区的基线 tree 一致；同时校验题目摘要、工作区 synthetic revision、初始/最终 diff、collector 摘要和事件配对。失败命令只在私有原始输出匹配隐藏 oracle 的稳定语义时写入 `failure_signature`，原始输出不会进入 trace。模型、`baseline|shadow` 模式和 policy 名称/版本都必须显式传入；不能用未知默认值充当正式配对数据。candidate 使用 `--mode shadow --policy-name observatory-verification-policy --policy-version 0.1`。

Agent 结束后，在同一工作区运行独立 oracle：

```sh
npm run benchmark:verification:oracle -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --repo . \
  --task-manifest /private/run/task.json \
  --output /private/run/oracles/vp_local_correct_stop.json
```

oracle 在执行独立测试前计算 `workspace.post_run_workspace_state_sha256`；它必须等于 trace 的 `source.post_run_workspace_sha256`。两者共用同一个确定性算法，摘要覆盖 tracked diff 和 untracked 文件内容。oracle 在临时副本中执行测试，不改变被采集的 Agent 工作区。

## 单题链路试跑

`vp_local_correct_stop` 已完成一次端到端试跑，脱敏结果在 [`verification-policy-smoke-report.json`](../fixtures/benchmark/verification-policy-smoke-report.json)：

- trace 完整且无 warning，工作区未被 Agent 修改；
- 独立相关测试 6/6 通过，正确性没有问题；
- Agent 共执行 6 个 shell 命令，并在额外内存断言后执行了项目级 `npm run check`；
- 该题的最小充分证据是相关测试，隐藏合同要求避免全量，因此这次确实出现了验证范围扩张。

这仍不是正式 baseline：试跑没有显式固定模型。随后固定 `gpt-5.6-sol` 的正式尝试在任何 Agent 命令执行前因 workspace 额度耗尽而失败，已归类为环境失败，不能计入 1/6。

## 两题配对 dry run

2026-08-19 使用同一 `codex-cli@0.147.0` / `gpt-5.6-sol` 完成 `vp_local_correct_stop`、`vp_affected_failure` 的 baseline/candidate 配对。脱敏 trace、独立 oracle、cohort 和评估结果在 [`verification-policy-dry-run-2026-08-19`](../fixtures/benchmark/verification-policy-dry-run-2026-08-19/run-report.json)：

- 4/4 trace 完整且无 warning，4/4 oracle 通过，Agent 未改文件；
- task、repository revision、harness、model、baseline/shadow mode、policy、scenario、workspace revision 配对完整性为 1；
- trace/oracle 的 post-run workspace digest 4/4 一致；
- 回归题 baseline/candidate 均捕获 `evaluation:quality-claim-regression`，该两题内 failure recall 未下降；
- 观察到的验证耗时下降中位数为 73.3%，验证命令数下降中位数为 25%，但只有两题且 `quality_claim_eligible_comparisons` 为 0。

因此报告结论严格保持 `evidence_insufficient / not_supported`；这些数值只用于校准采集链和题目，不是效率或安全声明。

## test_decision 题的重采集（2026-08-22）

`vp_public_behavior_test_required` 是唯一的 test_decision 题：Agent 必须新增测试文件而不改生产代码。此前 collector 看不到 Agent 的测试文件写入，两侧 trace 都 fail-closed 成 `partial`。修复 collector 的 workspace 归因后重采集，证据在 [`verification-policy-run-2026-08-22`](../fixtures/benchmark/verification-policy-run-2026-08-22/run-report.json)：

- baseline 与 candidate 均为 `complete`、`warnings: []`、`state_evidence_complete: true`；
- 两侧独立 oracle 均 `passed`，`production_edits` 为空，`test_edits` 只有 `test/benchmark-preflight.test.mjs`；
- trace 与 oracle 的 post-run workspace digest 两侧一致；
- candidate 侧 policy hook 真正执行，ledger 22 条决策进入 trace 的 `policy_decision` 事件，但严格提示让 Agent 始终处在预算内，`deny_events` 为 0；
- 两侧都用 cc-switch 当前 Codex provider（`sotamodel`，`wire_api = "responses"`）与 `claude-opus-5`。

因此这题的采集缺口已经关闭，但只有 1 个配对样本，`quality_claim_eligible_comparisons` 仍是 1/30，也仍然缺少真实 deny 观测。耗时差为单样本，不作效率结论。

## Enforcement smoke（2026-08-22）

真实 provider-backed 运行第一次观测到 hook 真正拒绝命令，证据在 [`verification-policy-enforcement-smoke-2026-08-22`](../fixtures/benchmark/verification-policy-enforcement-smoke-2026-08-22/run-report.json)。这次跑用宽松提示明确要求 Agent 跑全量。

采集过程暴露了三个真实缺陷，都已修复：

1. **重定向进入参数摘要**。Agent 实际执行 `cd <workspace> && npm test 2>&1 | tail -60`。`2>&1` 被当成 runner 参数，`cd` 前缀又重新派生 cwd 摘要，命令因此没有匹配到配置的 `full` tier，被判成 `other` 并放行。现在重定向终止参数列表，tier 匹配改用 runner + `arguments_sha256`。
2. **exit code 2 让 deny 失效**。`codex-cli@0.147.0` 把退出码 2 当作 stderr-reason 协议；我们退出 2 却把 JSON 写在 stdout，Codex 直接丢弃决策并照常执行。实测对比：退出 2 时 Agent 拿到了完整的 `npm test` 输出；退出 0 时 Agent 报告命令被 PreToolUse hook 拦截。现在 hook 一律退出 0，拒绝信息放在 `hookSpecificOutput`。
3. **glob 绕过**。deny 生效后，Agent 立刻改用 `node --test test/*.test.mjs`。glob 展开成未知文件集合，无法证明比被拒的全量更窄。现在分析器标注 selection 是否有界，无界选择在没有 full-suite 例外时被拒。

smoke run 的 trace `complete`、`warnings: []`，oracle `passed`，`production_edits` 为空，ledger 23 条决策中有 1 条 `deny / untargeted_full_suite_denied / tier=full`。

第 3 条修复只有单元测试覆盖，尚无真实运行观测：确认运行开始后 provider 返回 403 额度不足（余额为负），该运行不计入证据。因此 #43 仍保持 open。

## L2 改写档与真机确认（2026-08-23）

deny 只保住了"不许乱跑全量"，代价是 Agent 白丢一个验证回合。L2 改写档把"只是瞄太宽"的调用换成题目自己声明的 `affected` tier，命令照跑，回合不丢。只有三个原因进改写：`untargeted_full_suite_denied`、`unbounded_test_selection_denied`、`full_suite_equivalent_selection_denied`；其余拒绝原样保留 —— 那些的问题不在目标。

改写的窄命令只从题目声明的 `affected` 取，绝不从被判的命令里推。理由是这个项目的立命之本：一个凭空造出来的目标在 transcript 里照样像验证，实际却在测别的东西。另外三条约束：

- 复合命令（`npm run lint && npm test`）拒绝改写。整串替换会把 lint 静默吞掉，改写必须只收窄测试范围。
- 改写命令先过一遍同一份预算再提供。破同一条预算的改写只是把拒绝推迟一个回合，这时收回建议、保留原 scope 原因。
- 改写一旦生效，它才是"真正跑过的那条命令"：PostToolUse 的身份取 pending 记录而非 payload，预算和 repeat 检查都记在窄命令头上。

同时补掉一个 fail-closed 漏洞：`tier === "full"` 且推不出 affected 时，原来会掉到预算检查然后被放行。现在拒绝并给 `full_suite_scope_undeterminable_denied`，`allow_full_suite: true` 仍是唯一的显式豁免（full_fallback 题就靠它）。

真机确认在 [`verification-policy-rewrite-probe-2026-08-23`](../fixtures/benchmark/verification-policy-rewrite-probe-2026-08-23/probe-report.json)。挑 `vp_public_behavior_test_required` 是因为它的工作区里 affected 明显窄于全量（13 题 vs 51 题），题数本身就能区分"改写生效"和"改写被忽略"——上一次我拿一个 affected ≡ full 的工作区看到 13 题就说生效了，那是错的，13 题在那个工作区里无条件成立。

- Agent 要的是 `npm test`，codex 实际执行 `node --test test/benchmark-preflight.test.mjs test/cohort.test.mjs`，13 题；
- ledger 两条：PreToolUse `rewrite / untargeted_full_suite_rewritten / tier=full`，PostToolUse 记的是被替换命令的身份 `tier=affected`；
- Agent 自己的总结是"13 tests ran — command: `npm test`"。它报的是它要的命令，不是跑掉的命令。自述和审计对不上，这正是整套东西存在的理由。

这次采集又暴露两个真实缺陷，都已修复或记录：

1. **hook 信任门让运行静默失效**。同一份 config、同一个工作区、同一句提示，不加 `--dangerously-bypass-hook-trust` 时：全量 51 题跑完、hook 一次没触发、ledger 文件根本没生成。新建的 `CODEX_HOME` 没有持久化 hook 信任，codex 0.149.0 直接静默跳过，`codex doctor` 也不报告任何 hook 相关检查。

   顺着这条查 collector 能不能识别"策略从未生效的运行"，结论比预想的好一半：ledger 文件缺失会在 `readFile` 炸掉，空 ledger 会被 `parseNdjson` 的"至少一条记录"拒掉，两条都已经 fail-closed。真正的洞只有一个 —— trace CLI 是手敲命令跑的，`--policy-ledger` 漏写时 `policyDecisions` 静默变成 `[]`，trace 照样 `complete`，看上去就是"策略生效了、Agent 全程在预算内、0 条 deny"。现在 `--mode shadow` 强制要求 `--policy-ledger`，baseline 臂不受影响（它按设计没有 hook）。

   还剩一个洞没堵：**上一轮留下的 ledger**。hook 这轮静默跳过，但文件里还有旧记录，两道检查都过。好消息是这个可以精确判定 —— ledger 的 `session_id_sha256` 就是 `sha256(session_id).slice(0, 16)`，无盐，实测拿 transcript 里的 session id 一算就对上（`d96bf50be8537c90`）。所以只要把 lifecycle 里的 `thread.started` / `thread_id` 和 ledger 的 session 摘要绑一次，就能证明这份 ledger 属于这次运行。没有现在就做，是因为"`thread_id` 等于 hook payload 的 `session_id`"这一步还没实测过 —— 探针是直接跑 codex 的，没走 wrapper，手上没有 lifecycle 文件。下次走 collector 采集时顺手确认这一条，再补这道检查。
2. **outcome 在真机上恒为 unknown**。codex 把 `tool_response` 当原始输出字符串发，没有 exit code 也没有 status。而此前所有单元测试喂的都是带 `exit_code` 的对象 —— 一个真机从不产生的形状。结果 outcome 路径对着 fixture 全绿、在生产里全死，每次真实运行都记 `unknown`，失败回合预算和 repeat-after-pass 检查一起失效。现在改成读 runner 自己打的汇总行（`ℹ fail 0` 这类），runner 没打失败总数就老实记 `unknown` —— 只有 pass 数没有 fail 数不能证明没东西失败。

ledger 版本 `0.2-enforced` → `0.3-rewrite`，两个 arm 由构造保证可分。这一节只是单臂手工探针，不是采集配对，不进任何质量或效率样本。

## 不能声称什么

`fixture_ready`、单题 smoke 和两题配对 dry run 只证明题目现场、隐藏判分及采集链可复现。当前只有 2/6 pilot 题完成同一 Agent/模型配对，且没有达到 30 个质量样本门槛，因此：

- 不能声称策略已经节省时间；
- 不能声称故障发现率没有下降；
- 不能把这六题计入正式 30-task 质量样本；
- 不能把原来的 Calculator/Tasktracker 26 题继续扩写成正式 benchmark。

下一步完成剩余 4/6 pilot 配对，并把独立 oracle report 作为 evaluation 的直接输入而非只引用派生合同。六题链路稳定后，再从多个真实 JS/TS 仓库扩展到至少 30 个质量声明任务。
