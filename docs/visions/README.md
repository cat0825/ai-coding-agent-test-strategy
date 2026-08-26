# docs/visions · 版本与当前状态

最后核对：2026-08-26（`codex/publish-research` @ `18261cc`，与 origin 同步，`npm run check` 173/0 本地全绿）。

## 里程碑状态

机制层（采集 → trace → 审计 → 强制）**全部落地且真机观测过**：六题配对 6/6 签入并通过独立审计，
deny 真机强制（#52），L2 改写有配对证据（#56），`wait` 事件建模（#50），外部 fixture 环境资格
3 过 6 拒（#53/#39），oracle `undecided` 语义（#57）。

评估层**未交付**：`evidence_insufficient`，`efficiency_claim: not_supported`。

## 四门槛对账（2026-08-25 STATUS 口径）

| 门槛 | 现状 | 性质 |
| --- | --- | --- |
| 配对比较 ≥ 30 | 6/30 | 纯数量，可靠采集堆出来 |
| 有效 oracle 失败样本 ≥ 10 | 0/10 | 最难；`vp_flaky_retry_once` 已撤假样本改 `undecided`，只能靠"因正确原因失败"的 oracle |
| 泛化场景类 ≥ 2 | 1/2 | 6 题全是本仓库 cli_tool（`generalized: false`）；pino 出一题即达标 |
| 外部仓库出题 ≥ 3 | 0/3 | pino / zustand / yargs 环境资格已过，出题才算数 |

## 当前阶段：v0.1-verification-policy-benchmark

详见 [v0.1-verification-policy-benchmark/README.md](v0.1-verification-policy-benchmark/README.md)。

动手顺序（按解锁关系，不按工作量）：

1. **合并 PR #60 → 重采六题配对**（#58 验收第 4 条）。闸门缺陷的代码修复已在 PR #60
   （CI Node 20/24 双绿，177/0）；重采后 `vp_unknown_impact_full_fallback` false-denial=0 才关闭 #58。
2. **#59：pino 第一道外部题** → 场景 2/2 + 外部出题 1/3，同时验证 #55 的外部出题流水线。
3. **失败样本题目设计**（新立项）：0/10 不能靠堆量，需设计"agent 常见错误触发 oracle
   因正确原因失败"的新题。与 1/2 并行。
4. **扩到 30 对**（#17）：前三步完成后才是纯堆量，24 对按六题一轮批跑；zustand/yargs 各一题补 3/3。
5. **30 对后跑 oracle safety gate**；此前不做效率宣传，不迁移 DSH。

治理债（并行，不阻塞采集）：README/STATUS 漂移、check 脚本手工枚举、僵尸副本与已合并分支清理、
本套上下文沉淀签入。清单见 [docs/reviews/2026-08-26-issue-pr-audit-and-gate-fix.md](../reviews/2026-08-26-issue-pr-audit-and-gate-fix.md)。

## Open issue（5）

#58（闸门缺陷，代码已修待重采）、#59（pino 出题）、#17（candidate cohort，6/30）、
#16（baseline cohort）、#1（roadmap）。Open PR：#60。

## 版本目录约定

一个版本一个目录 `v0.x-英文短名`，内含 README.md 写范围、硬门槛与退出条件。进入下一阶段
（30 对完成、safety gate、结论发布）时新建目录，旧目录转历史。
