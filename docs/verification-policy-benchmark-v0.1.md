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

   （2026-08-24 补：这一条已经堵上。走 collector 的六题采集里 `thread_id` 与 hook payload 的 `session_id` 逐个对上，6 个 candidate 臂全部 `bound_to_run=true`，检查已进采集脚本和审计脚本，回归测试覆盖陈 ledger、混入一条陈记录、未打 session 摘要、以及 lifecycle 里没有 `thread.started` 四种情况。）
2. **outcome 在真机上恒为 unknown**。codex 把 `tool_response` 当原始输出字符串发，没有 exit code 也没有 status。而此前所有单元测试喂的都是带 `exit_code` 的对象 —— 一个真机从不产生的形状。结果 outcome 路径对着 fixture 全绿、在生产里全死，每次真实运行都记 `unknown`，失败回合预算和 repeat-after-pass 检查一起失效。现在改成读 runner 自己打的汇总行（`ℹ fail 0` 这类），runner 没打失败总数就老实记 `unknown` —— 只有 pass 数没有 fail 数不能证明没东西失败。

ledger 版本 `0.2-enforced` → `0.3-rewrite`，两个 arm 由构造保证可分。这一节只是单臂手工探针，不是采集配对，不进任何质量或效率样本。（2026-08-24 补：改写档已经有配对采集里的观测了，四条带改写块的决策，两生效两撤回，见下一节。）

## 六题配对采集（2026-08-24）

六题全部完成同一 Agent/模型的两臂配对采集：baseline（无 hook，`unmanaged-coding-agent-baseline@1`）对 candidate（PreToolUse/PostToolUse hook，`observatory-verification-policy@0.4-unscoped`），harness `codex-cli@0.149.0`，模型 `gpt-5.6-sol`，effort `high`。两臂唯一的差别就是 hook，提示逐字节相同并记摘要。

判定不看采集脚本自己的记录，另写 `scripts/audit-verification-runs.mjs` 从原始证据重新推。理由有两条：先采的运行不带后加检查的结论（第一批完全早于 enforcement 覆盖检查），以及"两臂被问的是同一个问题、面对的是同一份工作区"是配对的性质，单个运行无论如何记不出来。审计当前 6/6 可用：

| 题 | baseline cmds | candidate cmds | gated | deny | oracle |
|---|---|---|---|---|---|
| `vp_affected_failure` | 6 | 8 | 8/8 | 0 | passed |
| `vp_flaky_retry_once` | 8 | 7 | 7/7 | 0 | undecided（不由 oracle 判，见下文第 6 条） |
| `vp_local_correct_stop` | 5 | 7 | 7/7 | 1 | passed |
| `vp_public_behavior_test_required` | 19 | 12 | 12/12 | 2 | passed |
| `vp_repeat_pass_stop` | 4 | 5 | 5/5 | 0 | passed |
| `vp_unknown_impact_full_fallback` | 14 | 26 | 26/26 | 2 | passed |

`vp_local_correct_stop` 的那条 deny 是 `unscoped_test_command_denied` —— 上一节第 3 条 glob 绕过修复至此有了真机观测，#43 可以关掉了。

L2 改写档也第一次进了真实配对采集（上一节只是单臂手工探针）。带 `rewrite` 块的决策一共四条，两条生效两条撤回 —— 注意别按 `by_decision` 里的 `rewrite:*` 数，那里只有 2 条：撤回的两条 decision 仍然是 `deny`，改写信息挂在它们的 `rewrite` 块里。

