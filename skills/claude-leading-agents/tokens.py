#!/usr/bin/env python3
"""Token ledger for the agents Claude dispatched: Codex + CodeBuddy sessions whose working
directory is under the given dirs (default: current dir), optionally only those started after --since.

usage: tokens.py [--since 2026-10-16T20:00] [--json] <dir> [<dir> ...]
Reads ~/.codex/sessions and ~/.codebuddy/projects only; never touches auth files.
"""
import argparse, glob, json, os, re
from datetime import datetime, timezone

ap = argparse.ArgumentParser()
ap.add_argument("dirs", nargs="*", default=[os.getcwd()])
ap.add_argument("--since", help="local time, e.g. 2026-10-16T20:00")
ap.add_argument("--json", action="store_true")
a = ap.parse_args()
roots = [os.path.realpath(d) for d in a.dirs]
since = datetime.fromisoformat(a.since).astimezone(timezone.utc).timestamp() if a.since else 0
under = lambda p: any(os.path.realpath(p) == r or os.path.realpath(p).startswith(r + os.sep) for r in roots)
rows = []

# Codex: rollout files; cwd in session_meta, cumulative usage in the last token_count event.
for f in glob.glob(os.path.expanduser("~/.codex/sessions/**/rollout-*.jsonl"), recursive=True):
    if os.path.getmtime(f) < since:
        continue
    cwd = model = last = None
    with open(f, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if i == 0:
                p = json.loads(line).get("payload", {})
                cwd = p.get("cwd")
                ts = p.get("timestamp", "")
                if not cwd or not under(cwd) or (since and datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() < since):
                    break
            elif '"turn_context"' in line and not model:
                model = json.loads(line).get("payload", {}).get("model")
            elif '"token_count"' in line:
                info = json.loads(line).get("payload", {}).get("info")
                if info:
                    last = info["total_token_usage"]
    if last:
        rows.append(dict(agent="codex", model=model or "?", session=os.path.basename(f)[-41:-6],
                         input=last["input_tokens"], cached=last.get("cached_input_tokens", 0),
                         output=last["output_tokens"], total=last["total_tokens"]))

# CodeBuddy: ~/.codebuddy/projects/<realpath, runs of chars other than alnum/dot -> ->/<session>.jsonl; rawUsage per request (dedupe by messageId).
for r in roots:
    key = re.sub(r"[^A-Za-z0-9.]+", "-", r).strip("-")  # CodeBuddy keeps dots: ~/.codex-runs -> -.codex-runs
    base = os.path.expanduser("~/.codebuddy/projects/")
    pdirs = glob.glob(base + key) + glob.glob(base + key + "-*")
    for f in (x for d in pdirs for x in glob.glob(d + "/*.jsonl")):
        if os.path.getmtime(f) < since:
            continue
        seen, row = set(), dict(agent="codebuddy", model="?", session=os.path.basename(f)[:-6], input=0, cached=0, output=0, total=0)
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                if '"rawUsage"' not in line:
                    continue
                d = json.loads(line)
                if since and d.get("timestamp", 0) / 1000 < since:
                    continue
                pd = d.get("providerData") or {}
                u, mid = pd.get("rawUsage") or {}, pd.get("messageId")
                if not u or mid in seen:
                    continue
                seen.add(mid)
                row["model"] = pd.get("model", row["model"])
                row["input"] += u.get("prompt_tokens", 0)
                row["cached"] += (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
                row["output"] += u.get("completion_tokens", 0)
                row["total"] += u.get("total_tokens", 0)
        if row["total"]:
            rows.append(row)

if a.json:
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    raise SystemExit
fmt = "{:<10} {:<20} {:>12} {:>12} {:>10} {:>12}"
print(fmt.format("agent", "model", "input", "cached", "output", "total"))
for x in sorted(rows, key=lambda x: (x["agent"], -x["total"])):
    print(fmt.format(x["agent"], x["model"][:20], f'{x["input"]:,}', f'{x["cached"]:,}', f'{x["output"]:,}', f'{x["total"]:,}'))
for ag in ("codex", "codebuddy"):
    s = [x for x in rows if x["agent"] == ag]
    if s:
        print(fmt.format(ag + " Σ", f"{len(s)} sessions", f'{sum(x["input"] for x in s):,}', f'{sum(x["cached"] for x in s):,}',
                         f'{sum(x["output"] for x in s):,}', f'{sum(x["total"] for x in s):,}'))
