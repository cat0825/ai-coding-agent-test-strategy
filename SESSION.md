# Handoff 2026-08-22 检查点（deny 阶梯真实观测 + 枚举逃逸封堵）

## 当前进度

- 进度：约 94%。
- 主分支：`codex/publish-research`，最新提交 `1ec4cbf Merge pull request #53`（#52、#53 均已合入）。
- open PR：
  - #54 `codex/deny-full-suite-enumeration`：枚举逃逸封堵 + deny 阶梯真实证据
- open issue：#43、#39、#36、#17、#16、#1。#45 已关闭。

## 本轮已完成

### #52 / #53 已合并
- #52 合入后 #53 冲突（`test/verification-workspace.test.mjs` 两个新 test 抢同一个闭合括号），手工保留两侧后合入。

### #43：glob deny 终于真跑到了，顺带挖出第二条逃逸（PR #54）
两次运行才拿到证据：

**第一次**（27 条决策）：`npm test` 被拒后 Agent **没用 glob**，改成把 9 个测试文件逐个列出。这个选择是 bounded 的，绕过了 glob 检查，被判 `tier=other` / `allow/within_budget` 放行 —— 工作区恰好就 9 个测试文件,即"全量套件换个写法"。此前无任何单测覆盖。

**修复**：准备器把全量命令按工作区展开（`npm test` 穿透 `package.json`），把具体文件集合写进生成的 policy（`full_suite_test_files` + `full_suite_resolution`）；hook 对覆盖该集合的 bounded 选择判 `full_suite_equivalent_selection_denied`。真子集仍放行。

**第二次**（38 条决策、10 条 deny）：Agent 把每条路都试了一遍,每条都被拒。

| # | 命令 | tier | 决策 |
| --- | --- | --- | --- |
| 1 | `npm test` | full | `untargeted_full_suite_denied` |
| 2 | `node --test test/*.test.mjs` | other | `unbounded_test_selection_denied` |
| 3 | `node --test <全部 9 个文件>` | other | `full_suite_equivalent_selection_denied` |
| 4 | `node --test test/diagnostics.test.mjs` | other | `test_execution_budget_exceeded`（连吃 7 次） |

第 2、3 条都是**首次真实观测**。Agent 随后停手并如实报告：hook 拦了全量、预算也用尽了,并列出没跑的文件。证据 `fixtures/benchmark/verification-policy-enforcement-escalation-2026-08-22/`。

**采集教训（重要）**：codex-cli 对被 deny 的工具调用**不产生任何 transcript item**，ledger 又只存摘要不存参数文本，所以两边都没有被拒命令的原文。上表是用分析器重算候选命令、拿 `command_semantic_sha256` 反查 ledger 匹配出来的（分析器确定性，结论精确）。代价是：将来的逃逸只有在有人猜对候选字符串时才能被"叫出名字"。report 里写明了这个方法。

## 未完成

- #43 仍开：L2 `updatedInput` 改写层没建（issue 底部那个 known unknown 也仍未验证）；"baseline trace 零 enforcement 事件"这条本轮没采 baseline 臂，未证实。
- #39：两个 fixture 只有环境资格，还没出题。场景覆盖按题目统计，`generalized` 仍为 false。
- #36：只重采过 1 题，其余 4 题仍是 2026-08-20 的旧配对，第 6 题仍未配对。
- 质量门槛：`quality_claim_eligible_comparisons` = 1/30。
- `research_script` 仍未覆盖，需要 snapshot oracle。

## 下一步

1. 合 #54，然后在 pino / zustand 上真正出题并采配对数据，推进 #39 与场景 `generalized`。
2. 补齐剩余 pilot 配对，更新 #36。
3. #43 剩下两条验收：L2 `updatedInput` spike，以及采一次 baseline 臂来证实两臂结构可分。

## 环境备注