- `vp_affected_failure`：Agent 要的是 `npm test`（tier=full），实际执行的是 `node --test test/evaluation.test.mjs test/trace.test.mjs` —— 题目声明的 `affected`，`command_sha256` 逐字节对得上。窄命令照样捕到了这题的回归：exit 1、`pass 10 / fail 2`、`failure_signature: evaluation:quality-claim-regression`。所以"改写不丢回合"在这题上不是推理，是这题该得的结论一条没少。而 Agent 自己的结题报告写的是"`npm test` fails 2 tests and passes 10" —— `npm test` 一次没跑，那两个数是窄命令的数。自述和审计对不上，和 08-23 探针同一个现象，这次发生在正式配对里。
- `vp_public_behavior_test_required`：Agent 要的是 `npm test -- --test-name-pattern='benchmark|runtime|preflight'`。它自己已经在收窄了，但收窄方式是测试名正则 —— 不跑一遍没法证明它选中哪些测试，所以判 `unscoped_test_command_denied` 并换成题目声明的 `affected`（文件级、可数）。这条比单纯 `npm test` → affected 更能说明改写档在干什么：拿一个可证明的窄，替掉一个不可证明的窄。
- 同一题 10:06:36 的 `npm test` 被拒，改写**撤回**，`declined_reason: budget_would_be_exceeded:test_execution_budget_exceeded`，reason code 保留原来的 scope 理由 `untargeted_full_suite_denied`。上一节定的"破同一条预算的改写只是把拒绝推迟一个回合，这时收回建议、保留原 scope 原因"，这是它的首次真机观测。
- `vp_local_correct_stop` 的 deny 也带撤回，理由是 `script_body_not_inspectable`：被拒的是 `npm run check`，它的 body 是 `node --check … && bash -n … && npm test`，整串换成 affected 会把语法门禁一起吞掉，所以拒绝替换。但 deny 消息里照样附了窄命令建议，Agent 15 秒后自己跑了 `node --test test/trace.test.mjs test/verifier.test.mjs` —— 正是声明的 affected，ledger 记 `allow / within_budget / tier=affected`。不替换也能不丢回合，建议路径本身就有效。

覆盖率按 `tool_use_id` 配对，不按条数比。hook 只匹配 `Bash`，所以"每条执行过的命令都留下 PostToolUse、每条 PostToolUse 背后都有 PreToolUse"是等式而不是不等式；反方向（PreToolUse 有、PostToolUse 无）不算洞，deny 本来就是目的，codex 还会在一批并行调用里有一条被拒时丢掉同批其余的调用。原来按 `shellCommands + denials` 数条数，把两个每条命令都确实过闸的臂判成未强制 —— 是先查清两个真实成因，才改的规则，不是为了让数据通过而放松检查。

这次采集又暴露六个真实缺陷：

1. **系统时钟被 slew 时 trace 顺序反了**。collector 有单调计数器，policy ledger 没有，原来按单调时间排序等于拿计数器和一个经会话引导映射过来的墙钟读数比。`vp_flaky_retry_once` 上墙钟 200s 内落后单调 82ms（-412ppm，接近 `adjtime` 的 500ppm 上限），三条 PostToolUse 记录因此排到了它们所描述的命令完成之前，trace 直接过不了"时间戳不得递减"的校验。14 个运行里 3 个这样漂，其余 11 个稳定在 ~19ppm —— 那是两个时钟源之间的常规偏移，不会改变顺序。改成按墙钟排序：那是两边共有的唯一刻度，也是读者看到的刻度；单调时间继续用来破平局、算时长，它自己的乱序另有 `lifecycle_monotonic_reordered` 兜。回归测试直接喂进一个 PostToolUse 早于其完成记录的 ledger。

2. **unified exec 失败会让本次会话后半段静默失去强制**。codex 建不出 unified exec 进程后，会改走一条不触发 hook 的路径重跑命令。`vp_local_correct_stop/candidate-v0.4-hookloss-observed` 就是现场：10 条命令只有 2 条留下 PostToolUse，而 trace 看上去仍然完整。这份运行改名留档，审计照样把它标成 `enforcement_incomplete:8_unobserved_0_ungated` —— 这正是留它的原因。

