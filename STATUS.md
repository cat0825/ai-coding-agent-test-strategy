# 项目状态

状态：**研究与 PDF 完成 / 实验方案就绪 / 工具实现未开始**

## 已完成

- 完成 AI 编码代理测试策略的纵向分析：测试大小、测试金字塔、回归测试选择、增量分析和测试质量审计。
- 完成横向案例分析：Google、OpenAI Codex、Aider、Claude Code、GitHub Copilot、Meta、Microsoft、GitLab、Kubernetes。
- 定义 `off`、`smoke`、`standard`、`thorough` 四档验证强度。
- 定义 Agent 状态机：分类变更、发现受影响测试、一次定向执行、失败归因、必要时升级。
- 定义默认预算建议：最多新增 1 个测试文件、最多执行 2 次即时测试、即时测试时间上限 90 秒。
- 提供可直接复制到 `AGENTS.md` 的测试策略模板。
- 修复 PDF 中 `AGENTS.md` 模板的右侧裁切，加入打印源、构建脚本和 16 页成品。
- 完成实验与校准方案：指标、初始门槛、fallback、命令归一化和 override 账本。
- 选定 `maka-agent` 作为首个 pilot 候选；正式实验必须使用干净的独立 worktree。

## 未完成

- 没有可执行的验证脚本或测试运行器。
- 没有实现 diff/依赖图驱动的 affected-test selection。
- 没有实现测试次数、耗时和全量命令的 hook/permission 拦截。
- 没有真实仓库 benchmark，无法声称已经减少测试耗时或 CI 成本。
- 没有把策略接入某个具体 Agent 产品或现有代码仓库。

## 下一阶段

1. 从 `maka-agent` 干净提交创建独立 worktree，采集 `test:fast`、`test`、`test:full` 基线。
2. 实现 `verify.sh fast|affected|full` 与结构化验证账本，先以 shadow 模式运行。
3. 加入最小 affected-test 适配器、unknown fallback 和命令 canonicalization。
4. 累计至少 30 个基线任务和 30 个 shadow 任务，再决定是否启用有限强制。
