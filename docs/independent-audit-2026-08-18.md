# Agent Verification Observatory 独立审查报告

日期：2026-08-18

审查对象：`/Users/qianyuhe/Documents/ChatGPT/llm test`

关联上下文：Codex 会话 `01a013c8-61c6-7051-918f-c9a808154337`

审查方式：先读取历史会话，再脱离历史结论独立检查当前 checkout、源码、测试、fixture、报告和 Git 分支状态。本报告不把前一模型的判断视为事实，事实均以当前项目文件或现场命令为准。

## 一、执行摘要

当前项目已经形成一个有一定完整度的离线验证框架，具备以下能力：

- VerifyTrace 生成、校验、诊断和 HTML 回放；
- benchmark 环境预检和任务资格审计；
- verification policy pilot fixture 及隔离工作区；
- 独立 oracle 的基础执行链路；
- baseline cohort 和 evaluation report 生成。

但项目目前还不能被定义为已经验证有效的 agent 测试策略，也不能支撑以下结论：

- 测试耗时已经下降；
- CI 成本已经下降；
- 测试质量没有下降；
- 可以在生产环境自动强制编码代理执行该策略；
- 已经完成正式 benchmark。

更准确的当前定位是：

> 离线验证规划器、VerifyTrace 采集/诊断/回放，以及 benchmark qualification/audit 工具。

当前最重要的问题不是继续增加功能或任务数量，而是修复证据可信度。多个入口仍然接受调用方自报的摘要、revision、oracle 状态或失败签名。若不先修复这些信任边界，即使完成 30/30 任务，也可能得到格式完整但来源不可信的 benchmark 证据。

## 二、当前状态

### 已确认可用

- `npm run check` 通过；包含语法检查、Python AST 检查、Shell 语法检查和测试。
- 当前 checkout 的测试结果为 `99/99` 通过。
- Verification Policy pilot 的 6 个 fixture 可以复现其声明的退出码模式。
- agent-belt 当前只有 4 个任务同时具备完整 baseline VerifyTrace 和独立 oracle。
- cohort auditor 当前输出真实 eligible baseline 为 `4/30`，结论为 `evidence_insufficient`。

### 尚未完成

- Verification Policy 正式 baseline/candidate 配对为 `0/6`。
- 没有固定同一 Agent/模型的完整 baseline 与 candidate 对照证据。
- 没有真实证据证明效率提升或质量保持。
- 多个 stacked PR 仍未完成审阅和默认分支集成。
- CI 主要验证代码和单元测试，没有验证真实 benchmark、报告重生成或 replay artifact 一致性。

### 交付状态

当前分支是：

```text
codex/issue-30-qualify-baseline-tasks
```

它相对 `origin/codex/publish-research` 领先 44 个提交。当前 checkout 更接近多个 stacked PR 的综合验收分支，不是已经稳定发布的默认交付主线。

## 三、关键问题

### P0：collector 来源没有被真实绑定

位置：

- `src/verification-trace-cli.mjs:84-95`
- `src/verification-trace-cli.mjs:137-160`

CLI 只检查 `collector.collector_sha256` 是一个格式正确的 SHA-256 字符串，并将其写入 trace。它没有：

- 对 collector 文件内容本身计算 SHA-256；
- 验证 collector 是否是项目实际使用的 wrapper/实现；
- 验证 collector manifest 的版本、路径和实现摘要；
- 在 trace 中记录可独立验证的 collector 来源证据。

因此，调用方可以构造一个假的 collector JSON，手动填写摘要，再让 lifecycle 记录同一个摘要。当前逻辑可能接受这份记录。

**影响**

trace 只能证明输入字段彼此一致，不能证明生命周期证据确实由受控 collector 生成。审计链的来源可信度失效。

**改进要求**

- CLI 自己读取并计算 collector manifest 摘要；
- 同时绑定实际 wrapper/collector 实现摘要；
- 记录 collector 版本和受控来源；
- 不接受调用方自报摘要作为信任根；
- 增加篡改 collector 后必须拒绝的回归测试。

### P0：workspace 没有完整绑定到 task source/base revision

位置：

- `src/verification-trace-cli.mjs:87-108`
- `src/verification-trace-cli.mjs:145-152`

当前 CLI 验证的是：

```text
当前 workspace HEAD == manifest.workspace_revision
```

但没有验证：

```text
workspace HEAD == task.definition.source.base_revision
```

也没有验证 manifest 是否由受控 materializer 生成，或初始 workspace digest 是否对应目标 fixture 的真实 base 状态。

**影响**

