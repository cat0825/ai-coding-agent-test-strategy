# 项目状态

状态：**Observatory MVP 与 baseline 审计闸门实现完成 / 本地 calibration 通过 / 真实 benchmark 证据 0/30**

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

## 未完成

- 尚未按通用选择标准确定最终 coding-agent 仓库/任务集；真实 quality-claim-eligible baseline tasks 为 0/30，审计工具通过不等于效果已经证明。
- Maka 固定 CI-green revision 已通过 `npm ci`、`format:check`、`build:test`、`typecheck` 的真实 preflight，但完整 `npm test` 仍含 PTY、macOS 路径规范化和本机认证能力相关失败；只作为验证样本和环境分类证据。
- 没有完整真实仓库 cohort，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。
- Observatory MVP 的 Issue/PR 仍需按依赖顺序审阅和合并；本地 canonical fixture 不能替代真实 P1/P2 benchmark。

## 下一阶段

1. 按 stacked 依赖顺序审阅 PR #19 与 PR #21；不主动合并。
2. 按公开性、CI-green revision、可重复 install/build/test 和 clean worktree 标准选择一个或多个 coding-agent 仓库/任务集。
3. 使用 baseline cohort 审计器采集至少 30 个合格 baseline tasks，再在相同任务上完成 candidate 配对和 oracle safety gates；在此之前保持 shadow，不启用强制或效率宣传。
