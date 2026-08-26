# Testing Policy — 本仓库自己的验证分档

> 最后核对：2026-08-26（`codex/publish-research` @ `18261cc`，基线 173/0）

**先分清两个「测试」**，这仓库最容易混的一点：

- **研究对象的四档**（`off` / `smoke` / `standard` / `thorough`）是本项目的**研究结论**，用来约束被测
  coding agent 的行为，定义在 `docs/verification-policy-benchmark-v0.1.md` 与 policy 文件里。
- **本文件**说的是**我们改这个仓库时该跑多少验证**。同名不同物，别互相引用当依据。

## 默认姿势

测试不是默认交付物。`npm run check` 全量跑 33 秒 / 173 个测试——改一行文档也跑全量是浪费。
按改动类型落到**最低够用档**，升档要说理由。

| 档 | 适用改动 | 必做 |
|---|---|---|
| `off` | 文档、注释、HTML 报告、handoff、README/STATUS 文案 | 无（HTML 改动另需实际打开看一眼） |
| `smoke` | 单个 CLI 的参数/输出格式、日志文案、非判定路径的小工具函数 | `node --check` 改动文件 + 跑该模块单个测试文件 |
| `standard` | 一般模块逻辑、诊断分类、报告字段、replay 渲染 | 相关测试文件 + 一个高价值边界；优先塞进已有测试文件 |
| `thorough` | 见下方硬触发点 | `npm run check` 全量 + 对应 benchmark 命令实跑 |

## `thorough` 的硬触发点（没得商量）

改到这些文件一律全量，因为它们决定「证据算不算数」：

- `src/test-command.mjs` —— 测试命令判定唯一路径（#58 教训：整串正则与段分解并存，白丢 5 次）
- `src/evaluation.mjs`、`src/verification-benchmark.mjs` —— 四条硬门槛常量
- `src/cohort.mjs`、`scripts/audit-verification-runs.mjs` —— 审计器与资格重推
- `src/verification-policy-hook.mjs`、`scripts/verification-policy-hook.mjs` —— 强制与拒绝路径
- `src/verification-workspace.mjs` —— 答案隔离与 flaky marker 语义

单测绿不算数：这几处改完必须跑对应 `npm run benchmark:*` 实际过一遍，否则口径漂移看不出来。

## 什么时候才新增测试

满足**至少一条**才写，否则不写：

1. 已知缺陷的回归修复（#58 就是这样补的两个回归测试）。
2. 改变了对外稳定行为：CLI 契约、报告字段名、退出码。
3. 动了跨模块不变量：脱敏边界、证据绑定、fail-closed 判定。

**禁止**：为覆盖率补测试、复制实现的 change-detector、给静态常量写断言、同一根因铺多条近似用例。

## 每任务预算

- 新增测试文件最多 1 个，优先并入已有文件（`test/*.test.mjs` 已按模块分好）。
- 新增测试代码不超过生产 diff 的 100%，超了要解释锁住的是哪条公共不变量。
- 单个测试文件 30 秒内；全量 33 秒是提交/CI 阶段的事，不进每次编辑回路。
- 一次执行，失败后最多定向重试 1 次。

## 停止规则

失败且归因清晰 → 改生产代码，重跑一次。重试后仍无法归因 → **停**，不再加测试，报告：跑过的命令、
失败输出、疑似原因（代码 / 测试 / 环境 / flaky）、剩余风险。同一测试第二次才过 ≠ 正确，标疑似
flaky 单独治理，不改生产代码。

## 命令

```bash
node --check <file>                    # off/smoke 档语法门禁
node --test test/<name>.test.mjs       # 单文件定向测试
npm run check                          # 全量门禁：语法 + python ast + bash -n + 173 测试（33s）
```

CI 在 Node 20 / 24 上都跑全量 `npm run check`。本地降档只省本地时间，不改变「CI 全量」这个事实。
