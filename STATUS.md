# 项目状态

状态：**研究与 PDF 完成 / shadow 工具完成 / Maka pilot 基线受阻**

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

## 未完成

- 尚未完成可用于比较的完整 baseline：`format:check` 已通过（4.282s），但 `typecheck` 在 `npm ci --ignore-scripts` 后缺少 workspace dist，7.722s 失败。
- `npm test` 已进入 `build:test`，但在 `packages/ui` 因 `settledText`、`conversationKey`、`unlockAutoFollow` 等接口不一致失败（12.638s），未进入测试执行。
- 普通依赖已用 `npm ci --ignore-scripts` 安装；完整 postinstall 仍被 `dugite-native` 60MB release 下载链路阻塞，官方 SHA-256 已核实为 `e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437`。
- 没有真实仓库 benchmark，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。

## 下一阶段

1. 确认 Maka 当前 `packages/ui` 接口不一致是上游提交问题还是需要先构建/应用 patch，并在干净 worktree 重跑。
2. 解决 `dugite-native` 下载后完成一次不带 `--ignore-scripts` 的安装，记录 Node/npm 版本。
3. 采集至少 30 个 baseline 与 30 个 shadow 任务；在此之前保持 plan-only，不启用强制。
