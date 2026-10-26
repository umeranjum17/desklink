#!/usr/bin/env bash
# Classify a pull request's changed files for the CI path filters.
#
#   git diff --name-only <base> HEAD | .github/workflows/classify-changes.sh <mode>
#
# Prints "<mode>=true|false" so a workflow step can append it to $GITHUB_OUTPUT.
# Plain git and shell: no third-party classifier action runs in the critical
# path. Markdown is docs and is skipped, except SKILL.md, which the axi
# validation checks. A change under .github/ counts as code so a workflow edit
# always exercises the jobs its filter protects.
set -euo pipefail

mode="${1:?usage: classify-changes.sh <packages|native|heavy>}"
matched=false

while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    *.md)
      [ "${file##*/}" = SKILL.md ] || continue
      ;;
  esac
  case "$mode:$file" in
    packages:.github/*|packages:package.json|packages:package-lock.json|packages:tsconfig.base.json|packages:vitest.config.ts|packages:packages/*)
      matched=true
      ;;
    native:.github/*|native:package.json|native:package-lock.json|native:packages/desktop-host/*)
      matched=true
      ;;
    heavy:.github/*|heavy:package.json|heavy:package-lock.json|heavy:tsconfig.base.json|heavy:vitest.config.ts|heavy:packages/*)
      matched=true
      ;;
  esac
  if [ "$matched" = true ]; then
    break
  fi
done

printf '%s=%s\n' "$mode" "$matched"