- provider：cc-switch 里的 `sotamodel`（`wire_api = "responses"`，`claude-opus-5`）。**注意 cc-switch 当前选中的 Codex provider 可能不是它**——本轮选中的是 `anyrouter`，其 `gpt-5.6-sol` 负载打满（HTTP 500 `负载已经达到上限`），Claude 系模型在 `/v1/responses` 与 `/v1/chat/completions` 都是 404。36 个 provider 里实测只有 2 个可用。
- `sotamodel copy` / `copy copy` 才是余额为负的那两个（403）；主 `sotamodel` 正常，且 key 已被轮换过 —— 跑之前必须从 cc-switch DB 现取，别用旧运行目录里的。
- codex-cli 已升到 0.149.0（证据基线是 0.147.0）。升级后先用一个"永远 deny 的假 hook + 一条无害命令"探针验协议，再花钱跑真实采集：exit 0 + `hookSpecificOutput.permissionDecision=deny` 在 0.149.0 仍然成立。
- 隔离 `CODEX_HOME` 必须复制 `cc-switch-model-catalog.json`（cc-switch DB 里的 `modelCatalog` 缺 `slug` 字段，会被 Codex 拒绝），并剔除主 home 的 MCP server、plugin 和历史 trust 条目。
- 后台跑 Codex 必须 double-fork detach；直接用 shell `&` 会随会话退出被杀。

---

# Handoff 2026-08-22 检查点（enforcement 生效 + 外部 fixture 资格）

## 当前进度

- 进度：约 93%。
- 主分支：`codex/publish-research`（远程默认分支），最新提交 `1493583 evidence: recollect test_decision pair with complete traces`。
- open PR：
  - #52 `codex/fix-full-suite-deny-escape`：让 deny 真正生效（三处修复 + enforcement smoke 证据）
  - #53 `codex/external-scenario-fixtures`：外部 `service_library` / `web_frontend` fixture 资格
- open issue：#43、#39、#36、#17、#16、#1。#45 已关闭。

## 本轮已完成

### #45 已关闭
- `vp_public_behavior_test_required` 双侧 `complete`，证据 `fixtures/benchmark/verification-policy-run-2026-08-22/`。
- 两侧 oracle `passed`，`production_edits` 为空，post-run digest 一致。

### #43：deny 第一次真正生效（PR #52）
真实运行暴露三个缺陷，都已修复：
1. `2>&1` 进入参数摘要、`cd` 前缀重新派生 cwd 摘要 → 全量命令被判 `other` 放行。
2. **退出码 2 让 deny 被丢弃**。`codex-cli@0.147.0` 把退出码 2 当作 stderr-reason 协议；我们退出 2 却把 JSON 写在 stdout。实测：退出 2 时 Agent 照常拿到 `npm test` 输出；退出 0 时 Agent 报告被 PreToolUse hook 拦截。
3. glob 绕过：deny 生效后 Agent 改用 `node --test test/*.test.mjs`。现以 `unbounded_test_selection_denied` 拒绝。

证据 `fixtures/benchmark/verification-policy-enforcement-smoke-2026-08-22/`：ledger 23 条决策含 1 条 `deny / untargeted_full_suite_denied / tier=full`，Agent 明确报告命令被拦截。

### #39 前置条件（PR #53）
- `pinojs/pino` @ `b394c2c` → `service_library`：install / lint / transpile / 545 tests 全部 exit 0。
- `pmndrs/zustand` @ `f094eeb` → `web_frontend`：install / `tsc --noEmit` / 224 vitest tests 全部 exit 0。
- 两者均 clean clone + 固定 revision + `require_clean: true`，preflight `eligible`。

## 未完成

- #43：glob deny 只有单元测试覆盖。确认它的真实运行开始后 provider 返回 `403 用户额度不足`（余额为负），该运行不计入证据。**需要额度恢复后补跑。**
- #39：两个 fixture 只有环境资格，还没出题。场景覆盖按题目统计，`generalized` 仍为 false。
- #36：本轮只重采 1 题，其余 4 题仍是 2026-08-20 的旧配对，第 6 题仍未配对。
- 质量门槛：`quality_claim_eligible_comparisons` = 1/30。
- `research_script` 仍未覆盖，需要 snapshot oracle。