3. **非测试命令被 fail-closed 拒掉**。`vp_unknown_impact_full_fallback` 两条 deny 都是 `command_semantics_incomplete:runner_structure_unrecognized`，被拒的却是纯查看命令：

   ```
   rg -n --hidden -g '!node_modules' -g '!vendor' '(test|pytest|jest|vitest|mocha|cargo test|go test|dotnet test|test-command)' . | head -240
   ```

   机制是正则闸门先在整串上匹配，`pytest` 出现在 rg 的搜索模式里就把这条命令认成测试命令（`normalizeTestRunnerCommand` 返回 `["pytest"]`），随后逐段分解，9 段的命令词是 `pwd/printf/rg/head/printf/git/printf/rg/head`，一个 runner 都没有，于是 `matches.length !== 1` 走 fail-closed。代价可以精确算：31 次过闸里丢了 5 次 —— 2 条被拒，外加第二条 deny 同批的 3 条已批准命令被 codex 一起丢掉（09:35:05.691/.702/.713 批准，.724 被拒，相隔 11ms 是同一批，三条都没执行）。

   这次不改。fail-closed 的方向是对的：分不清就别放行。但闸门用整串正则、判定按段分解，两者尺度不一致，才让一条 grep 模式里的 `pytest` 变成拒绝理由。真要修是让闸门也按段走，只有某一段本身像 runner 才进入分析——那是改判定路径，得先有单元测试和真机确认，不该塞进这批采集里顺手改。目前记为**已知代价**：candidate 臂在这题上白丢 5 次调用，效率对比不能拿这题说话。

   **2026-08-26 已修（#58）。** 整串正则闸门（`TEST_RUNNER_RULES` / `normalizeTestRunnerCommand`）已删除，`analyzeTestRunnerCommand` 与 `isTestRunnerCommand` 现在共用同一条段分解路径：只有某一段的可执行词本身是 runner 才算测试命令，`rg 'pytest' src/`、`grep -r vitest .`、`echo "npm test"` 一律按非测试命令放行；无法解析的 shell 仍然 fail-closed。回归测试在 `test/test-command.test.mjs` 与 `test/verification-policy-hook.test.mjs`。**可比性边界：修复前的 candidate 臂命令数与耗时（含本批 12 条 trace）不能与修复后的运行直接比**，白丢的调用全部来自这个缺陷；修复后需重采六题配对，重采结果落地前，本节的耗时数字只作采集链校准证据。

4. **审计读了别的运行的 ledger**。失败运行改名留档后，`run.json` 里记的绝对路径仍指向老名字，而老名字现在被新运行占着。`candidate-v0.3-bypass-observed` 因此报出和 v0.4 运行一模一样的 pre=3/post=2，与已知的 14 条决策矛盾。现在证据一律在运行目录内部解析，绝不读 `run.json` 记的绝对路径。`--rebuild-trace` 也踩到同一个坑的更深一层 —— `task.json` 里的 workspace 路径同样是绝对的 —— materialize 出来的目录名每次随机，所以陈路径不会悄悄解析到别的运行，只会失败；仅当记录路径确实不存在时才在运行目录内重找，且 `task.json` 原样不动：这次运行到底在哪跑的，不能为了让重建成功而改。

5. **trace 把改写信息丢干净了**。写上面那四条改写观测时才发现，trace 的 `policy_decision` 事件只留了 `decision: "rewrite"` 和 reason code，`applied`、`to_tier`、`declined_reason` 全丢，`tool_use_id` 也没留 —— pre 和 post 在 trace 里根本配不上对。也就是说：改写档是整套策略里唯一"Agent 要的命令和真跑的命令不是同一条"的路径，而发布出去的证据恰好证明不了这件事，上面四条当时全靠 `/tmp` 里的 ledger。字段现在补进 trace，逐个挑而不是整块展开 —— ledger 是 hook 写的，将来它多写一个原始命令串，不能就这么进已发布的 trace。补完用 `--rebuild-trace` 把 14 份重推、重审、重发布；也正是因为重推，才看见 `vp_local_correct_stop` 那条 `script_body_not_inspectable` 撤回，在此之前它在发布证据里等于不存在。

