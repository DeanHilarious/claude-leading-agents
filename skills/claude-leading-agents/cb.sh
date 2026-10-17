#!/bin/bash
# Headless CodeBuddy run, confined by permission mode + tool allowlist (CodeBuddy has no OS sandbox).
# usage: cb.sh <work-dir> <spec.md> <out-prefix> [model] [effort] [mode]
#   mode: write (default, may edit files + run tests) | read (read-only research)
#   env:  CB_RESUME=<session-id>   resume that session instead of starting a new one
#         CB_MAX_TURNS=200         turn cap
#         CB_BIN=/path/to/codebuddy  CLI binary (default: codebuddy on PATH)
#         CB_EXTRA_TOOLS="Bash(make test*)"  one extra allowed tool pattern
# writes <out-prefix>.json (raw) and <out-prefix>.md (final message); prints a one-line summary.
set -u
DIR=$1 SPEC=$2 OUT=$3 MODEL=${4:-glm-5.3} EFFORT=${5:-medium} MODE=${6:-write}
CB=${CB_BIN:-codebuddy}
case $OUT in /*) ;; *) OUT=$PWD/$OUT ;; esac
cd "$DIR" || exit 1

READ_TOOLS=(Read Glob Grep TodoWrite "Bash(ls*)" "Bash(cat*)" "Bash(grep*)" "Bash(rg*)" "Bash(find*)" "Bash(wc*)"
  "Bash(head*)" "Bash(tail*)" "Bash(git diff*)" "Bash(git status*)" "Bash(git log*)" "Bash(git show*)")
TEST_TOOLS=("Bash(npm test*)" "Bash(npm run *)" "Bash(npx tsc*)" "Bash(node --test*)" "Bash(python3 -m unittest*)"
  "Bash(python3 -m pytest*)" "Bash(pytest*)" "Bash(python3 *)" "Bash(go test*)" "Bash(go build*)" "Bash(cargo test*)" "Bash(cargo build*)")
DENY=(WebFetch WebSearch "Bash(git add*)" "Bash(git commit*)" "Bash(git push*)" "Bash(git reset*)" "Bash(git checkout*)"
  "Bash(git stash*)" "Bash(git merge*)" "Bash(git rebase*)" "Bash(npm install*)" "Bash(npm ci*)" "Bash(pip install*)"
  "Bash(rm -rf*)" "Bash(curl*)" "Bash(wget*)" "Bash(sudo*)")
if [ "$MODE" = read ]; then
  ALLOW=("${READ_TOOLS[@]}"); PERM=default; DENY+=(Edit Write)
else
  ALLOW=(Edit Write "${READ_TOOLS[@]}" "${TEST_TOOLS[@]}"); PERM=acceptEdits
  [ -n "${CB_EXTRA_TOOLS:-}" ] && ALLOW+=("$CB_EXTRA_TOOLS")
fi
RESUME=(); [ -n "${CB_RESUME:-}" ] && RESUME=(-r "$CB_RESUME")
# Allowlist patterns match by command prefix, so compound commands (cd X && ..., a | b) get denied in -p mode.
RULE="你已经在工作目录 $PWD 里。Bash 每次只运行一条简单命令：不要 cd，不要用 &&、;、| 串联，不要 2>&1 之类的重定向；测试直接运行规格里写的测试命令。需要看文件用 Read/Glob/Grep 工具。"

"$CB" -p "$(cat "$SPEC")" ${RESUME[@]+"${RESUME[@]}"} --append-system-prompt "$RULE" \
  --output-format json --model "$MODEL" --effort "$EFFORT" --max-turns "${CB_MAX_TURNS:-200}" \
  --permission-mode "$PERM" --allowedTools "${ALLOW[@]}" --disallowedTools "${DENY[@]}" \
  > "$OUT.json" 2> "$OUT.err" < /dev/null
CODE=$?

python3 - "$OUT" "$CODE" <<'EOF'
import json, sys
out, code = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(out + ".json"))
except Exception as e:
    print(f"codebuddy exit={code}; unreadable output ({e}); see {out}.err")
    raise SystemExit(0)
items = data if isinstance(data, list) else [data]
r = next((x for x in reversed(items) if x.get("type") == "result"), {})
open(out + ".md", "w").write(r.get("result") or "")
u = r.get("usage") or {}
print(f"codebuddy exit={code} {r.get('subtype')} session={r.get('session_id')} turns={r.get('num_turns')} "
      f"in={u.get('input_tokens')} out={u.get('output_tokens')} denials={len(r.get('permission_denials') or [])} -> {out}.md")
EOF
