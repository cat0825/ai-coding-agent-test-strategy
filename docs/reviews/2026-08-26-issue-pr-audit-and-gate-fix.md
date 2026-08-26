# Issue/PR 区审计与 #58 闸门缺陷修复审查报告

- 日期：2026-08-26
- 审查范围：open issue（#1、#16、#17、#58、#59）、open/merged PR、#58 缺陷修复
- 审查时 HEAD：`codex/publish-research` @ `18261cc`（与 origin 同步）
- 验证：`npm run check` 修复前 173/0、修复后 177/0；CI Node 20/24 双绿（PR #60）
- 独立性声明：本报告由审查 agent 独立完成，非修复者自查以外的第二份意见；结论均可指到签入证据

## 一、Issue/PR 区审计结论

**无过期、无冲突、无需新开 issue。** 具体核对：

| 检查项 | 结果 |
| --- | --- |
| Open PR | 审计时为 0（#49–#56 全部按依赖顺序合并，含 stacked #55→#56） |
| Open issue 与 STATUS.md 一致性 | 一致：#58（硬阻塞）、#59（pino）、#17（6/30）、#16、#1（roadmap） |
| 路线图勾选 | #1 的 #38/#40/#44/#45 已勾选，未勾选项即 #58/#59 两个待办本身 |
| 已关闭 issue 状态 | #57（2026-08-25 落地 `9c7c9c9`）、#43（08-24 关闭，真机证据在案） |
| 验收标准完整性 | #58 四条 + 重采、#59 四条均可机械核验，无空泛表述 |

## 二、#58 缺陷确认与修复（PR #60）

### 缺陷复核（独立复现于代码）

`src/test-command.mjs` 修复前存在两把尺子：`normalizeTestRunnerCommand` 的整串正则闸门
（`TEST_RUNNER_RULES`）先判"像不像测试命令"，`analyzeTestRunnerCommand` 再按段分解判
"是不是测试命令"。`rg 'pytest' src/` 的搜索模式含 `pytest`，整串闸门命中后段分解找不到
runner，走 fail-closed 拒掉。实测代价签入在案：`vp_unknown_impact_full_fallback` 31 次过闸
白丢 5 次（docs/verification-policy-benchmark-v0.1.md 缺陷 3）。

结论：issue #58 的定性准确，"先于扩量修复"的排序正确——这是测量仪器本身的偏差，
不修复则 30 对全部掺同一噪声，且修复后旧数字不可比。

### 修复内容

- 删除整串正则闸门（`TEST_RUNNER_RULES` / `normalizeTestRunnerCommand`）。
- `analyzeTestRunnerCommand` 与 `isTestRunnerCommand` 共用同一条段分解路径：
  只有某一段的可执行词本身是 runner 才算测试命令；`rg 'pytest' src/`、
  `grep -r vitest .`、`echo "npm test"` 按非测试命令放行。
- fail-closed 保留：无法解析的 shell、命令替换内的 runner、一条命令多个 runner 仍然拒。
- `src/pilot-audit.mjs` 的 `isTestRunnerCommand` 调用随之统一口径，无需改动。

### 验收标准对账

| #58 验收标准 | 状态 |
| --- | --- |
| 闸门与判定共用一条代码路径，无独立正则 | ✅ 已落地 |
| 三条提及命令过闸 | ✅ 回归测试（单元 + hook 级） |
| 真实未限定测试命令仍被拒 | ✅ `npm run check` → `unscoped_test_command_denied` 回归测试 |
| 六题重采且 false-denial=0 | ⬜ 未做：需 12 次真机 codex run（每次约 15 分钟），`gpt-5.6-sol` 有 401 前科，列入重采计划 |
| benchmark 文档记录前后不可比 | ✅ 已签入 |

### 发现但未改（转治理债）

| 编号 | 发现 | 位置 | 处置 |
| --- | --- | --- | --- |
| F-01 | README 头部进度停在"2/6 配对、0/30"，与 STATUS.md（6/6、6/30）漂移 | README.md:7 | 立项：改为链接 STATUS.md 或由 fixture 报告生成 |
| F-02 | `check` 脚本手工枚举 29 个文件，新增 src 文件漏登记即失语法门禁 | package.json `scripts.check` | 立项：改自动扫描 |
| F-03 | 僵尸副本 `~/Documents/GitHub/ai-coding-agent-test-strategy` 停在 `e2a2fd2`、6 个脏文件 | 本机 | 立项：改名或删除（含 24 个已合并分支清理） |
| F-04 | 0/10 失败样本无现存题可满足 | `src/evaluation.mjs:9` | 立项：新题设计（见 visions 动手顺序 3） |

## 三、残余风险

1. PR #60 合并前，基准分支的 candidate 臂仍带旧闸门缺陷；合并与重采之间不允许采集新配对。
2. 重采依赖 `/tmp/vp-collect-2026-08-24`（易失）做 `--rebuild-trace` 对照；用前先归档。
3. 重采若发现 false-denial 未归零，说明段分解口径仍有未覆盖的命令形态，需回到 #58。
