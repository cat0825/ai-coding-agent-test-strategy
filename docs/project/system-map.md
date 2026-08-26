# 系统地图 · ai-coding-agent-test-strategy

最后核对：2026-08-26，`codex/publish-research` @ `18261cc`。以当前代码为准，与代码冲突时改本文。

## 数据流

```
真实 agent run（codex-cli + Bash hook）
        │  scripts/codex-lifecycle-wrapper.py   旁路记录 UTC/monotonic/exit code（不落命令原文）
        │  src/prepare-codex-collector.mjs      安装 collector；src/collector-provenance.mjs 来源摘要
        ▼
lifecycle sidecar（脱敏：相对文件变化 + 不可逆摘要）
        │  src/agent-belt-trace.mjs / src/verification-trace-cli.mjs   转 VerifyTrace v1，fail closed
        ▼
VerifyTrace（绑定模型 / baseline·shadow 模式 / policy 身份 / workspace digest）
        │
        ├─→ 强制臂：src/verification-policy-hook.mjs（PreToolUse/PostToolUse）
        │     deny / allow / L2 改写 → decisions NDJSON 账本
        │     判定唯一入口：src/test-command.mjs 段分解（#58 后无第二把尺子）
        │
        ├─→ 判分：src/verification-policy-oracle.mjs + oracles/agent-belt/*.py
        │     独立 oracle 在 post-run 工作区副本跑，不用 agent 自写测试；判不了就 undecided
        │
        ├─→ 审计：scripts/audit-verification-runs.mjs · src/cohort.mjs · src/evaluation.mjs
        │     从原始证据重推资格，输出证据缺口（如 30 门槛 deficit），evidence_insufficient 退出码 2
        │
        └─→ 呈现：src/replay.mjs（离线 HTML 回放）· src/recommendations.mjs（expert/simplified 推荐）
```

环境与资格前置：`src/benchmark-preflight.mjs`（声明式工具探针，脱敏 manifest）→
`src/verification-benchmark.mjs`（六题合同自检）→ `src/verification-workspace.mjs`
（隔离工作区物化：固定 revision、移除原始 Git 历史、六种退出模式复现）→ 才允许采集。

## 模块边界与职责

| 模块 | 职责 | 关键约束 |
| --- | --- | --- |
| `src/test-command.mjs` | shell 段分解 + runner 判定 + 语义摘要 | "是不是测试命令"的唯一判定路径；整串正则已删除（#58） |
| `src/verification-policy-hook.mjs` | candidate 臂策略强制：预算、deny、L2 改写、状态锁 | 原始命令不进账本，只记 digest 与 canonical id |
| `src/agent-belt-trace.mjs` / `src/verification-trace-cli.mjs` | lifecycle → VerifyTrace | 只从 `turn.completed`/`turn.failed` 生成 stop；无法解释即 fail closed |
| `scripts/codex-lifecycle-wrapper.py` | shell lifecycle 旁路采集 | 不落命令、输出、凭据、绝对路径 |
| `scripts/audit-verification-runs.mjs` | 配对审计器 | 不信采集器自述，7 个字段从原始证据重算 |
| `src/verification-policy-oracle.mjs` + `oracles/agent-belt/` | 独立功能判分 | 不调用 agent 自写测试；host 模式显式 `--allow-host` |
| `src/verification-workspace.mjs` / `src/verification-task-cli.mjs` | 隔离工作区物化与资格复现 | 移除原始 Git 历史，agent 无法从 commit 找答案 |
| `src/evaluation.mjs` / `src/cohort.mjs` | 门槛评测与 cohort 审计 | 门槛不可由调用方调低；缺口如实输出 |
| `src/verifier.mjs` / `src/cli.mjs` / `scripts/verify.sh` | 策略执行器：fast/affected/full + JSONL 账本 | 默认 plan-only shadow；`--execute --mode baseline` 才执行 |
| `src/benchmark-preflight.mjs` | 环境资格探针 | 声明式工具探针，manifest 不存 argv 原文 |
| `src/replay.mjs` / `src/recommendations.mjs` | 离线回放与推荐 | 无网络依赖；只有低风险高置信重复可自动处理 |
| `fixtures/benchmark/` | 已签入的配对证据与报告 | 文档按行号引用的证据必须在此可复算 |
| `policies/` | 策略配置（Maka 为仓库适配示例） | 示例不构成产品边界 |

## 入口

- 仓库门禁：`npm run check`（唯一权威入口，CI Node 20/24 同闸门）。
- 单题采集三件套：`benchmark:verification:prepare` → `benchmark:verification:trace` →
  `benchmark:verification:oracle`（参数见 docs/verification-policy-benchmark-v0.1.md）。
- 评测：`npm run evaluate`；资格复现：`npm run benchmark:verification:qualify`。
- 全部 `benchmark:*` 入口见 `package.json` scripts，契约见对应 `docs/*-v1.md`。

## 高风险区（改动需升级验证）

- `src/test-command.mjs` —— 判定口径，#44（段分解）、#47（复合命令）、#58（整串正则）三次缺陷都在这；
  改动必须带单元 + hook 级回归。
- `src/verification-policy-hook.mjs` —— 状态机、预算、改写替换；`unscoped_test_command_denied`
  真机触发证据是它的既有防线（#43）。
- `scripts/audit-verification-runs.mjs` —— 审计独立性的最后防线；放宽它的任何检查等于拆穿整个证据链。
- `scripts/codex-lifecycle-wrapper.py` —— 脱敏边界；多落一个字段都可能把原始命令带进证据。
- `src/verification-workspace.mjs` —— 答案隔离；`vp_flaky_retry_once` 的 marker 语义在这
  （flaky 标记首跑即消耗，是该题 oracle 结构性判不了的根因，#57）。

## 外部依赖

- 运行时零 npm 依赖（纯 Node 标准库 ESM）；Python 侧仅标准库（oracle 与 wrapper）。
- 测评对象：codex-cli（基准口径 0.149.0 / `gpt-5.6-sol` / effort high，以 STATUS.md 为准）。
- 外部 fixture：pino / zustand / yargs 已过环境资格（3 过 6 拒，理由在案）；commander 被拒属环境冲突。
- PDF 构建依赖 WeasyPrint（可选，仅报告产物）。

## 已关闭的方向（不要再走）

- Calculator/Tasktracker 30-task 清单：降级为历史规划审计，不再扩写 oracle（测的是编码能力，不是验证策略）。
- read-only task 的 agent-belt oracle：缺稳定响应 oracle，已排除。
- Maka pilot：只作环境分类证据，不构成产品绑定。
- collector-v1 trace：仍可回放，但不能产出重复测试结论。
