#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_html="$repo_root/report/ai-coding-agent-test-strategy.html"
output_pdf="$repo_root/output/pdf/ai-coding-agent-test-strategy.pdf"

if ! command -v weasyprint >/dev/null 2>&1; then
    echo "weasyprint is required to build the PDF" >&2
    exit 1
fi

mkdir -p "$(dirname "$output_pdf")"
weasyprint "$source_html" "$output_pdf"
echo "$output_pdf"
