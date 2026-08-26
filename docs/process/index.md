# process/

可复用的流程与约定。

## 索引

| 文件 | 内容 |
| --- | --- |
| [boundaries.md](boundaries.md) | 语义/工程红线、已知坑（8 条采过的雷）、已知接受项、协作规则 |
| [testing-policy.md](testing-policy.md) | **我们自己**改仓库时跑多少验证（四档 + `thorough` 硬触发点 + 预算） |

## 开发流程

1. 从有验收标准的 open issue 出发，feature 分支，一个 issue 一个 PR，`Fixes #<number>` 链接；
   不主动合并自己的 PR；stacked PR 按依赖顺序合入（`CONTRIBUTING.md`）。
2. 按 [testing-policy.md](testing-policy.md) 落**最低够用档**：改文档不跑全量，改判定口径必须全量。
3. 提交前 `npm run check`（基线 173/0，2026-08-26 实测）；CI 在 Node 20/24 跑同一闸门。
4. 涉及采集/审计/判定口径的改动：单测绿不算数，需对应 `benchmark:*` 命令实际跑通。

## 口径与门禁

- **四硬门槛**（issue #17）：配对 ≥ 30、有效失败样本 ≥ 10、场景类 ≥ 2、外部出题 ≥ 3。
  不满足即 `evidence_insufficient`，不许效率声明。
- **配对采集口径**：codex-cli 0.149.0 / `gpt-5.6-sol` / effort high；baseline 臂
  `unmanaged-coding-agent-baseline@1`，candidate 臂 hook + `observatory-verification-policy`
  （以 STATUS.md 记录为准）。trace 强制绑定模型、模式、policy 身份；trace 与 oracle 共用
  post-run workspace digest。
- **口径变更 = 旧数字作废**：PR #60 之后 candidate 命令数/耗时与之前不可比；同一口径重采后
  统一重写，不中途逐步对数。
- **失败语义**：`evidence_insufficient` 退出码 2；oracle 判不了声明 `undecided` 并交空签名；
  证据异常一律 fail closed。

## Handoff 规则

- session 内新事实追加 `SESSION.md`（只加不改）；跨 session 交接新建 `docs/handoff-<date>.md`，
  并明确作废旧 handoff 的"现状"部分。
- handoff 必写：一句话现状、分支与提交、open issue/PR、阻塞顺序、易失证据位置。
- 权威顺序：`STATUS.md` ≈ `docs/verification-policy-benchmark-v0.1.md` > `SESSION.md` >
  最新 handoff > 历史 handoff。
