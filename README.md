# AI Coding Agent Test Strategy

面向 AI 编码代理的测试策略研究：在保留风险覆盖的前提下，减少低价值测试、全量测试和失败后的无效扩张。

## 当前进度

**Observatory MVP 与 state-aware collector 已完成；Verification Policy pilot 工作区 6/6 合格，单题采集链 smoke 已跑通，但正式 baseline/candidate 仍为 0/6。**

- 已完成 Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta 等实践的横向比较。
- 已提炼四档验证强度：`off`、`smoke`、`standard`、`thorough`。
- 已形成 Agent 验证状态机、测试预算、停止规则和可直接放入 `AGENTS.md` 的策略模板。
- 已修复 PDF 代码块裁切并提供可复现构建入口。
- 已定义 pilot 指标、预算校准、保守 fallback、命令归一化和 override 审计方案。
- 已实现 `verify.sh`、受影响 workspace 发现、unknown fallback、命令存在性校验和 JSONL 验证账本。
- 已用 Maka 的固定 CI-green revision 完成一次真实 preflight，作为仓库无关实现的验证样本；未改动 Maka 源码。
- 通用 baseline cohort 已采集 4 个 editing task；cohort auditor 输出 `4/30`、`evidence_insufficient`，详见 [STATUS.md](STATUS.md) 与 [agent-belt-baseline-report.json](fixtures/benchmark/agent-belt-baseline-report.json)。
- 原 Issue #30 的 Calculator/Tasktracker 30-task 清单已降级为历史规划审计，不再继续扩写 oracle。
- 已建立与产品目标直接对应的 6 题 Verification Policy pilot；隔离工作区和隐藏 oracle 资格检查为 6/6，详见 [Verification Policy Benchmark v0.1](docs/verification-policy-benchmark-v0.1.md)。
- `vp_local_correct_stop` 已产出一条完整脱敏 smoke trace：正确性与不改文件均通过，但观察到 6 个 shell 调用和项目级 `npm run check`；因模型未显式绑定，不计入正式 baseline。

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
- [Verification Policy Benchmark v0.1](docs/verification-policy-benchmark-v0.1.md)：六题隔离测评、隐藏判分和当前证据边界。
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

环境合格后，用 baseline cohort 审计器计算真实任务证据，不接受输入文件直接声明任务合格：

```sh
npm run benchmark:cohort -- \
  --cohort /path/to/baseline-cohort.json \
  --environment /path/to/environment.json \
  --output output/benchmark/baseline-report.json
```

审计器会校验仓库身份、固定 revision、环境清单摘要、安装/构建/测试证据和完整 baseline VerifyTrace，并明确输出距 30 个质量声明任务的证据缺口。结果为 `evidence_insufficient` 时退出码为 2；这不是失败伪装成成功。字段与资格规则见 [Baseline cohort v1](docs/baseline-cohort-v1.md)。

对 agent-belt 真实 run 做脱敏的探索性 pilot 审计：

```sh
npm run benchmark:pilot -- \
  --run /path/to/agent-belt-outcomes/run-id \
  --environment fixtures/benchmark/agent-belt-environment.json \
  --output output/benchmark/agent-belt-pilot-report.json
```

该命令从结构化 outcome 统计测试文件改动、测试 runner 次数、非零次数和预算观察，不保留原始命令、输出、绝对路径或认证信息。`pilot_decision: go` 只允许继续采集，不会把探索性任务计入 baseline；契约与首个 5-task 结果见 [Agent-belt pilot audit v1](docs/agent-belt-pilot-audit-v1.md)。

对 agent 完成后的隔离工作区执行外置功能 oracle：

```sh
npm run benchmark:oracle -- \
  --task l2_fix_formatter_bug \
  --repo /path/to/post-agent-worktree \
  --environment fixtures/benchmark/agent-belt-environment.json \
  --output output/benchmark/oracles/l2_fix_formatter_bug.json \
  --allow-host
```

当前 4 个 editing task 的独立 oracle 均通过，且未使用 agent 自己编写的测试；`l1_find_bug` 因缺少稳定响应 oracle 被排除。Host 模式必须显式开启且只传最小环境，它仍不是 sandbox，不应用于未经审查的 agent 代码。完整边界见 [Agent-belt independent oracles v1](docs/agent-belt-independent-oracles-v1.md)。

审计 41 个上游场景并预检 30 个不同任务的规划清单：

```sh
npm run benchmark:tasks -- \
  --plan fixtures/benchmark/agent-belt-task-plan.json \
  --agent-belt /path/to/pinned/agent-belt \
  --output fixtures/benchmark/agent-belt-task-plan-report.json \
  --allow-host
```

该命令只验证任务唯一性、源文件摘要、fixture revision、reset 和原始测试；`planning_ready` 不等于 30/30，清单不能声明 collection status 或质量资格。

该清单现仅作为历史规划审计保留，正式方向已经切换到 Verification Policy pilot。验证六题合同并实际复现工作区：

```sh
npm run benchmark:verification -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --output fixtures/benchmark/verification-policy-pilot-report.json

npm run benchmark:verification:qualify -- \
  --plan fixtures/benchmark/verification-policy-pilot-plan.json \
  --oracles fixtures/benchmark/verification-policy-pilot-oracles.json \
  --repo . \
  --output fixtures/benchmark/verification-policy-pilot-qualification.json
```

前者检查任务结构和隐藏答案隔离；后者从固定 revision 创建临时工作区并实际验证六种退出模式。当前结果为 `fixture_ready: 6/6`，仍不等于配对实验完成。

单题 Agent run 使用 `npm run benchmark:verification:prepare` 创建无原始 Git 历史的工作区，再用 `npm run benchmark:verification:trace` 转换 lifecycle；参数、模型绑定和当前 smoke 边界见 [Verification Policy Benchmark v0.1](docs/verification-policy-benchmark-v0.1.md)。

为新的 agent-belt run 采集带 UTC/monotonic 时间的 Codex shell lifecycle sidecar，并生成 fail-closed VerifyTrace：

```sh
npm run benchmark:trace:prepare -- \
  --real-codex /path/to/real/codex \
  --bin-dir /private/path/to/collector-bin \
  --lifecycle-dir /private/path/to/lifecycle

npm run benchmark:trace -- \
  --run /path/to/agent-belt-outcomes/run-id \
  --lifecycle-dir /private/path/to/lifecycle \
  --environment fixtures/benchmark/agent-belt-environment.json \
  --output-dir output/benchmark/traces
```

Collector v2 不保存命令、输出、凭据或绝对工作区路径；它保存脱敏后的相对文件变化和起始目录摘要。转换器为工作目录、环境和目标参数生成不可逆摘要，将文件变化按观察时间写入 trace，并只从 `turn.completed` / `turn.failed` 生成 stop。缺失、重复、乱序、不匹配或无法解释的证据一律 fail closed。旧 collector-v1 trace 仍可回放，但不能产出重复测试结论。集成与安全边界见 [Agent-belt timestamped VerifyTrace collection](docs/agent-belt-timestamped-trace-v1.md)。

## 后续评测

下一阶段按以下顺序推进：

1. 在 6 个 Verification Policy pilot 现场上，使用同一 Agent/模型分别采集策略关闭与开启的配对 VerifyTrace。
2. 只有六题均不漏故障且能测出停止、重试和全量兜底差异，才从多个真实 JS/TS 仓库扩展正式任务。
3. 正式任务达到 30 对后再执行 oracle safety gate；在此之前不做效率宣传，也不迁移 DSH。

## 研究时间

初稿：2026-08-08。仓库整理：2026-08-14。
