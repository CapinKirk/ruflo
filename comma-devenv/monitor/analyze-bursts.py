#!/usr/bin/env python3
"""Analyze brake_pred_cross_30 bursts in drive-monitor JSON log.

Groups crossings into bursts (>2s gap = new burst), then for each burst prints
the surrounding alert/state/cruise context and the most recent snapshot. Used
to determine whether the brake-pred flap correlates with real driving (regen,
following, deceleration) or with openpilot-stack degradation (commIssue,
selfdrivedLagging, disabled state).

Usage:  ssh comma 'cat /data/drive-monitor.log' | ./analyze-bursts.py
"""
import json, sys, time

events = []
for line in sys.stdin:
    try:
        events.append(json.loads(line))
    except Exception:
        continue
events.sort(key=lambda r: r["ts"])

bursts, cur = [], []
for r in events:
    if r["event"] != "brake_pred_cross_30":
        continue
    if not cur or r["ts"] - cur[-1]["ts"] < 2.0:
        cur.append(r)
    else:
        bursts.append(cur); cur = [r]
if cur:
    bursts.append(cur)

print(f"total brake_pred bursts: {len(bursts)}\n")

CTX_EVENTS = {"alert", "state_change", "cruise_change", "panda_change",
              "monitor_started", "experimental_mode_change", "long_state_change",
              "long_plan_source_change"}

def context_window(t_start, t_end, span=5):
    return [r for r in events
            if r["event"] in CTX_EVENTS
            and t_start - span <= r["ts"] <= t_end + span]

def last_snapshot_before(t):
    snap = None
    for r in events:
        if r["event"] == "snapshot" and r["ts"] <= t:
            snap = r
    return snap

for i, b in enumerate(bursts):
    t_start, t_end = b[0]["ts"], b[-1]["ts"]
    when = time.strftime("%H:%M:%S", time.localtime(t_start))
    print(f"--- burst {i+1}: {when}  events={len(b)}  duration={t_end-t_start:.1f}s ---")
    for r in context_window(t_start, t_end):
        cw = time.strftime("%H:%M:%S", time.localtime(r["ts"]))
        rel = r["ts"] - t_start
        if r["event"] == "alert":
            txt = (r.get("alertText1") or "(cleared)")[:60]
            atype = (r.get("alertType") or "")[:40]
            print(f"    {cw} ({rel:+5.1f}s) ALERT: {txt}  type={atype}")
        else:
            rest = {k: v for k, v in r.items()
                    if k not in ("ts", "event", "alertText2", "alertSize", "alertStatus")}
            print(f"    {cw} ({rel:+5.1f}s) {r['event']}: {rest}")
    snap = last_snapshot_before(t_start)
    if snap:
        cs = snap.get("carState", {})
        ss = snap.get("selfdriveState", {})
        ls = snap.get("liveLocationKalman", {})
        cstate = snap.get("controlsState", {})
        age = t_start - snap["ts"]
        print(f"    snap (-{age:.0f}s): state={ss.get('state')} vEgo={cs.get('vEgo_mph')}mph "
              f"cruise_en={cs.get('cruise_enabled')} gas={cs.get('gas_pressed')} "
              f"brake={cs.get('brake_pressed')} long={cstate.get('longControlState')} "
              f"inputsOK={ls.get('inputsOK')}")
    print()
