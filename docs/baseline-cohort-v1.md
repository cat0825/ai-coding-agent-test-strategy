# Baseline cohort v1

Issue #16 的输入是一个任务清单，不是“把 30 个数字写进报告”。每个 `collected` 任务必须绑定同一个合格环境清单、固定仓库 revision、一条完整的 `mode: baseline` VerifyTrace 和一份独立 oracle report。任务是否 `quality_claim_eligible` 由审计器计算，不能由输入字段声明。

最小清单形状：

```json
{
  "schema_version": 1,
  "cohort_id": "coding-agent-baseline-pilot",
  "cohort_version": 1,
  "evidence_class": "planning",
  "repository": { "identity": "owner/project", "kind": "coding-agent" },
  "environment_manifest_digest": "环境清单 JSON 的 SHA-256",
  "minimum_baseline_tasks": 30,
  "tasks": [
    { "task_id": "task-001", "status": "planned" },
    {
      "task_id": "task-002",
      "status": "collected",
      "trace_id": "trace-task-002",
      "trace_path": "traces/task-002.json",
      "oracle_report_path": "oracles/task-002.json",
      "oracle_report_sha256": "独立 oracle report 的规范化 SHA-256",
      "oracle_definition_sha256": "受控 oracle 实现的 SHA-256",
      "repository_commit": "固定的 40 位 commit",
      "environment_manifest_digest": "同一环境清单摘要",
      "evidence": {
        "environment_status": "eligible",
        "install_status": "passed",
        "build_status": "passed",
        "test_status": "passed",
        "clean_worktree": true,
        "failure_class": "none"
      }
    }
  ]
}
```

审计器自行读取 oracle report，校验其摘要、task、仓库、revision、环境、oracle definition 和结果一致性；`evidence` 中自报 oracle 状态会被拒绝。规划任务、环境失败、pre-existing failure、无法归因的失败、revision/摘要不匹配、缺失或不完整 trace/oracle 都不会计入合格任务。少于 30 个合格任务时结论是 `evidence_insufficient`，退出码为 2；达到门槛只表示 baseline 证据可供下一阶段配对，并不自动表示效率或质量提升。
