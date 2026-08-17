# 项目状态

状态：**Observatory MVP 实现完成 / 本地 calibration 通过 / 真实 benchmark 证据不足**

## 已完成

- 完成 AI 编码代理测试策略的纵向分析：测试大小、测试金字塔、回归测试选择、增量分析和测试质量审计。
- 完成横向案例分析：Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta、Microsoft、GitLab、Kubernetes。
- 定义 `off`、`smoke`、`standard`、`thorough` 四档验证强度。
- 定义 Agent 状态机：分类变更、发现受影响测试、一次定向执行、失败归因、必要时升级。
- 定义默认预算建议：最多新增 1 个测试文件、最多执行 2 次即时测试、即时测试时间上限 90 秒。
- 提供可直接复制到 `AGENTS.md` 的测试策略模板。
- 修复 PDF 中 `AGENTS.md` 模板的右侧裁切，加入打印源、构建脚本和 16 页成品。
- 完成实验与校准方案：指标、初始门槛、fallback、命令归一化和 override 账本。
- 选定 `maka-agent` 作为首个 pilot 候选；正式实验必须使用干净的独立 worktree。
- 实现 `src/verifier.mjs`、`src/cli.mjs` 和 `scripts/verify.sh`，支持 `fast|affected|full`、受影响 workspace 闭包、保守 fallback 和 JSONL 账本。
- 增加 policy 中 npm script 的存在性校验；Maka policy 已对齐实际的 `format:check`、`typecheck` 和 `test`。
- 在 `/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot` 完成四类 dry-run，worktree 基于 `origin/main@938487ea` 且未修改 Maka 文件。
- 定义 VerifyTrace v1，并实现旧 ledger 转换、确定性重复/重试诊断和无网络依赖的 HTML 回放。
- 实现 expert/simplified 推荐模式；只有低风险、高置信重复可自动处理，推荐与决定均进入可验证 trace。
- 实现一命令 evaluation harness；本地 7 条 trace 和 4 个配对任务的结论为 `evidence_insufficient`，不支持效率声明。

## 未完成

- 尚未完成可用于比较的完整 baseline：`format:check` 已通过（4.282s），但 `typecheck` 在 `npm ci --ignore-scripts` 后缺少 workspace dist，7.722s 失败。
- `npm test` 已进入 `build:test`，但在 `packages/ui` 因 `settledText`、`conversationKey`、`unlockAutoFollow` 等接口不一致失败（12.638s），未进入测试执行。
- 普通依赖已用 `npm ci --ignore-scripts` 安装；完整 postinstall 仍被 `dugite-native` 60MB release 下载链路阻塞，官方 SHA-256 已核实为 `e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437`。
- 没有真实仓库 benchmark，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。
- Observatory MVP 的 Issue/PR 仍需按依赖顺序审阅和合并；本地 canonical fixture 不能替代真实 P1/P2 benchmark。

## 下一阶段

1. 按 stacked 依赖顺序审阅并合并 VerifyTrace、诊断、回放、推荐模式和 evaluation PR。
2. 确认 Maka 当前 `packages/ui` 接口不一致及 `dugite-native` 安装阻塞，在干净 worktree 重跑。
3. 采集至少 30 个 quality-claim-eligible baseline/candidate 对和足量 oracle failures；在此之前保持 shadow，不启用强制或效率宣传。
