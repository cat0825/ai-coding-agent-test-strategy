# 项目状态

状态：**Observatory MVP、state-aware collector v2 与 30-task 规划已实现 / 真实 baseline 证据仍为 4/30**

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

## 未完成

- agent-belt 探索性 go/no-go 与 timestamped rerun 均通过；当前只有 4 个 editing task 同时具备完整 baseline VerifyTrace 与独立 oracle，read-only task 没有稳定响应 oracle，配对 candidate run 也未开始，真实 eligible baseline 为 4/30。
- 26 个受控任务只有固定定义、测试要求和 oracle id，独立 oracle 实现与 baseline trace 尚未采集，不能把 planning manifest 当成 30/30。
- 三个未显式标记 `test-required` 的场景新增了测试，这只是 `unspecified` 观察，不能据此断言测试无价值；本轮没有任务超过两次即时测试预算，1 个任务超过单测试文件预算。
- Maka 固定 CI-green revision 已通过 `npm ci`、`format:check`、`build:test`、`typecheck` 的真实 preflight，但完整 `npm test` 仍含 PTY、macOS 路径规范化和本机认证能力相关失败；只作为验证样本和环境分类证据。
- 没有完整真实仓库 cohort，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。
- Observatory MVP 的 Issue/PR 仍需按依赖顺序审阅和合并；本地 canonical fixture 不能替代真实 P1/P2 benchmark。

## 下一阶段

1. 按 26 个受控任务分批实现独立 oracle，再采集对应 baseline trace；重复 trial 不计新任务。
2. 同步按 stacked 依赖顺序审阅现有 PR；不主动合并。
3. 完成 30 个 baseline 后再实现 candidate/shadow adapter，随后执行 30 对比较与 oracle safety gate。
