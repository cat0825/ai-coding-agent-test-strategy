#!/usr/bin/env bash
# 语法门禁：自动扫描 src/ scripts/ oracles/ 下的源文件，新增文件无需登记 package.json。
# 排除 tmp/ 与 fixtures/ —— 那是采集产物，不是本仓库源码。
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
count_mjs=0
count_py=0
count_sh=0

while IFS= read -r f; do
  node --check "$f" || fail=1
  count_mjs=$((count_mjs + 1))
done < <(find src scripts -name '*.mjs' -type f | sort)

while IFS= read -r f; do
  python3 -c "import ast,sys,pathlib; ast.parse(pathlib.Path(sys.argv[1]).read_text())" "$f" || fail=1
  count_py=$((count_py + 1))
done < <(find scripts oracles -name '*.py' -type f | sort)

while IFS= read -r f; do
  bash -n "$f" || fail=1
  count_sh=$((count_sh + 1))
done < <(find scripts -name '*.sh' -type f | sort)

if [ "$fail" -ne 0 ]; then
  echo "syntax gate FAILED"
  exit 1
fi
echo "syntax gate ok: ${count_mjs} .mjs / ${count_py} .py / ${count_sh} .sh"
