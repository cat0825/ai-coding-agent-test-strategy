# 项目状态

状态（2026-08-25）：**机制已全部落地(采集 → trace → 审计 → 强制)/ 六题配对 6/6 完成且全部通过审计 / 正式配对样本 6/30 / 有效 oracle 失败样本 0/10 / 评估仍为 `evidence_insufficient`,`efficiency_claim: not_supported`**

硬阻塞只有一个:#58 —— 闸门按整串正则匹配,决策却按段分解,两把尺子不一致:`vp_unknown_impact_full_fallback` 上过闸 31 次、白丢 5 次。不修的话,扩量后采到的每一对都掺同样噪声,现有数字也永远不能当效率结论读。(#57 已于 2026-08-25 落地并关闭,commit `9c7c9c9`,详见"下一阶段"。)

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

### 2026-08-20 之后新增

- 六题配对已全部采集完成(#36 从 2/6 走到 6/6)：12 条 trace 全部 `complete`、`warnings: []`、0 条 partial；12/12 工作区摘要吻合(未观测执行 0、未过闸执行 0)；审计器从原始证据重算 7 个字段,不采信采集器自述,6/6 配对通过。六题 `quality_claim_eligible: true` 全过,卡在 `conclusion` 那一层 —— 是数量不够,不是质量不合格。
- candidate 臂不再只是 shadow 观察：deny 已真正强制(#52),L2 改写路径首次拿到配对证据(#56)。本轮记录 140 个策略决策事件,含 5 次 deny、2 次 rewrite 生效。
- 外部 fixture 环境资格已落地(#53 / #39)：`pinojs/pino`(service_library)、`pmndrs/zustand`(web_frontend)、`yargs/yargs`(cli_tool 外部)三个通过资格检查。另有 6 个候选被拒且理由在案,没有为凑数放宽 —— 其中 commander 在 `CI=1 NO_COLOR=1` 下 2/1373 失败属环境冲突,没打补丁,因为为单个 fixture 放宽 runner 环境会让它和其他 fixture 不可比。
- VerifyTrace 已补 `wait` 事件类型(#50),轮询不再被误判为 `exact_repeat`(#38 解决)。
- 三个审计脚本已签入版本库：`scripts/audit-verification-runs.mjs`、`collect-verification-run.mjs`、`publish-verification-run.mjs`。`docs/verification-policy-benchmark-v0.1.md` 按行号引用的证据不再悬空。
- PR #49–#56 全部合并,Open PR 为 0。

## 当前未完成

四个硬门槛写在 #17 验收标准里,任何一条不满足,评估就停在 `evidence_insufficient`,不允许对外说"省了多少"或"没漏故障"。

- **有效 oracle 失败样本 0/10（#57 已落地,但门槛仍未满足)。** 原来记着的那 1 条失败签名已经撤掉:`vp_flaky_retry_once` 的 oracle 现在声明 `status: "undecided"`、交空的 `failure_signatures`,不再冒充判定。这清掉了假样本,没有变出真样本 —— `minimum_oracle_failures`（`src/evaluation.mjs:9`）数的是失败签名,现在如实为 0。这个门槛要由其余五题里能因正确原因失败的 oracle 来满足,或者新出的题来满足;30 对可以靠时间堆出来,失败样本不行。
- **配对比较数 6/30。** 6 对全部通过审计,还缺 24 对。`minimum_quality_claim_comparisons_not_met`。
- **场景覆盖 2/2 —— 已满足（2026-08-26）。** 门槛是 2 类(`src/verification-benchmark.mjs:18` 的 `MINIMUM_GENERALIZED_SCENARIO_CLASSES = 2`),不是 4 类 —— 四类(`cli_tool` / `web_frontend` / `service_library` / `research_script`)是枚举全集,不是要求。`vp_external_boundary_diagnosis` 落在 `external-pino`(`service_library`)后,`scenario_classes` 为 `{cli_tool: 6, service_library: 1}`、`generalized: true`,`scenario_classes_not_generalized` 已从 blockers 消失(设计审计实测)。**注意这是设计层满足**:审计里 `task_workspaces_not_materialized` / `independent_oracles_not_executed` / `paired_traces_not_collected` 三条仍在,这一条不代表已采到配对证据。
- **外部 fixture 已出题 1/3。** 环境资格过了不等于已观测到该场景下的验证行为 —— 场景覆盖按**题目**算,不按 fixture 算。pino 有 1 题;yargs / zustand 仍 0 题,资格早就过了但没题就不进覆盖。资格实跑:带 `--fixture-repo external-pino=PATH` 时 `fixture_ready: 7/7`(47 秒);CI 无外部 checkout 时该题记 `skipped` 并在 blockers 里点名 `external_fixture_checkouts_not_supplied`,不冒充已观测。
- **闸门有缺陷,在虚耗调用。** 闸门用整串正则、判定按段分解,两把尺子不一致:一条 `rg` 命令只要搜索模式里出现 `pytest` 就被当成测试命令,逐段分解找不到 runner,fail-closed 拒掉。代价能精确算 —— `vp_unknown_impact_full_fallback` 过闸 31 次,白丢 5 次。必须在扩量前修,否则 30 对里每一对都掺同样噪声。

## 证据边界与历史决策（仍然生效的约束）

- agent-belt 探索性 go/no-go 与 timestamped rerun 均通过；当前只有 4 个 editing task 同时具备完整 baseline VerifyTrace 与独立 oracle，read-only task 没有稳定响应 oracle，配对 candidate run 也未开始，真实 eligible baseline 为 4/30。
- 原 26 个受控任务不再继续实现 oracle；旧 planning manifest 只保留为决策历史，不能当成 30/30。
- 三个未显式标记 `test-required` 的场景新增了测试，这只是 `unspecified` 观察，不能据此断言测试无价值；本轮没有任务超过两次即时测试预算，1 个任务超过单测试文件预算。
- Maka 固定 CI-green revision 已通过 `npm ci`、`format:check`、`build:test`、`typecheck` 的真实 preflight，但完整 `npm test` 仍含 PTY、macOS 路径规范化和本机认证能力相关失败；只作为验证样本和环境分类证据。
- 没有完整真实仓库 cohort，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。
- Observatory MVP 的 Issue/PR 仍需按依赖顺序审阅和合并；本地 canonical fixture 不能替代真实 P1/P2 benchmark。
- 6 题 pilot 配对已 6/6 采集完成（#36），但六题全部出自本仓库历史，`generalized: false`；
  正式 30 对仍需从多个真实 JS/TS 仓库取题。
- 两题 dry run 的耗时/命令数下降只能作为采集链校准观察，不能声称策略已经节省测试时间或 CI 成本。
- smoke run 未显式固定模型，只能证明链路与现象；固定 `gpt-5.6-sol` 的两次尝试因 provider 凭据 401 失败且未执行任何 Agent 命令，不能计入正式配对。
- 当前 6 题都来自本仓库历史或受控故障，只用于隔离测评合同；正式 30 题仍需从多个真实 JS/TS 仓库选取。

## Issue 与 PR 现状（2026-08-25）

- Open PR 为 0。#49–#56 全部合并,其中 #55(外部仓库取题)与 #56(L2 改写)是 stacked,已按 #55 → #56 顺序合入。
- #36 已走到 6/6,六题配对采集完成。#38(`wait` 事件)由 #50 解决,#39(外部取题)由 #55 落地,deny 强制由 #52 落地。
- 仍开启(5 个):**#58**(闸门整串匹配 vs 分段决策 —— 唯一硬阻塞,扩量前必修)、**#59**(在 pino 上出第一道外部仓库任务,达成场景类 2/2 —— **题面已落地,待 PR 合并**)、#16(baseline cohort)、#17(candidate cohort 与安全门,当前 6/30)、#1(roadmap)。
- #57 已于 2026-08-25 关闭(落地 commit `9c7c9c9`),#43 已于 2026-08-24 关闭(candidate 真机强制策略已有签入证据:`unscoped_test_command_denied` 真机触发)。#1 路线图中 #38 / #40 / #44 / #45 四个已完成项均已勾选,当前未勾选项即 #58 与 #59。

## 下一阶段

按"解锁了什么"排,不按工作量排。1 和 2 都必须在 3 之前,因为它们决定采集到的数据算不算数;3 必须在 4 之前,因为它验证流水线。

~~1. 拍板 #57 的 oracle 怎么修。~~ **已于 2026-08-25 定案并落地(commit `9c7c9c9`)**:声明这题不由 oracle 判、只认 trace 证据,审计器能标出结构上判不了的 oracle。三条路里唯一不破坏"审计独立于采集"这条主纪律的。采集链路的判定语义现在是干净的,后面采到的数据算数。

1. **闸门改按段判定(v0.5)后重采（#58)。** 不改就一直虚耗调用,且现有数字永远不能当效率结论读。必须在扩量之前。
~~2. 在 `pino` 上出第一道题（#59)。~~ **题面已落地,待 PR 合并（2026-08-26）**:`vp_external_boundary_diagnosis`,`lib/levels.js` 的 `compareLevel` 升序分支丢边界,fast 层 0.2 秒退出码 1(16 pass / 6 fail)。场景类 2/2 已满足,外部出题流水线走通了一遍——但也暴露物化根本不装依赖(observatory 零依赖所以从没暴露),补了 `provisionFixtureDependencies` 从资格 checkout 拷 `node_modules`。设计文:`docs/oracle-failure-sample-design.md`。
3. **扩到 30 对（#17)。** 前两步做完这步才是纯堆量:24 对,按六题一轮算四轮,可放后台批跑。直接冲 30 对的风险是万一外部出题有坑,24 对全白跑。