调用方可以在另一个 Git workspace 中构造匹配该 workspace 的 manifest，并把运行结果归档为目标 task 的 trace。task definition digest 正确，不等于实际执行仓库状态正确。

**改进要求**

trace 生成前必须验证并绑定：

- repository identity；
- task source/base revision；
- materialization provenance；
- initial workspace state digest；
- changed-file 初始摘要；
- fixture 与 workspace 的关系。

这些字段应由受控流程生成或重新计算，不应只依赖调用方传入。

### P0：cohort auditor 信任调用方声明的 oracle 结果

位置：

- `src/cohort.mjs:97-109`
- `src/cohort.mjs:115-136`
- `src/cohort.mjs:153-167`

`task.evidence.oracle_status` 和 `oracle_failure_signatures` 只做格式校验。auditor 不读取独立 oracle report，也不验证：

- oracle report 的 task id；
- oracle report 的 workspace digest；
- oracle definition digest；
- oracle 结果和 trace 最终结果是否一致；
- failure signatures 是否真的来自 oracle 输出。

因此，修改 cohort evidence 字段就可能把没有真实 oracle 支持的任务计入 `quality_claim_eligible_tasks`。

**影响**

这是项目当前最核心的 correctness 和审计问题。资格结果不是从独立证据推导，而是部分由被审计输入自报。

**改进要求**

- cohort manifest 只引用 oracle report 路径或 digest；
- auditor 自己读取并校验 oracle report；
- 绑定 task、repository、revision、workspace digest 和 oracle definition；
- 根据 oracle report 重新计算资格；
- trace 与 oracle 结果冲突时 fail closed；
- 增加伪造 passed/failed/signature 的反例测试。

### P1：独立 oracle 仍接受伪造的环境摘要

位置：

- `src/oracle.mjs:143-173`
- `src/oracle-cli.mjs:41-49`

`runTasktrackerOracle`：

- 不检查实际 repo 的 Git revision；
- 不检查实际 repository identity；
- 接受调用方传入的 `environmentSourceDigest`；
- 将该摘要直接写入 oracle report。

**影响**

oracle report 的环境字段可能只是调用方声明，不是执行事实。独立 oracle 的可复现性和来源证明被削弱。

**改进要求**

oracle 自己读取并计算：

- 当前 repository identity；
- 当前 HEAD；
- environment manifest 原文摘要；
- oracle definition 原文摘要。

输入环境与实际 workspace 不一致时必须拒绝。

### P1：qualification 只验证退出码形状，不验证失败语义

位置：

- `src/verification-workspace.mjs:248-300`
- `src/verification-benchmark.mjs:181-210`

qualification 当前主要检查如下模式：

```text
[0]
[1]
[0, 0, 1]
[1, 0]
```

但没有充分验证非零退出码对应的具体失败原因。比如预期为 formatter bug 的 fixture，如果被替换成语法错误，只要退出码模式不变，就可能仍被视为合格。

**影响**

`6/6 fixture_ready` 只能证明退出码模式被复现，不能证明 fixture 真实代表声明的验证语义。

**改进要求**

每个 oracle 应定义稳定 failure signature，并在 qualification 中匹配：

- 错误类型；
- 测试名称；
- 相关文件；
- 必要时规范化错误摘要。

增加“故意替换成另一种同退出码故障”的反例测试。

### P1：验证入口与测试策略不一致

直接执行 `npm test` 会被仓库 testguard 拒绝，要求使用 `./scripts/verify.sh affected` 或 `./scripts/verify.sh full`。但 `verify.sh` 当前只是转发到 Node CLI，直接执行 affected 模式又可能因缺少 `--repo` 返回 `--repo is required`。

**影响**

文档、testguard 和实际 wrapper 的约定不一致。后续代理可能无法使用仓库推荐入口完成验证，或者把入口失败误判为代码失败。

**改进要求**

统一并测试以下入口之一：

```text
./scripts/verify.sh affected --repo .
./scripts/verify.sh full --repo .
```

或修改 wrapper，使 `affected/full` 真正映射到仓库定义的检查流程，并增加命令级 smoke test。

### P1：默认交付主线尚未形成

当前多个 `codex/*` 分支并行存在，功能通过 stacked PR 逐层堆叠。这个开发方式本身没有问题，但目前尚未完成：

- 基础 PR 的人工审阅；
- 依赖顺序确认；
- 默认分支集成；
- 单一可复现 release baseline；
- 合并后的完整验收。

**影响**

项目功能很多，但交付对象不清晰。当前综合分支和默认分支之间存在明显差异，回退、审阅和定位回归的成本较高。

**改进要求**

