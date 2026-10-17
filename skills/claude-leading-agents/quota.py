#!/usr/bin/env python3
"""Print the Codex (ChatGPT plan) usage recorded in the newest session log.

Reads only ~/.codex/sessions/**/rollout-*.jsonl; never touches auth files.
"""
import glob
import json
import os
import time

files = sorted(
    glob.glob(os.path.expanduser("~/.codex/sessions/**/rollout-*.jsonl"), recursive=True),
    key=os.path.getmtime,
)
limits = None
for path in reversed(files[-20:]):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if '"rate_limits"' not in line:
                continue
            try:
                payload = json.loads(line).get("payload", {})
            except json.JSONDecodeError:
                continue
            rl = payload.get("rate_limits") or payload.get("info", {}).get("rate_limits")
            if rl:
                limits = rl
    if limits:
        break

if not limits:
    print("unknown: no rate_limits found in recent Codex sessions")
    raise SystemExit(0)

print(f"plan: {limits.get('plan_type')}")
for name in ("primary", "secondary"):
    w = limits.get(name)
    if not w:
        continue
    resets = time.strftime("%Y-%m-%d %H:%M", time.localtime(w["resets_at"])) if w.get("resets_at") else "?"
    days = (w.get("window_minutes") or 0) / 1440
    print(f"{name}: used {w.get('used_percent')}% of {days:g}-day window, resets {resets}")
credits = limits.get("credits") or {}
print(f"credits: balance {credits.get('balance')}, unlimited {credits.get('unlimited')}")