## 下一步

1. provider 额度恢复后，先补 glob deny 的真实观测，再考虑关闭 #43。
2. 在 pino / zustand 上真正出题并采配对数据，推进 #39 与场景 `generalized`。
3. 补齐剩余 pilot 配对，更新 #36。

## 环境备注

- provider 来自 cc-switch 当前 Codex provider（`sotamodel`，`wire_api = "responses"`，`claude-opus-5`）。
- 隔离 `CODEX_HOME` 必须复制 `cc-switch-model-catalog.json`（cc-switch DB 里的 `modelCatalog` 缺 `slug` 字段，会被 Codex 拒绝），并剔除主 home 的 MCP server、plugin 和历史 trust 条目。
- 后台跑 Codex 必须 double-fork detach；直接用 shell `&` 会随会话退出被杀。

---

# Handoff 2026-08-22 检查点（#45 test_decision 采集闭环）

## 当前进度

- 进度：约 90%。
- 当前分支：`codex/publish-research`（远程默认分支），最新提交 `42cb4da fix: bind Codex lifecycle snapshots to -C workspace`。
- 无 open PR。open issue：#45、#43、#39、#36、#17、#16、#1。

## 本轮已完成

- 用 cc-switch 当前 Codex provider（`sotamodel`，`wire_api = "responses"`，`claude-opus-5`）在隔离 `CODEX_HOME` 中完成 `vp_public_behavior_test_required` 的 candidate 采集，hooks 为本轮生成的 verification policy hook。
- 隔离 home 只保留 provider、model catalog、`features.hooks = true` 和本次 workspace trust；剔除了主 home 的 MCP server、plugin 和历史 trust 条目。
- candidate trace `complete`、`warnings: []`、11 个 shell 命令、1 个 test result、22 个 `policy_decision` 事件。
- candidate oracle `passed`，`production_edits` 为空，`test_edits` 只有 `test/benchmark-preflight.test.mjs`，post-run digest 与 trace 一致。
- 新增配对证据 `fixtures/benchmark/verification-policy-run-2026-08-22/`（baseline 复用 2026-08-21 严格 baseline），并加回归测试 `re-collected test_decision pair records the agent test write on both sides`。
- `docs/verification-policy-benchmark-v0.1.md` 增补该次重采集小节，明确仍是 1/30 质量样本、不作效率结论。

## 未完成

- #43：hook 真正执行且 ledger 完整，但严格提示让 Agent 始终在预算内，`deny_events` 为 0，仍缺真实 deny 观测。
- #36：本轮只重采 1 题，其余 4 题仍是 2026-08-20 的旧配对，第 6 题仍未配对。
- #39：正式题目仍全部来自本仓库历史；Preact/Express/Solid/Hono 的 preflight 均未通过。
- 质量声明门槛未达成：`quality_claim_eligible_comparisons` = 1/30。

## 下一步

1. 用一个会撞预算的宽松提示重跑 candidate，取得真实 deny ledger，再更新 #43。
2. 补齐剩余 pilot 配对，更新 #36。
3. 推进 #39：为 `web_frontend` / `service_library` / `research_script` 找到 clean clone + 固定 revision + install/build/test 全绿的外部 fixture。

---

# Handoff 2026-08-21 续跑检查点（#43 Verification Policy enforcement）

## 当前进度

- 进度：约 85%。
- 当前分支：`codex/enforce-verification-policy`，基于 `origin/codex/publish-research@f7ad25b`。
- PR #46（shell 文件写入观察）与 PR #47（复合命令分解）已合并；当前无 open PR。
- 本分支实现了 Codex `PreToolUse` / `PostToolUse` enforcement hook、策略准备器和显式 `policy_decision` VerifyTrace 事件。

## 本轮已完成

