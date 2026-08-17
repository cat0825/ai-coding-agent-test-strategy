# Benchmark environment manifest v1

真实 benchmark 必须先通过环境资格审查。未通过的任务可以保留为 calibration 或基础设施证据，但不得设置 `quality_claim_eligible: true`。

## 输入规范

preflight spec 固定以下事实：

- 40 位 Git commit 与 clean worktree 要求；
- OS、CPU architecture、Node major 与 npm major；
- 依赖安装命令、lockfile、必需安装路径和可选外部 artifact 的 SHA-256；
- command gate 的命令与前置依赖，例如冷启动时必须先通过 `build:test`，再执行 `typecheck`。

`install.status` 和 command `status` 不能由 spec 声明；preflight 会实际执行配置的 argv，并根据退出码生成 `passed`、`failed` 或 `blocked`。命令继承调用 preflight 时的环境变量，但 manifest 不保存环境变量。依赖图存在环时 spec 无效。外部 artifact 可以位于仓库之外，但生成的 manifest 只保留文件名和摘要，不写入绝对路径。命令只记录稳定 ID、观测状态、退出码、依赖和 definition SHA-256；摘要用于核对命令定义，不暴露可能包含 token、代理或本机路径的 argv/env。

最小 spec 形状：

```json
{
  "schema_version": 1,
  "benchmark_id": "maka-pilot",
  "repository": { "expected_revision": "0000000000000000000000000000000000000000", "require_clean": true },
  "runtime": { "platform": "darwin", "arch": "arm64", "node_major": 26, "npm_major": 11 },
  "install": {
    "command": { "argv": ["npm", "ci"], "timeout_ms": 600000 },
    "lockfile": { "path": "package-lock.json", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
    "required_paths": ["node_modules/.package-lock.json"],
    "artifacts": []
  },
  "commands": [
    { "id": "build-test", "argv": ["npm", "run", "build:test"], "prerequisites": [] },
    { "id": "typecheck", "argv": ["npm", "run", "typecheck"], "prerequisites": ["build-test"] }
  ]
}
```

## 命令

```sh
npm run benchmark:preflight -- \
  --repo /path/to/clean/worktree \
  --spec /path/to/preflight-spec.json \
  --output output/benchmark/environment.json
```

成功返回 `eligible` 和退出码 0；环境不满足时仍写出完整 manifest，返回 `ineligible` 和退出码 2；spec 或 I/O 错误返回退出码 1。

## Fail-closed 规则

以下任一情况都会使环境不具备质量声明资格：revision 不一致、worktree 非 clean、runtime major/平台不匹配、安装未通过、lockfile/必需路径缺失、artifact 哈希不匹配、required command 未通过，或 command 的前置 gate 未通过。基础环境不合格时安装与 command 均不执行；安装失败、安装证据不完整或安装改变 revision/cleanliness 时，command 保持 `blocked`。

manifest 不包含时间戳和耗时；同一现场与同一 spec 应生成字节一致的 JSON。任务耗时和 oracle 结果继续由 VerifyTrace/evaluation cohort 记录。