建立明确的 integration/release 分支，按依赖顺序合并最小必要能力，并在每次合并后重新运行完整检查。实验数据和研究快照不要和生产代码能力混为同一交付单元。

### P2：报告、fixture 与源码存在漂移风险

CI 当前主要执行 `npm run check`，没有验证：

- qualification 是否可重跑；
- 提交的 JSON 报告是否由当前源码重新生成；
- HTML/PDF 是否与当前 trace 一致；
- fixture digest 是否仍然匹配；
- benchmark evidence 是否发生漂移。

**影响**

仓库中的报告更像已生成快照，而不是受 CI 约束的构建产物。报告中的局部 `1.0` 不能被解释为策略效果。

**改进要求**

增加独立 CI job：

- `qualification-smoke`；
- `report-reproducibility`；
- `fixture-digest-check`；
- `replay-render-check`。

真实 agent benchmark 不应强行塞入普通 PR CI，但应放入 nightly 或手动触发的实验 workflow。

## 四、对现有测试结果的客观解释

当前测试通过说明：

- 现有实现满足已有测试描述的行为；
- 主要正常路径、部分缺失事件和部分 fail-closed 行为被覆盖；
- 项目没有明显的语法级或基础回归问题。

当前测试通过不能说明：

- 输入证据来源真实；
- oracle 结果未被伪造；
- workspace 确实对应目标 task；
- benchmark 结论具备外部有效性；
- 真实 agent 的测试命令或耗时已经下降。

现有测试的主要缺口是反例测试，尤其是：

- 篡改 collector manifest；
- workspace revision 与 task base revision 不一致；
- oracle report 与 trace workspace digest 不一致；
- `oracle_status: passed` 但实际 oracle 失败；
- 不同失败原因但退出码模式相同；
- lifecycle 命令和 stream 命令不一致。

## 五、建议执行顺序

### 第一阶段：修复证据可信度

只处理四件事：

1. 绑定真实 collector 和 wrapper；
2. 绑定 task source/base revision；
3. oracle 自行验证 repository 和 revision；
4. cohort 读取独立 oracle report，而不是信任 manifest 声明。

每项至少增加一个伪造输入回归测试。

### 第二阶段：修复 qualification 语义

1. 同时验证退出码模式和 failure signature；
2. 增加“错误原因不同但退出码相同”的反例；
3. 明确 controlled fault 与 hidden reference test 的模型；
4. 对不支持的组合在 schema/validator 阶段直接拒绝。

### 第三阶段：完成最小正式实验闭环

在扩展正式 30 题之前，先完成 6 题的完整闭环：

```text
同一 Agent/模型
    -> baseline VerifyTrace
    -> candidate VerifyTrace
    -> independent oracle
    -> paired evaluation
    -> failure-recall gate
    -> efficiency gate
```

六题配对闭环不成立之前，不应声称效率收益或质量保持。

### 第四阶段：治理交付分支

1. 选定 integration/release 分支；
2. 按依赖顺序审阅 stacked PR；
3. 每个 PR 独立验证并记录变更边界；
4. 合并后形成单一可复现 baseline；
5. 明确默认分支当前具备和不具备的能力。

### 第五阶段：补充 CI 可复现性

增加 fixture qualification、报告重生成、digest 检查和 replay 渲染检查。将真实 benchmark 放入独立的 nightly/manual workflow，避免实验不稳定性污染普通代码 CI。

## 六、最终判定

| 项目 | 判定 |
|---|---|
| 本地代码和基础测试 | 可用，`npm run check` 通过，99/99 |
| Verification fixture qualification | 可用，6/6 退出码模式可复现 |
| 真实 baseline | 部分可用，4/30 |
| 正式 baseline/candidate 评估 | 未完成，0/6 |
| 测试成本下降结论 | 不成立 |
| 质量保持结论 | 当前证据不足，不成立 |
| 生产级 agent 强制执行 | 未实现 |
| 默认分支交付闭环 | 未完成 |
| 项目当前定位 | 离线验证与 benchmark 审计工具 |

## 七、验证账本

本次审查没有修改源码、配置或既有状态文档。

已执行：

- `npm run check`：通过，99/99 tests passed；
- `npm test`：被仓库 testguard 阻止，提示全量测试应通过显式验证入口执行；
- `git status --short --branch`；
- `git log --oneline --decorate -12`；
- `git branch -a -vv`；
- `git rev-list --left-right --count origin/codex/publish-research...HEAD`。

未执行：

- 真实 agent-belt baseline/candidate；
- 六题正式配对评估；
- 修复后的伪造输入回归测试；
- CI 环境验证；
- qualification/report 重生成检查；
- 任何 GitHub PR 合并操作。
