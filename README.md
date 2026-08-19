# AI Coding Agent Test Strategy

面向 AI 编码代理的测试策略研究：在保留风险覆盖的前提下，减少低价值测试、全量测试和失败后的无效扩张。

## 当前进度

**主线已锁定为 Agent Verification Observatory：策略研究和 shadow 基础完成，诊断型可视化尚未开始。**

- 研究问题已收敛为：解释 Coding Agent 为什么重复、扩大或延迟测试，以及浪费从哪一个决策点开始。
- 第一阶段只做诊断型可视化，服务重度使用 Coding Agent 的个人开发者；不做通用 Agent 观测平台。
- 已完成 Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta 等实践的横向比较。
- 已提炼四档验证强度：`off`、`smoke`、`standard`、`thorough`，并形成状态机、预算、停止规则和 fallback。
- 已实现 `verify.sh`、受影响 workspace 发现、unknown fallback、命令存在性校验和 JSONL 验证账本。
- 已形成实验指标、任务集调研和 ground-truth 方案；真实 benchmark 尚未开始。
- 旧 Maka pilot 只作为历史验证记录，不再是本项目当前下一步。

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

默认是 plan-only shadow 模式；加 `--execute --mode baseline` 才会执行并把每条命令的耗时、退出码写入 JSONL 账本。

将已验证的 VerifyTrace 生成为无需服务器或网络的静态回放：

```sh
npm run replay -- fixtures/traces/failed-retry.json output/replay/failed-retry.html
```

格式和展示约定见 [静态 trace 回放](docs/trace-replay.md)。

## 下一阶段

只在本仓库内按以下顺序推进：

完整依赖和验收闸门见 [Observatory MVP 路线图](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/1)：

1. [发布范围、状态与任务集研究](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/2)。
2. [增加 CI 与贡献闸门](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/3)。
3. [冻结 VerifyTrace v1 schema 与三类 fixture](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/4)。
4. [实现确定性 trace 诊断](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/5)。
5. [生成自包含 HTML 回放](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/6)。
6. [增加专家模式与简化模式](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/7)。
7. [建立 MVP 评测与安全闸门](https://github.com/cat0825/ai-coding-agent-test-strategy/issues/8)。

在上述链路跑通前，不启用硬拦截，不宣称真实项目提速或质量不变。

## 研究时间

初稿：2026-08-08。仓库整理：2026-08-14。
