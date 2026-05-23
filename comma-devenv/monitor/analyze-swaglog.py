#!/usr/bin/env python3
"""Analyze openpilot swaglog files for WARN/ERR clusters in a time window.

Usage:  ssh comma 'cat /data/log/swaglog.0000146*' | ./analyze-swaglog.py [start_ts] [end_ts]

Defaults to the burst window 1779513510..1779513620.
"""
import json, sys, time
from collections import Counter

start_ts = float(sys.argv[1]) if len(sys.argv) > 1 else 1779513510
end_ts   = float(sys.argv[2]) if len(sys.argv) > 2 else 1779513620

by_loc = Counter()
samples = {}
total_warn = total_err = total_lines = 0
in_window_warn = in_window_err = 0

for line in sys.stdin:
    total_lines += 1
    try:
        r = json.loads(line)
    except Exception:
        continue
    lvl = r.get("level", "?")
    if lvl == "WARNING":
        total_warn += 1
    elif lvl == "ERROR":
        total_err += 1
    else:
        continue
    ts = r.get("created", 0)
    if not (start_ts <= ts <= end_ts):
        continue
    if lvl == "WARNING":
        in_window_warn += 1
    else:
        in_window_err += 1
    proc = r.get("ctx", {}).get("daemon", "?")
    loc = f'{r.get("filename","?")}:{r.get("lineno","?")}'
    key = (lvl, proc, loc)
    by_loc[key] += 1
    if key not in samples:
        samples[key] = (r.get("msg") or "")[:200]

print(f"lines parsed: {total_lines}")
print(f"total WARNING: {total_warn}  ERROR: {total_err}")
print(f"in window {time.strftime('%H:%M:%S', time.gmtime(start_ts))}-{time.strftime('%H:%M:%S', time.gmtime(end_ts))} UTC: {in_window_warn} WARN, {in_window_err} ERR")
print()
print("top sources:")
for (lvl, proc, loc), n in by_loc.most_common(30):
    msg = samples[(lvl, proc, loc)]
    print(f"  {n:>4}x {lvl:7} {proc:18} {loc:55} {msg}")
