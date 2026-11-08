#!/usr/bin/env bash
# Validate the Route B CI workflow and the platform helper scripts.
#
# Uses Ruby's Psych parser (available on macOS and GitHub's ubuntu runners) so
# the workflow YAML is parsed rather than grepped. Also runs `node --check` on
# the platform .mjs files and `bash -n` on the platform shell scripts.
#
# Usage:
#   ./scripts/route-b/platform/validate-workflows.sh                 # Route B workflow
#   ./scripts/route-b/platform/validate-workflows.sh <workflow>...   # specific files
#   ./scripts/route-b/platform/validate-workflows.sh --all           # all workflows
set -euo pipefail
cd "$(dirname "$0")/../../.." || exit 2

command -v ruby >/dev/null 2>&1 || { echo "validate-workflows: ruby is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "validate-workflows: node is required" >&2; exit 2; }

files=()
if [ "${1:-}" = "--all" ]; then
  while IFS= read -r file; do files+=("$file"); done < <(find .github/workflows -maxdepth 1 -name '*.yml' | sort)
elif [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=(".github/workflows/route-b-platform.yml")
fi

for file in "${files[@]}"; do
  [ -f "$file" ] || { echo "validate-workflows: missing $file" >&2; exit 1; }
  ruby -ryaml -e 'Psych.parse_file(ARGV[0])' "$file"
  # The repository pins every action to a full commit SHA; enforce it for the
  # workflow(s) being validated.
  if grep -nE '^[[:space:]]*(-[[:space:]]*)?uses:' "$file" | grep -vE '@[0-9a-f]{40}([[:space:]]|$)' >/dev/null; then
    echo "validate-workflows: $file has a uses: entry without a full commit SHA" >&2
    grep -nE '^[[:space:]]*(-[[:space:]]*)?uses:' "$file" | grep -vE '@[0-9a-f]{40}([[:space:]]|$)' >&2
    exit 1
  fi
  echo "validate-workflows: YAML OK — $file"
done

for file in scripts/route-b/platform/*.mjs; do
  node --check "$file"
done
for file in scripts/route-b/platform/*.sh; do
  bash -n "$file"
done
echo "validate-workflows: scripts OK"
