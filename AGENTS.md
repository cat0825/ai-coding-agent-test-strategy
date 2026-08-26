# AGENTS.md · ai-coding-agent-test-strategy

研究 AI 编码代理的验证行为：用 off / smoke / standard / thorough 四档策略约束测试扩张，
并用同题同模型的 baseline/candidate 配对实验证明它有效。
Node ≥ 20 纯 ESM 脚本仓库（无构建步骤），测评对象是外部 coding agent（当前为 codex-cli）。

## 先读这些（按顺序）

1. 本文件 —— 红线与结果边界。
2. [`STATUS.md`](STATUS.md) —— 当前事实的唯一权威源；与任何文档冲突时以它为准。
3. [`docs/project/system-map.md`](docs/project/system-map.md) —— 模块边界、数据流、入口。
4. [`docs/process/boundaries.md`](docs/process/boundaries.md) —— 语义/工程红线、已知接受项、协作规则。
5. [`docs/visions/README.md`](docs/visions/README.md) —— 当前阶段、四门槛对账、动手顺序。
6. [`CONTRIBUTING.md`](CONTRIBUTING.md) —— issue/PR 工作流。

旧 handoff（`docs/handoff-*.md`）只是历史证据；回答"现在状态"前必须对照 `STATUS.md` 核验。

## 结果边界（harness 约束，不可越界）

**交付边界 = 可复现的配对证据 + 审计器从原始证据重推的结论。越过这条线就是用未验证结论冒充证据。**

- 四条硬门槛写在 issue #17 验收标准：配对比较 ≥ 30、有效 oracle 失败样本 ≥ 10、
  泛化场景类 ≥ 2、外部仓库出题 ≥ 3。**任何一条不满足，评估停在 `evidence_insufficient`，
  不得对外声称"省了多少测试时间"或"没漏故障"**（`efficiency_claim: not_supported`）。
- 毫秒量级的耗时/命令数观察（如两题 dry run 的 1123.2ms→63.6ms）只是**采集链校准证据**，
  不是效率结论；百分比不作为结论引用。
- 以下明确**不属于**当前交付范围，不作为继续开发的理由：
  效率宣传、DSH 迁移、对外 benchmark（P1/P2）、hook/permission 的产品化发布。
- 探索性 pilot 的 `pilot_decision: go` 只允许继续采集，不把探索性任务计入 baseline。
- `planning_ready` / `fixture_ready` / 环境资格 / fixture 资格都**不等于**质量声明资格。

## 红线（违反即返工，细则见 docs/process/boundaries.md）

1. 资格与结论由审计器从原始证据重推，不采信采集器或输入文件自述——包括 oracle 的
   `undecided` 声明，声明本身也要过审。
2. 文档里任何一句话必须由**已签入仓库**的证据支撑；这条拦下过一次错误发布。
3. 证据缺失、重复、乱序、不匹配或无法解释一律 fail closed；`evidence_insufficient`
   退出码为 2，这不是失败伪装成成功。
4. 不为主张效率降低门槛，不为凑数放宽 fixture 资格（拒绝理由全部在案，如 commander 的
   `CI=1 NO_COLOR=1` 环境冲突未打补丁——单独放宽会破坏 fixture 间可比性）。
5. collector 不保存原始命令、输出、凭据、绝对路径；只留脱敏相对文件变化与不可逆摘要。
   Host 模式必须显式 `--allow-host` 且只传最小环境；它不是 sandbox，不用于未经审查的 agent 代码。
6. "是不是测试命令"只有一条判定路径：`src/test-command.mjs` 的段分解（#58 修复后）。
   不得新增任何整串正则式的独立判定；有回归测试看守。

## 门禁与验证基线

```bash
npm run check           # 全量权威入口：语法门禁 + 173 个测试（约 35s）
npm run check:syntax    # 只跑语法门禁（秒级），改文档/低风险改动用这个
```

- 基线：**173 通过 / 0 失败**（2026-08-26 实跑，`codex/publish-research` @ `18261cc`）。
- PR 在 Node 20 与 Node 24 上跑同一闸门，CI 是事实来源。
- 语法门禁 `scripts/syntax-gate.sh` 自动扫描 `src/` `scripts/` `oracles/`（45 个文件），
  新增文件无需登记；排除 `tmp/` `fixtures/`（采集产物非源码）。
- **跑多少测试按 [`docs/process/testing-policy.md`](docs/process/testing-policy.md) 分档**：
  改文档不跑全量，改判定口径/审计器/门槛常量必须全量 + 对应 `benchmark:*` 实跑。
- 涉及采集/审计/判定口径的改动，单测绿不算数，需对应 benchmark 命令实际跑通。

## 数字口径纪律

- 改判定口径 = 旧数字作废。PR #60（#58 闸门修复）之后的 candidate 命令数/耗时与之前
  **不可比**；benchmark 文档已记录，重采前所有耗时数字只作校准证据。
- 评测报告必须区分 `evidence_insufficient` / `rejected` / 可支持声明三态，不许合并。
- 引用数字时说明口径与时刻；README 的进度行以 STATUS.md 为准（当前存在漂移，已立项治理）。

## 已知未完成（详情见 docs/visions/README.md）

- **PR #60 待合并**：#58 闸门修复（CI 双绿），合并后需重采六题配对才算关闭 #58。
- 四门槛现状：6/30、0/10、1/2、0/3；下一个动作是 pino 出题（#59）。
- open issue 5 个：#58、#59、#17、#16、#1（roadmap）。
- `~/Documents/GitHub/ai-coding-agent-test-strategy` 是 08-14 僵尸副本（停在 `e2a2fd2`，
  6 个脏文件）；活跃工作树是 `~/Documents/ChatGPT/llm test`，别按目录名找盘。
- `/tmp/vp-collect-2026-08-24` 易失（重启即没），`--rebuild-trace` 依赖它，用前先归档。
