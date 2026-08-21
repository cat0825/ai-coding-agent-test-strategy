# 使用场景分层 v1

## 为什么需要这一层

`verification-policy-pilot-plan.json` 原来只按 `behavior_class` 和 `risk_class` 分层。
两者都描述验证行为，不描述使用者的真实场景。因此即使采满 30 题，结论也只能覆盖
「Node 单仓库里的验证行为」，不能回答「写小工具 / 做前端 / 写研究脚本的人是否受益」。

本文件定义场景维度，并规定从简单单侧观测泛化到复杂场景的顺序。

## 场景分类

分类依据是**验证形态**，不是应用领域名称。领域名无法推导出可判定的 oracle，验证形态可以。

| `scenario_class` | 典型使用者意图 | 验证形态 | 主要考察点 |
| :-- | :-- | :-- | :-- |
| `cli_tool` | 写小工具、脚本、命令行程序 | 单测快，闭环短 | 是否无依据升级到全量 |
| `web_frontend` | 页面与组件开发 | 单测 + 类型检查 + 构建 | 依赖闭包是否正确、是否过度全量 |
| `service_library` | 服务端与被复用的库 | 分层测试，含慢速集成测试 | fast→affected 升级判断与预算控制 |
| `research_script` | 数据处理与科研脚本 | 多数无测试，靠运行产出比对 | 在缺少测试时能否形成可判定证据 |

`research_script` 需要 snapshot 形态的 oracle，与现有「存在可判定测试」的假设不同，
因此单独排在最后一轮，不与前三类混采。

## 采集顺序

1. **第 0 轮（当前）**：`cli_tool` / JavaScript 单侧行为。
   六题 pilot 已全部落在这一格，已验证 5 类行为可以拿到双臂 complete。
   本轮只做机制正确性，不产出效率结论。
2. **第 1 轮**：加入 `web_frontend` 与 `service_library`，语言扩到 TypeScript。
   目标是让 `scenario_coverage.generalized` 为真，并形成第一批正式质量样本。
3. **第 2 轮**：加入 `research_script` 与 Python 通路，需要先实现 snapshot oracle。

`MINIMUM_GENERALIZED_SCENARIO_CLASSES = 2`：只覆盖一类场景时，设计审计会输出
`scenario_classes_not_generalized` blocker。这是有意的 fail-closed，防止用单一场景样本
推广到「所有编码 agent 使用者」。

## 与已有证据的兼容性

`scenario_class` 与 `language` 声明在 `fixtures[]` 上，不进入 `task.definition`，
因此 `scenario_definition_sha256` 不变，2026-08-20 已采集的 trace 与 oracle 仍然可比。
这是刻意选择：场景维度描述环境，任务定义描述题目，两者不应耦合。

## 现状

- 覆盖：`cli_tool` 6 题 / JavaScript。
- 缺失：`web_frontend`、`service_library`、`research_script`。
- `generalized`：false。
- 证据：`fixtures/benchmark/verification-policy-pilot-report.json`。
