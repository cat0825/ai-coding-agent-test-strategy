# AI Coding Agent Test Strategy

面向 AI 编码代理的测试策略研究：在保留风险覆盖的前提下，减少低价值测试、全量测试和失败后的无效扩张。

## 当前进度

**Observatory MVP 代码和本地 calibration 已完成；真实 benchmark 尚未开始，当前证据不足以支持效率或质量声明。**

- 研究问题已收敛为：解释 Coding Agent 为什么重复、扩大或延迟测试，以及浪费从哪一个决策点开始。
- 第一阶段只做诊断型可视化，服务重度使用 Coding Agent 的个人开发者；不做通用 Agent 观测平台。
- 已完成 Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta 等实践的横向比较。
- 已提炼四档验证强度：`off`、`smoke`、`standard`、`thorough`，并形成状态机、预算、停止规则和 fallback。
- 已实现 `verify.sh`、受影响 workspace 发现、unknown fallback、命令存在性校验和 JSONL 验证账本。
- 已用 Maka 的固定 CI-green revision 完成一次真实 preflight，作为仓库无关实现的验证样本；未改动 Maka 源码。
- 通用 coding-agent baseline cohort 尚未采集；当前证据不足以支持效率或质量声明，详见 [STATUS.md](STATUS.md)。

## 核心结论

解决的问题不是简单地“少写测试”，而是让验证路径按风险、反馈速度、可归因性和预算分层：

1. 编辑阶段优先执行格式化、lint、类型检查、编译和最小 smoke 检查。
2. 只有回归修复、稳定公共行为变化、共享不变量变化或高风险改动才默认新增测试。
3. 提交阶段执行受影响的测试；全量、E2E、mutation 和性能测试放到合并或异步阶段。
4. 定向测试失败后最多进行一次可归因修复和重跑；仍无法归因就停止扩张并报告证据。

## 文档

- [完整研究报告](docs/ai-coding-agent-test-strategy.md)：纵向演进、成熟团队案例、状态机、落地顺序和参考资料。
- [PDF 报告](output/pdf/ai-coding-agent-test-strategy.pdf)：适合阅读和分发的 16 页版本。
- [实验与校准方案](docs/experiment-and-calibration.md)：pilot 设计、指标、fallback 和审计契约。
- [验证行为任务集调研](docs/coding-agent-verification-task-set-research.md)：任务来源、轨迹 schema 和实验阶段建议。
- [当前状态与下一步](STATUS.md)：明确已完成、未完成和下一阶段实现边界。
- [贡献指南](CONTRIBUTING.md)：Issue/PR 边界、验证命令和证据要求。

## 开发检查

提交前执行：

```sh
npm run check
```

该命令执行 JavaScript/shell 语法检查和完整单元测试；Pull Request 会在最低支持 Node 20 与当前 Node 24 上执行同一闸门。

## 构建 PDF

安装 WeasyPrint 后执行：

```sh
./scripts/build-pdf.sh
```

打印源位于 `report/ai-coding-agent-test-strategy.html`，输出固定写入 `output/pdf/`。

## 已实现的工具

```sh
./scripts/verify.sh affected --repo /path/to/repo --policy policies/maka-agent.json
```

这里的 Maka policy 是仓库适配示例，不是产品边界。默认是 plan-only shadow 模式；加 `--execute --mode baseline` 才会执行并把每条命令的耗时、退出码写入 JSONL 账本。

将已验证的 VerifyTrace 生成为无需服务器或网络的静态回放：

```sh
npm run replay -- fixtures/traces/failed-retry.json output/replay/failed-retry.html
```

格式和展示约定见 [静态 trace 回放](docs/trace-replay.md)。

查看 expert/simplified 推荐并可选生成带审计事件的新 trace：

```sh
npm run recommend -- expert fixtures/diagnostics/exact-repeat.json
```

安全边界和决定记录格式见 [推荐模式 v1](docs/recommendation-modes-v1.md)。

运行本地 calibration cohort 评测并生成版本化报告：

```sh
npm run evaluate
```

评测报告会明确区分 `evidence_insufficient`、`rejected` 和可支持效率声明的状态；外部 P1/P2 benchmark 不在 MVP 内。

真实 benchmark 开始前，先对 pinned worktree、runtime、安装证据和 command 前置关系生成脱敏环境清单：

```sh
npm run benchmark:preflight -- --repo /path/to/worktree --spec /path/to/spec.json --output output/benchmark/environment.json
```

契约与 fail-closed 规则见 [Benchmark environment manifest v1](docs/benchmark-environment-v1.md)。

## 下一阶段

只在本仓库内按以下顺序推进：

1. 按公开 coding-agent 项目、CI-green 固定 revision、可重复 install/build/test、独立 clean worktree 的标准选择仓库与任务集，并由 preflight 固定环境。
2. 在同一合格仓库/任务集上采集至少 30 个基线任务和 30 个 shadow 任务，比较命令数、耗时、失败漏检和 fallback 比例。
3. 依据数据校准预算和停止规则，再决定是否在 Agent hook/permission 层启用有限强制。

## 研究时间

初稿：2026-08-08。仓库整理：2026-08-14。