6. **flaky 题的独立 oracle 结构上判不了**。核对上面那张表时发现，`vp_flaky_retry_once` 那格我原来写的是"failed（按设计）"，这是错的。它的 oracle 期望 `diagnostics:intermittent-fixture`，实际观测到的是空的：`expected_failure_signatures: ["diagnostics:intermittent-fixture"]`、`failure_signatures: []`、`status: "failed"`。这里的 failed 是"该复现的失败没复现出来"，不是"Agent 弄坏了什么"。

   机制在 `src/verification-workspace.mjs:196`：`diagnostic-flaky-test-v1` 埋进去的测试第一次跑会写下 `.verification-policy-flaky-marker` 并 fail，此后每次都 pass —— 一次性的。而这题的要求就是 Agent 必须自己跑一次、失败后重试一次，那第一次就把 marker 用掉了。oracle 在 Agent 之后、在 post-run 工作区的副本里跑，marker 跟着复制过去，于是必然 pass、必然观测不到期望签名、必然报 failed。实测确认：两臂 post-run 工作区里 marker 都在（内容 `seen`），现在重跑那份测试两臂都是 `pass 8 / fail 0`。

   两臂的 oracle 报告是逐字节相同的（`sha256 9e937e11…`），post-run 工作区摘要也相同（`6e96d14e…`）—— 这个 oracle 连两臂都分不开，它的结论不携带任何信息。审计却照收：`scripts/audit-verification-runs.mjs:119` 只拒绝 passed/failed 之外的状态，`:204` 只要求两臂状态相等，一个结构上恒为 failed 的判定两道检查都过。run-report 里的 `independent_oracle_failure_signatures: 1` 也全部来自这一条，不是一次真实的 oracle 失败。

   这题的 flaky 行为本身有观测，但在 trace 里 —— 两臂的 `observed_failure_signatures` 都含 `diagnostics:intermittent-fixture`。所以缺的不是证据，是"独立判定"这一层对这题在空转。

   **2026-08-25 已定：这题不由 oracle 判。** 三条路里另外两条各要拿一条既有保证去换一格绿 —— oracle 跑前删 marker 等于 oracle 自己造一次失败，从 trace 的重试形态反推等于放弃"独立于采集"。选定的这条只增加一类审计标记，代价最小，而且这个标记以后能自动拦住同类恒为 failed 的判定。

   隐藏合同里 `vp_flaky_retry_once` 的 oracle 现在声明 `status: "undecided"`，并必须同时交出 `undecidable_reason`（为什么判不了）、`deciding_evidence: "trace_only"`（那么由谁判）、空的 `failure_signatures` 和空的 `execution.results`。其余五题仍走可判定路径，未受影响。`minimum_oracle_failures`（`src/evaluation.mjs:9`）不需要改：它数的是 `failure_signatures.length`，而 undecided 交空数组，判不了的题因此不会虚增失败样本。

   审计器（`scripts/audit-verification-runs.mjs:113` 起）接受 `undecided` 进 usable，但会从报告里重算那三个条件而不是信状态字段：声称判不了却没给理由、没指明由谁判、跑了命令、或仍报了失败签名，四种都会被拦成 unusable。回归测试在 `test/audit-verification-runs.test.mjs` —— 这也是这个审计脚本的第一个测试。

转换器在 12/14 份 trace 产出之后才修好，因此加了 `--rebuild-trace`，从未改动的原始证据（stream、lifecycle、ledger、workspace）重新推导 trace，并和 `run.json` 的 `trace` 块一起更新。它走的是和首次采集同一个调用，不是第二份实现 —— `vp_flaky_retry_once` 此前是手敲 CLI 重建的，结果磁盘上 trace 有效、`run.json` 却还记着修复前的失败退出码，读者无法在不重跑 Agent 的情况下判定哪个对。14 份 trace 现在同源，全部 `complete`、`warnings: []`。

这一节只做采集与可用性判定，不作任何质量或效率结论：6 个配对样本远不到 30 的门槛，且第 3 条已知代价直接影响 candidate 臂的调用数。

## 不能声称什么

`fixture_ready`、单题 smoke、两题配对 dry run 和 2026-08-24 的六题配对，只证明题目现场、隐藏判分及采集链可复现，以及这六个配对本身可用作证据。6 个配对样本没有达到 30 个质量样本门槛，因此：

- 不能声称策略已经节省时间；
- 不能声称故障发现率没有下降；
- 不能把这六题计入正式 30-task 质量样本；
- 不能把原来的 Calculator/Tasktracker 26 题继续扩写成正式 benchmark。

还要多加一条：**这六题的调用数差不能读成效率信号**。`vp_unknown_impact_full_fallback` 的 candidate 臂被 fail-closed 白丢 5 次调用（见上一节第 3 条），`vp_public_behavior_test_required` 的 baseline 臂 19 次对 candidate 臂 12 次，两侧都掺着策略缺陷和 harness 行为，不是策略效果。

再多一条：**`vp_flaky_retry_once` 没有独立判定**。这题的 oracle 已按 2026-08-25 的决定声明为 `undecided`（见上一节第 6 条），不再冒充一个 failed 判定；上面那批采集里它留下的逐字节相同的 failed 报告也因此不能当判定读。这题现在唯一的判定依据是两臂 trace 里的 `diagnostics:intermittent-fixture`，也就是采集本身 —— 独立那一层对这题结构上不存在，而不是暂时缺失。

`vp_flaky_retry_once` 的 oracle 归属已于 2026-08-25 定案并落地（第 6 条），审计也已能标出结构上判不了的 oracle。下一步把闸门改成按段判定后重采，再把独立 oracle report 作为 evaluation 的直接输入而非只引用派生合同。六题链路稳定后，才从多个真实 JS/TS 仓库扩展到至少 30 个质量声明任务。
