# 项目状态

状态：**Observatory MVP 与 state-aware collector v2 已实现 / Verification Policy pilot 工作区 6/6 合格 / 已完成 2/6 配对 dry run / 正式质量样本仍为 0/30**

## 已完成

- 完成 AI 编码代理测试策略的纵向分析：测试大小、测试金字塔、回归测试选择、增量分析和测试质量审计。
- 完成横向案例分析：Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta、Microsoft、GitLab、Kubernetes。
- 定义 `off`、`smoke`、`standard`、`thorough` 四档验证强度。
- 定义 Agent 状态机：分类变更、发现受影响测试、一次定向执行、失败归因、必要时升级。
- 定义默认预算建议：最多新增 1 个测试文件、最多执行 2 次即时测试、即时测试时间上限 90 秒。
- 提供可直接复制到 `AGENTS.md` 的测试策略模板。
- 修复 PDF 中 `AGENTS.md` 模板的右侧裁切，加入打印源、构建脚本和 16 页成品。
- 完成实验与校准方案：指标、初始门槛、fallback、命令归一化和 override 账本。
- 定义通用 pilot 选择标准：公开 coding-agent 项目、固定 CI-green revision、可重复 install/build/test、独立 clean worktree。
- 实现 `src/verifier.mjs`、`src/cli.mjs` 和 `scripts/verify.sh`，支持 `fast|affected|full`、受影响 workspace 闭包、保守 fallback 和 JSONL 账本。
- 增加 policy 中 npm script 的存在性校验；Maka policy 作为仓库适配示例，已对齐实际的 `format:check`、`typecheck` 和 `test`。
- 在 `/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot` 完成四类历史 dry-run，worktree 基于 `origin/main@938487ea` 且未修改 Maka 文件；该样本不构成产品绑定。
- 定义 VerifyTrace v1，并实现旧 ledger 转换、确定性重复/重试诊断和无网络依赖的 HTML 回放。
- 实现 expert/simplified 推荐模式；只有低风险、高置信重复可自动处理，推荐与决定均进入可验证 trace。
- 实现一命令 evaluation harness；本地 7 条 trace 和 4 个配对任务的结论为 `evidence_insufficient`，不支持效率声明。
- 实现 fail-closed baseline cohort 审计器：任务资格只能由合格环境、固定 revision、完整 baseline VerifyTrace 和失败分类推导，调用方不能自报合格，也不能把 30-task 门槛调低。
- 将 preflight 从 Node/npm 专用 runtime 扩展为声明式工具探针，兼容 Python/uv、Go、Rust 等工具链；manifest 不保存 probe argv 或原始输出。
- 首个通用候选 `jfrog/agent-belt@90bd105b` 已通过无代理真实 preflight：`uv sync --locked`、lint、pytest 与 build 全部通过，官方同 revision CI green；脱敏 manifest 已落盘。
- Codex CLI 0.147.0 已完成 agent-belt 的 state-aware 5-task rerun：5/5 场景、32/32 rules checks 通过；脱敏审计记录 29 个 shell 调用、7 次测试 runner、3 次非零结果，pilot decision 为 `go`。
- 实现 fail-closed pilot outcome 审计器：绑定环境 revision、场景定义哈希和结构化输出，拒绝缺失/畸形/自报资格证据，不保存原始命令、输出、绝对路径或认证信息。
- 为 4 个 editing task 实现外置独立功能 oracle，并用真实 pilot diff 重建的 post-agent 工作区验证 4/4 通过；oracle 不调用 agent 自写测试，证据绑定环境、定义和源码摘要。
- Issue #28 的 pinned local Codex lifecycle collector 已实现：wrapper 旁路记录每个 shell 的 UTC/monotonic start/completion、exit code 与 `turn.completed` / `turn.failed`，不保存命令、输出、凭据或绝对路径。
- 真实 rerun `20260818-162534-870bcfcf` 在固定 agent-belt revision 上完成 5/5 scenarios、32/32 checks；生成 5 条 complete VerifyTrace、7 个观察到的测试结果，测试执行总时长为 2874.598ms，agent 总时长为 935730ms。
- 4 个 editing task 的本轮 diff 独立 oracle 为 4/4 passed；cohort auditor 输出 `quality_claim_eligible_tasks: 4`、`evidence_deficit: 26`、`evidence_insufficient`。
- Issue #33 的 state-aware collector v2 已实现：记录脱敏文件变化和起始目录摘要；命令 canonical id 保留 cwd、环境和目标语义摘要；证据不完整时不输出 `exact_repeat` 或 `unattributed_retry`。
- Issue #30 的任务资格审计已落盘：41/41 上游场景有稳定选取或排除理由；保留 4 个 Tasktracker 编辑任务，补 26 个受控任务，形成 Tasktracker 16 + Calculator 14 的 30-task planning manifest。
- 任务计划审计器会拒绝重复语义、定义摘要漂移和自报 collection/eligibility；真实临时 clone 预检中，Tasktracker 10 个测试和 Calculator 编译均通过，结论为 `planning_ready` 且 `quality_claim_eligible: false`。
- 重新审视测评目标后，原 Tasktracker/Calculator 30-task 清单已降级为历史规划审计；它主要测编码能力和基础设施可用性，不再作为正式 Verification Policy benchmark。
- 已实现 6 题 Verification Policy pilot：5 个 `verify_only`、1 个 `test_decision`，分别覆盖局部通过、相关回归、全量兜底、通过后停止、flaky 单次重试和必要回归测试。
- 实现临时工作区物化器：从固定 revision 创建 clone，移除原始 Git 历史并只保留一条基线提交，再应用公开代码状态；Agent 无法通过原仓库 commit 找到答案。
- 6/6 工作区通过真实资格检查：正确题通过、回归题失败、全量兜底题只在完整门禁失败、flaky 题结果为失败后通过、隐藏参考测试在新实现通过且在旧实现失败。
- 新增单题 direct-Codex trace 转换入口，绑定公开题目摘要、collector、模型、初始/最终工作区状态；Agent 未被观察到的文件改动会让 trace fail closed。
- `vp_local_correct_stop` 链路 smoke 已完成：完整 trace、6 个 shell 调用、1 个项目级 `npm run check`、Agent 零文件改动、独立相关测试 6/6 通过；该结果显示验证范围超过最小证据。
- `vp_local_correct_stop` 与 `vp_affected_failure` 已使用同一 `codex-cli@0.147.0` / `gpt-5.6-sol` 完成 baseline/candidate 配对 dry run：4/4 trace 完整，4/4 独立 Oracle 通过，4/4 post-run workspace digest 一致；baseline/candidate failure recall 均为 1。
- 两题 dry run 的耗时观察为毫秒量级（1123.2ms→63.6ms、191.2ms→91.2ms），candidate 均为 `mode: shadow`；评估仍为 `evidence_insufficient` / `not_supported`，因为只有 2/6 pilot 题且 quality-claim eligible 为 0/30。百分比不作为结论引用。
- 全仓库 `npm run check` 通过；设计与 smoke 报告仍标记 `quality_claim_eligible: false`。

