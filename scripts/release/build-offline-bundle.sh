#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --values <production-values.yaml> --output <directory> --cosign-key <public-key>"
}

VALUES=""
OUTPUT=""
COSIGN_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --values) VALUES="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --cosign-key) COSIGN_KEY="$2"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
[[ -f "$VALUES" && -n "$OUTPUT" && -f "$COSIGN_KEY" ]] || { usage; exit 2; }
for command in node helm yq docker cosign syft sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

node scripts/release/validate-production-values.mjs "$VALUES"
umask 077
mkdir -p "$OUTPUT"/{images,sbom,manifests,chart,policies,migrations,runbooks}
helm template guardllm deploy/helm/guardllm -f "$VALUES" > "$OUTPUT/manifests/guardllm.yaml"
mapfile -t IMAGES < <(yq -r '.. | select(has("image")).image' "$OUTPUT/manifests/guardllm.yaml" | sort -u)
[[ ${#IMAGES[@]} -ge 3 ]] || { echo "Rendered bundle has fewer than three images" >&2; exit 1; }

for image in "${IMAGES[@]}"; do
  [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "Mutable image rejected: $image" >&2; exit 1; }
  cosign verify --key "$COSIGN_KEY" "$image" >/dev/null
  docker pull "$image"
  name="$(printf '%s' "$image" | sha256sum | cut -d' ' -f1)"
  docker save "$image" -o "$OUTPUT/images/$name.tar"
  syft packages "docker:$image" -o "cyclonedx-json=$OUTPUT/sbom/$name.cdx.json"
done

cp -R deploy/helm/guardllm/. "$OUTPUT/chart/"
cp -R deploy/policies/. "$OUTPUT/policies/"
cp -R drizzle/. "$OUTPUT/migrations/"
cp -R docs/runbooks/. "$OUTPUT/runbooks/"
printf '%s\n' "${IMAGES[@]}" > "$OUTPUT/images.txt"
(cd "$OUTPUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "Offline bundle created at $OUTPUT"