- `src/verification-policy-hook.mjs`：按 `session_id` 隔离累计状态，执行次数、即时耗时、验证轮次和失败轮次超限时 deny；重复通过后再跑 deny；语义不完整 fail-closed。
- `src/prepare-verification-policy-hook.mjs`：从公开 plan 与 task manifest 生成 `verification-policy.json`、`hooks.json`、state 和 ledger 路径。
- `full_fallback` 修正：只有 `behavior_class=full_fallback` 且 `risk_class=high` 时允许 full suite，并获得 fast/affected/full 三步预算；普通题的无依据 full suite 仍 deny。
- PostToolUse 缺少 `duration_ms` 时，用 Pre/Post 墙钟差累计；缺少 `tool_input` 时从 pending 状态恢复测试 identity。
- 持久 ledger 不保存原始命令、cwd、凭据或建议 argv；candidate trace 可显式记录 allow/deny/observe，baseline 不提供 ledger，因此 enforcement 事件为 0。
- 生成 hook CLI smoke 已通过：无依据 `npm test` 输出 Codex 兼容 deny JSON，进程退出码为 2。
- 验证：`npm run check` 通过；最新相关测试 39/39 通过。全量测试在加入最后一条 PostToolUse identity 回归前为 128/128，通过后仍需提交前再跑一次全量。

## 未完成

- 新测试文件数、测试代码/生产代码比例预算尚不能在 hook 内可靠执行。现有 lifecycle wrapper 有工作区快照，但独立 hook 进程没有可消费的快照输入；不能凭命令字符串猜测。
- 真实 Codex deny smoke 尚未成功复验：`claude-opus-5` provider 连续返回 high demand，模型未发起 Bash 调用，因此结果既不能证明成功也不能证明失败。
- #43 不能关闭。L2 `updatedInput` 已实测不被 `codex-cli@0.147.0` 支持；当前可靠能力是 L3 deny。
- #45 仍需在 #43 合入后重跑 `vp_public_behavior_test_required` baseline/candidate，确认双侧 trace complete。

## 下一步

1. 提交前运行最终 `npm run check`，提交并推送 `codex/enforce-verification-policy`，创建 PR 关联 #43。
2. 在 #43 更新实现证据和剩余缺口，保持 issue open。
3. provider 恢复后重试真实 Codex deny smoke。
4. 设计 hook 与 lifecycle snapshot 的最小结构化接口，再实现新测试文件预算；测试代码比例继续作为校准信号，不在缺少仓库数据时硬门禁。
5. #43 合入后重跑第 6 题，双侧 complete 后关闭 #45，并更新 #36。

---

# 历史检查点：2026-08-19 15:28 CST（Verification Policy 配对 dry run 与信任边界加固）

## 一、项目定位与核心目标

本项目为 **Agent Verification Observatory（AI 编码代理验证可观测性平台）**。

### 核心目标
1. **诊断低效**：量化分析 AI Coding Agent（如 Codex、Claude Code、Aider 等）在开发流程中的测试验证行为，精准识别“重复无效执行 (Exact repeat)”、“盲目重试 (Unattributed retry)”与“过度全量回归”。
2. **策略治理 (Verification Policy)**：提供智能分级验证（`fast` / `affected` / `full`）、依赖闭包分析与预算控制机制。
3. **双重安全门禁**：在**确保故障召回率不下降（Failure-Recall Safety Gate）**的前提下，量化证明**测试耗时与 CI 成本显著降低（Efficiency Gate）**。

---

## 二、当前真相与仓库基线

