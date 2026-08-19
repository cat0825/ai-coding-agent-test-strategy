# Handoff 2026-08-19 15:28 CST（Verification Policy 配对 dry run 与信任边界加固检查点）

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
