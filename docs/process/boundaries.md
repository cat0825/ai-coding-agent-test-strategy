# Boundaries — 红线、已知坑与协作规则

> 最后核对：2026-08-26（`codex/publish-research` @ `18261cc`）
> 本文件是改动与审查的「先在这里对齐」清单。每条都指到可执行证据，不写无法检查的戒律。

## 语义红线（改动即违规，有测试或审计看守）

1. **审计独立于采集**：资格由 `scripts/audit-verification-runs.mjs` / `src/cohort.mjs` 从原始证据
   重推，不采信采集器自述；oracle 的 `undecided` 声明也要过审（四个条件任一不满足即判不可用，
   #57 落地 `9c7c9c9`）。
2. **判不了就说判不了**：oracle 结构性无法判定时声明 `status: "undecided"` + `undecidable_reason`
   + `deciding_evidence`，交空 `failure_signatures`；不许把"该复现的失败没复现"冒充 agent 失败。
3. **门槛不可调低**：30 对 / 10 失败样本 / 2 场景类 / 3 外部题写死在评测器里
   （`src/evaluation.mjs`、`src/verification-benchmark.mjs:18`），调用方不能自报合格。
4. **测试命令判定只有一条路径**：`src/test-command.mjs` 段分解。#58 之前整串正则与段分解并存，
   导致 `rg 'pytest' src/` 被当测试命令拒掉（实测 31 过闸白丢 5 次）；回归测试在
   `test/test-command.test.mjs` 与 `test/verification-policy-hook.test.mjs`。
5. **场景覆盖按题不按 fixture**：fixture 过环境资格 ≠ 观测到该场景下的验证行为。
6. **flaky 标记首跑即消耗**（`src/verification-workspace.mjs` 的 `diagnostic-flaky-test-v1`）：
   凡依赖"失败后重试"语义的题，设计 oracle 时必须考虑 marker 已被 agent 用掉。

## 工程红线

1. **fail closed**：证据缺失、重复、乱序、不匹配、无法解释一律拒；`evidence_insufficient`
   退出码 2。方向是"分不清就别放行"，不是"差不多就放行"。
2. **脱敏在落库之前**：collector/hook 账本不保存原始命令、输出、凭据、绝对路径；
   只留相对文件变化与不可逆 sha256 摘要。payload 里出现原文 = 事故。
3. **Host 模式显式开启**：`--allow-host` + 最小环境；它不是 sandbox，不用于未经审查的 agent 代码。
4. **答案隔离**：测评工作区移除原始 Git 历史（`verification-workspace.mjs`）；
   隐藏 oracle 与公开题面分离，agent 不能从 commit 历史找到答案。
5. **提交前 `npm run check`**：当前基线 173/0（2026-08-26 实测）；CI Node 20/24 同闸门。
   语法门禁由 `scripts/syntax-gate.sh` 自动扫描 `src/` `scripts/` `oracles/`（45 个文件），
   新增文件无需登记 package.json；跑多少测试按 [testing-policy.md](testing-policy.md) 分档。

## 已知坑（采过的雷，不要再踩）

1. **codex 并行批调用连带丢失**：一批并行调用里一条被 deny，同批已批准的会被一起丢掉
   （2026-08-24 现场：3 条批准未执行）。审计覆盖率按 `tool_use_id` 配对，不按条数比。
2. **unified exec 失败静默失去强制**：codex 建不出 unified exec 进程后走不触发 hook 的路径，
   trace 看上去仍完整；审计以 `enforcement_incomplete` 标出，相关运行改名留档（`hookloss-observed`）。
3. **系统时钟 slew 会反转排序**：policy ledger 无单调计数器，按单调时间排序会把记录排到其所描述的
   完成之前；trace 排序只用墙钟，单调时间只破平局与算时长。
4. **改名留档后绝对路径悬空**：`run.json`/`task.json` 里的绝对路径会指向被新运行占用的旧名字；
   证据一律在运行目录内部解析。
5. **`npm run check` 这类命名脚本 body 不可检**：`check` 里藏着 `npm test`，改写整串会吞掉语法门禁，
   所以 hook 对命名脚本拒绝替换（`script_body_not_inspectable`），只给窄命令建议。
6. **凭据风险**：固定 `gpt-5.6-sol` 曾因 provider 401 两次失败；批跑前先跑 smoke 验证凭据。
7. **易失证据**：`/tmp/vp-collect-2026-08-24` 重启即没，`--rebuild-trace` 依赖它，用前先归档。
8. **僵尸副本**：`~/Documents/GitHub/ai-coding-agent-test-strategy` 停在 `e2a2fd2`（08-14），
   活跃工作树是 `~/Documents/ChatGPT/llm test`。

## 已知接受项（不要重复开 issue）

- Maka 完整 `npm test` 含 PTY/macOS 路径/本机认证失败：只作环境分类证据，不修。
- commander 在 `CI=1 NO_COLOR=1` 下 2/1373 失败：环境冲突，不打补丁（为单 fixture 放宽会破坏可比性）。
- collector-v1 trace 可回放但不出重复测试结论：保留兼容，不补能力。
- 三个未标记 `test-required` 场景新增了测试：`unspecified` 观察，不据此断言测试无价值。

## 协作规则

1. 工作流按 `CONTRIBUTING.md`：open issue → feature 分支 → 一个 issue 一个 PR → `Fixes #<number>`；
   stacked PR 按依赖顺序合入；**不主动合并自己的 PR**。
2. 审查从实际 diff 与签入证据出发；结论必须能指到 fixture 文件与行号。
3. handoff 只加不改：新事实追加 `SESSION.md`，跨 session 交接新建 `docs/handoff-<date>.md`，
   并明确作废旧 handoff 的"现状"部分。
4. 同一采集者的自查不算独立审计；oracle 必须不依赖 agent 自写测试。