- **仓库路径**：`/Users/qianyuhe/Documents/ChatGPT/llm test`
- **当前分支**：`codex/issue-30-qualify-baseline-tasks`（基于 stacked PR 开发）
- **远程分支**：`origin/codex/issue-30-qualify-baseline-tasks`
- **关联 PR**：
  - [Draft PR #34](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/34)（Issue #33：State-aware VerifyTrace v2）
  - [Draft PR #35](https://github.com/cat0825/ai-coding-agent-test-strategy/pull/35)（Issue #30：Verification Policy Benchmark Pilot）
- **工作区状态**：当前提交 `b6eabd3` 与远程跟踪分支一致；本地有 30 项未提交变更，其中 22 个已跟踪文件修改、8 个未跟踪文件/目录。
- **代码与测试健康度**：
  - `npm run check`：**100% 通过**（包含 Node/Shell/Python AST 语法静态分析与全量单元/集成测试）。
  - 测试用例：**108 项测试全部通过，0 失败**。

---

## 三、核心架构与模块清单

| 模块名称 | 源码文件 | 核心职责与设计说明 |
| :--- | :--- | :--- |
| **验证规划器 (Verifier)** | `src/verifier.mjs`<br>`src/cli.mjs` | 根据 Git Diff 动态计算变更依赖闭包，自适应选择最小必要验证命令梯度，输出 JSONL 审计账本。 |
| **评估与门禁引擎 (Evaluator)** | `src/evaluation.mjs` | 解析 VerifyTrace，精确分类执行事件（有效复测 vs 无效浪费），计算效率与召回率门禁指标。 |
| **工作区物化隔离器 (Materializer)** | `src/verification-workspace.mjs` | 从基准 commit 自动创建 clean 临时工作区并清除 Git 历史，注入受控变更与隐藏 Oracle，防止 Agent 偷看 Commit 答案。 |
| **防伪溯源器 (Provenance)** | `src/collector-provenance.mjs` *(最新)* | 严格计算并比对 Collector Wrapper 二进制/脚本的实际 SHA-256 签名，杜绝伪造生命周期事件。 |
| **独立 Oracle 评判器** | `src/verification-policy-oracle.mjs` *(最新)* | 独立执行隐藏测试，精确匹配语义级失败签名 (`required_failure_signatures`)，不仅校验退出码。 |
| **基准准入审计器 (Cohort Auditor)** | `src/cohort.mjs` | 实行严格的 Fail-closed 准入规则：强制要求 30 题基准门槛与真实 Oracle 报告，禁止调用方自报合格。 |
| **离线 HTML 回放器** | `src/replay.mjs`<br>`src/replay-cli.mjs` | 将任意 VerifyTrace 转换为独立、无外部网络依赖的交互式 HTML 时间线回放。 |

---

## 四、本轮已完成关键工作 (2026-08-19 进展)

1. **全面修复独立审计报告中指出的 P0/P1 信任边界缺陷**：
   - **Collector 真实性绑定**：新增 `src/collector-provenance.mjs`，由 CLI 亲自计算 Wrapper 实现的 SHA-256 并与 Manifest 比对，杜绝篡改。
   - **语义级失败签名判定**：新增 `src/verification-policy-oracle.mjs`，Oracle 验证时同时核验退出码模式与具体错误签名（如报错信息、错误类型、失败文件）。
   - **Cohort Auditor 证据链闭环**：修改 `src/cohort.mjs`，不再信任 Manifest 声明的 `oracle_status`，改为直接读取并验证独立 Oracle Report 实体文件。
2. **Verification Policy 6 题 Pilot 全部就绪**：
   - 覆盖 6 类验证行为模式（`local_pass`、`affected_failure`、`full_fallback`、`repeat_stop`、`flaky_retry`、`test_required`）。
   - 6/6 工作区物化与现场资格检查全部通过；
   - 单题 Direct-Codex Smoke 链路打通并完成脱敏 Trace 验证。
3. **测试套件全面补充反例用例**：
   - 增加了伪造 Collector Digest、篡改 Oracle 结果、退出码相同但错误类型不同等 10+ 项安全反例测试。
4. **两题配对 dry run 已完成**：
   - `vp_local_correct_stop`、`vp_affected_failure` 已使用同一 `codex-cli@0.147.0` / `gpt-5.6-sol` 完成 baseline/candidate 配对；
   - 4/4 trace 完整，4/4 独立 Oracle 通过，4/4 workspace digest 一致；
   - baseline/candidate failure recall 均为 1，delta 为 0；
   - 耗时观察为毫秒量级（1123.2ms→63.6ms、191.2ms→91.2ms），candidate 均为 `mode: shadow`；当前仅 2/6 题且质量样本为 0/30，百分比不作结论。

---

## 五、Verification Policy 6 题 Pilot 现状表

| 任务 ID (`task_id`) | 行为类型 (`behavior_class`) | 题目类型 | 物化状态 | 现场资格复现 | 隐藏 Oracle 校验 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `vp_local_correct_stop` | `repeat_stop` | 验证通过后停止 | ✅ 正常 | ✅ 预期 [0] | ✅ 零文件修改 + 退出码 0 |
| `vp_affected_regression` | `affected_failure` | 关联依赖模块回归 | ✅ 正常 | ✅ 预期 [1] | ✅ 关联模块报错命中 |
| `vp_unknown_impact_full_fallback` | `full_fallback` | 需全量兜底拦截 | ✅ 正常 | ✅ 预期 [0, 0, 1] | ✅ 仅在 Full 门禁失败 |
| `vp_flaky_retry` | `flaky_retry` | 不稳定重试 | ✅ 正常 | ✅ 预期 [1, 0] | ✅ 重试后通过 |
| `vp_test_required` | `test_required` | 缺失测试要求补测 | ✅ 正常 | ✅ 预期 [0] | ✅ 允许且要求添加测试 |
| `vp_local_pass` | `local_pass` | 局部无误正常通过 | ✅ 正常 | ✅ 预期 [0] | ✅ 局部退出码 0 |

---

## 六、当前阻塞点与未完成事项

1. **剩余正式 pilot 配对未完成**：
   - 当前为 `2/6` 配对 dry run，剩余 4 题仍需同一 Agent/模型完成 baseline/candidate 采集；
   - 之前两次尝试均因 provider 凭据返回 401 失败（run-report 记录为 `conflicting environment API key returned 401` 与 `configured provider token returned 401`），`agent_commands_executed` 为 0，不能计入正式证据；这是凭据配置问题，不是额度问题。
2. **正式质量证据仍不足**：
   - Verification Policy quality-claim eligible 为 `0/30`；
   - 通用 agent-belt 历史 baseline 为 `4/30`，不能与当前六题 pilot 混合计数。
3. **分支治理与 PR 评审**：
   - 本地 30 项加固代码、fixture 和文档变更尚未提交；
   - PR #34、#35 及前置 stacked PR 仍需按依赖顺序审阅，PR #35 远端描述也需要同步 2/6 dry run 结果。

---

## 七、常用操作与验证命令清单

```bash
# 1. 执行全量静态分析与 108 项测试套件
npm run check

# 2. 运行 6 题 Verification Policy 基准定义自检
npm run benchmark:verification

# 3. 运行 6/6 工作区现场物化与模式复现资格检查
npm run benchmark:verification:qualify

# 4. 对单题执行 Direct-Codex Trace 采集 (以 vp_local_correct_stop 为例)
npm run benchmark:verification:trace -- --task vp_local_correct_stop

# 5. 运行独立 Verification Policy Oracle
npm run benchmark:verification:oracle -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --repo . \
  --task-manifest <task.json> \
  --output <oracle.json>

# 6. 生成离线 HTML 可视化回放
npm run replay -- fixtures/traces/failed-retry.json output/replay/failed-retry.html
```

---

## 八、接手后的明确执行步骤 (Actionable Next Steps)

1. **第一步（代码归档与 Commit）**：
   - 审阅当前 30 项 working tree 变更，运行 `npm run check` 后再提交并推送到 `codex/issue-30-qualify-baseline-tasks`。
2. **第二步（完成剩余四题）**：
   - 依次完成 `vp_unknown_impact_full_fallback`、`vp_repeat_pass_stop`、`vp_flaky_retry_once`、`vp_public_behavior_test_required` 的 baseline/candidate 配对。
3. **第三步（重新评估）**：
   - 用 6 题完整配对数据运行 evaluation；确认 failure recall 安全门禁和证据完整性。
4. **第四步（扩展正式样本与 PR 治理）**：
   - 六题链路稳定后，从多个真实 JS/TS 仓库扩展到至少 30 个质量声明任务；按 stacked 依赖顺序审阅 PR，不主动合并。