## 当前未完成

- 尚未把 JSONL ledger 转成统一的 Observatory trace schema。
- 尚未实现诊断型可视化回放：时间线、重复/支配测试、失败扩张、成本和停止点。
- 尚未实现专家模式、傻瓜模式和版本化策略候选。
- 尚未在本仓库 fixtures 上建立可复现的冗余标签与回放回归测试。

## 历史阻塞（不作为当前执行入口）

- agent-belt 探索性 go/no-go 与 timestamped rerun 均通过；当前只有 4 个 editing task 同时具备完整 baseline VerifyTrace 与独立 oracle，read-only task 没有稳定响应 oracle，配对 candidate run 也未开始，真实 eligible baseline 为 4/30。
- 原 26 个受控任务不再继续实现 oracle；旧 planning manifest 只保留为决策历史，不能当成 30/30。
- 三个未显式标记 `test-required` 的场景新增了测试，这只是 `unspecified` 观察，不能据此断言测试无价值；本轮没有任务超过两次即时测试预算，1 个任务超过单测试文件预算。
- Maka 固定 CI-green revision 已通过 `npm ci`、`format:check`、`build:test`、`typecheck` 的真实 preflight，但完整 `npm test` 仍含 PTY、macOS 路径规范化和本机认证能力相关失败；只作为验证样本和环境分类证据。
- 没有完整真实仓库 cohort，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。
- Observatory MVP 的 Issue/PR 仍需按依赖顺序审阅和合并；本地 canonical fixture 不能替代真实 P1/P2 benchmark。
- 6 题 pilot 目前只完成 2/6 同一 Agent/模型的 baseline/candidate 配对，剩余 4 题尚未采集。
- 两题 dry run 的耗时/命令数下降只能作为采集链校准观察，不能声称策略已经节省测试时间或 CI 成本。
- smoke run 未显式固定模型，只能证明链路与现象；固定 `gpt-5.6-sol` 的两次尝试因 provider 凭据 401 失败且未执行任何 Agent 命令，不能计入正式配对。
- 当前 6 题都来自本仓库历史或受控故障，只用于隔离测评合同；正式 30 题仍需从多个真实 JS/TS 仓库选取。

## 下一阶段

1. 先审阅、测试并提交当前 30 项本地改动，确保加固代码、fixture、报告和文档进入远程分支。
2. 先排查 provider 凭据 401，再完成剩余 4/6 题的 baseline/candidate 配对，并保留 trace、独立 Oracle 和 workspace digest 证据。
3. 六题配对成立后重新运行 evaluation；只有链路稳定且不漏故障，才从多个真实 JS/TS 仓库扩展正式 30 题。
4. 按 stacked 依赖顺序审阅 PR #34、#35 及前置 PR；不直接合并默认分支。
