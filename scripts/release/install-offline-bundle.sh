#!/usr/bin/env bash
set -euo pipefail

BUNDLE="${1:-}"
VALUES="${2:-}"
[[ -d "$BUNDLE" && -f "$VALUES" ]] || {
  echo "Usage: $0 <bundle-directory> <production-values.yaml>" >&2
  exit 2
}
(cd "$BUNDLE" && sha256sum --check SHA256SUMS)
while IFS= read -r archive; do docker load -i "$archive"; done < <(find "$BUNDLE/images" -name '*.tar' -type f | sort)
node scripts/release/validate-production-values.mjs "$VALUES"
helm upgrade --install guardllm "$BUNDLE/chart" -f "$VALUES" --atomic --timeout 15m
