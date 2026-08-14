#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -eq 0 ]]; then
    exec node "$repo_root/src/cli.mjs" --help
fi

exec node "$repo_root/src/cli.mjs" "$@"
