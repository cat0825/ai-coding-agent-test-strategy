# 项目状态

状态：**Agent Verification Observatory 方向已锁定 / 策略基础完成 / 可视化尚未开始**

## 直接对话已确认的方向

- **主线**：Agent × 可视化；开源贡献是训练软件开发能力的手段，不另开主线。
- **核心问题**：解释 Agent 的验证行为，尤其是重复测试、过度扩大、失败后无效重跑和停止点。
- **第一阶段产品**：诊断型可视化，先看清行为，再做干预；不做通用 Agent 观测平台。
- **目标用户**：重度使用 Coding Agent 的个人开发者，目标是更快迭代并减少不必要的验证。
- **控制模式**：同一策略引擎提供专家模式和傻瓜模式；低风险冗余可自动处理，高风险变更必须确认。
- **论文问题**：重点回答“浪费从哪一步开始、为什么发生”，不做简单的 Agent 测试次数排行榜。
- **事实裁判**：确定性规则先筛选，模型只做结构化预标注，模糊和高风险案例由人工定案。

## 分阶段进度

| 工作流 | 当前状态 | 证据 |
|---|---|---|
| 研究问题与产品边界 | 已完成 | 本节方向决策 |
| 策略研究、预算与状态机 | 已完成 | `docs/ai-coding-agent-test-strategy.md` |
| Shadow planner、affected 选择和 JSONL ledger | 已完成 | `src/`、`test/`、`scripts/verify.sh` |
| 实验任务集和 ground truth 设计 | 已形成方案 | `docs/coding-agent-verification-task-set-research.md`、`docs/experiment-and-calibration.md` |
| Observatory 事件 schema | 未开始 | 下一检查点 |
| 诊断型 trace 回放 | 未开始 | 下一检查点 |
| 专家/傻瓜模式建议 | 未开始 | 依赖回放和标签 |
| 外部真实任务评测 | 未开始 | 不作为当前阶段入口 |

## 已完成

- 完成 AI 编码代理测试策略的纵向分析：测试大小、测试金字塔、回归测试选择、增量分析和测试质量审计。
- 完成横向案例分析：Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta、Microsoft、GitLab、Kubernetes。
- 定义 `off`、`smoke`、`standard`、`thorough` 四档验证强度。
- 定义 Agent 状态机：分类变更、发现受影响测试、一次定向执行、失败归因、必要时升级。
- 定义默认预算建议：最多新增 1 个测试文件、最多执行 2 次即时测试、即时测试时间上限 90 秒。
- 提供可直接复制到 `AGENTS.md` 的测试策略模板。
- 修复 PDF 中 `AGENTS.md` 模板的右侧裁切，加入打印源、构建脚本和 16 页成品。
- 完成实验与校准方案：指标、初始门槛、fallback、命令归一化和 override 账本。
- 曾选定 `maka-agent` 作为 pilot 候选，并在独立 worktree 完成 dry-run；该结果保留为历史验证记录，不再作为当前主线的下一步。
- 实现 `src/verifier.mjs`、`src/cli.mjs` 和 `scripts/verify.sh`，支持 `fast|affected|full`、受影响 workspace 闭包、保守 fallback 和 JSONL 账本。
- 增加 policy 中 npm script 的存在性校验；Maka policy 已对齐实际的 `format:check`、`typecheck` 和 `test`。
- 在 `/Users/qianyuhe/Documents/GitHub/maka-agent-test-strategy-pilot` 完成四类 dry-run，worktree 基于 `origin/main@938487ea` 且未修改 Maka 文件。

## 当前未完成

- 尚未把 JSONL ledger 转成统一的 Observatory trace schema。
- 尚未实现诊断型可视化回放：时间线、重复/支配测试、失败扩张、成本和停止点。
- 尚未实现专家模式、傻瓜模式和版本化策略候选。
- 尚未在本仓库 fixtures 上建立可复现的冗余标签与回放回归测试。

## 历史阻塞（不作为当前执行入口）

- 尚未完成可用于比较的完整 baseline：`format:check` 已通过（4.282s），但 `typecheck` 在 `npm ci --ignore-scripts` 后缺少 workspace dist，7.722s 失败。
- `npm test` 已进入 `build:test`，但在 `packages/ui` 因 `settledText`、`conversationKey`、`unlockAutoFollow` 等接口不一致失败（12.638s），未进入测试执行。
- 普通依赖已用 `npm ci --ignore-scripts` 安装；完整 postinstall 仍被 `dugite-native` 60MB release 下载链路阻塞，官方 SHA-256 已核实为 `e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437`。
- Maka baseline 曾因 `dugite-native` 下载、workspace dist 缺失和 `packages/ui` 接口不一致受阻；这不影响当前仓库内的 Observatory 开发。
- 尚无真实仓库 benchmark，不能声称已经减少测试耗时或 CI 成本；也没有启用 Agent hook/permission 强制。

## 下一阶段

执行以 [Observatory MVP 总路线图 #1](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/1) 为准：

1. [#2](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/2) 发布当前范围、状态与任务集研究。
2. [#3](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/3) 建立 CI 与 PR 证据闸门。
3. [#4](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/4) 冻结事件 schema 和三类最小 trace fixture。
4. [#5](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/5) 实现确定性重复/重试诊断和证据引用。
5. [#6](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/6) 生成只读 HTML 回放并做浏览器验证。
6. [#7](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/7) 增加共用策略引擎下的专家与简化模式。
7. [#8](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/8) 建立本地评测与安全闸门。

依赖顺序为 `#2 → #4 → #5 → #6 → #7 → #8`；#3 在 #2 后建立，且必须在 #4 合并前生效。回放和标签稳定前不接外部 benchmark，不做硬拦截。

## 当前范围红线

- 只修改本仓库；不继续建设 `testguard`、`research-console-private`、Maka、VPS/Hermes。
- 不新增第二个同类仓库，不把“跑了更多测试”当作进度，不以单一耗时数字宣称成功。
