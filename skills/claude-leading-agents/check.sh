#!/bin/bash
# One-shot acceptance view for Claude: agent reports (tail), change summary, test result (tail).
# usage: check.sh <work-dir> "<test command>" [report.md ...]
#   env: BEFORE=<snapshot dir>  compare against an rsync snapshot instead of git (non-git dirs)
DIR=$1 TEST=$2; shift 2
for r in "$@"; do
  echo "=== report: $(basename "$r") (last 15 lines)"; tail -n 15 "$r" 2>/dev/null; echo
done
cd "$DIR" || exit 1
echo "=== changes"
if [ -n "${BEFORE:-}" ]; then
  diff -rq "$BEFORE" . -x node_modules -x .venv -x dist -x build -x .git -x __pycache__ 2>/dev/null | head -40
else
  git status --short | head -40; git diff --stat | tail -1
fi
echo; echo "=== test: $TEST"
bash -c "$TEST" > "${TMPDIR:-/tmp}/check-test.log" 2>&1; CODE=$?
tail -n 25 "${TMPDIR:-/tmp}/check-test.log"; echo "exit=$CODE"
