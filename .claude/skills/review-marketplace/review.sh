#!/usr/bin/env bash
# @file Runs CI's marketplace checks locally: sync drift, strict validation, mod tests, plugin rules, typecheck, vendored zod, versions, names
# @tags ci, validation, marketplace
# @related .claude/skills/review-marketplace/review.ts, scripts/generate-release-config.ts, .github/workflows/validate.yml
# Usage: review.sh [repo root]. Runs review.ts, which holds the checks.
here=$(cd "$(dirname "$0")" && pwd)
exec node "$here/review.ts" "$@"
