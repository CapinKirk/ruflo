#!/usr/bin/env bash
# query-drive.sh - Mac-side helper to fetch and summarize the comma's
# /data/drive-monitor.log (rotated JSON lines).
#
# Usage:
#   ./query-drive.sh tail [N]            last N events (default 50)
#   ./query-drive.sh since DURATION      events newer than DURATION ago
#                                        (e.g. 30s, 5m, 1h, 2d)
#   ./query-drive.sh alerts [N]          most recent N 'alert' events
#   ./query-drive.sh state-changes [N]   most recent N engagement transitions
#   ./query-drive.sh buttons [N]         most recent N button presses
#   ./query-drive.sh stats               count of each event type
#   ./query-drive.sh raw                 dump raw log to stdout
#   ./query-drive.sh follow              live tail with pretty-print
#
# Env: HOST=comma (override with HOST=192.168.1.66 ./query-drive.sh stats)

set -euo pipefail

HOST="${HOST:-comma}"
CMD="${1:-tail}"
shift || true

fetch_all() {
  ssh "$HOST" "cat /data/drive-monitor.log.5 /data/drive-monitor.log.4 /data/drive-monitor.log.3 /data/drive-monitor.log.2 /data/drive-monitor.log.1 /data/drive-monitor.log 2>/dev/null"
}

fetch_tail() {
  local n="${1:-50}"
  ssh "$HOST" "tail -n $n /data/drive-monitor.log"
}

duration_to_sec() {
  local d="$1"
  local n="${d%[a-z]*}"
  local u="${d##*[0-9]}"
  case "$u" in
    s|"") echo "$n" ;;
    m)    echo "$((n * 60))" ;;
    h)    echo "$((n * 3600))" ;;
    d)    echo "$((n * 86400))" ;;
    *)    echo "BAD" ;;
  esac
}

PRETTY=$(cat <<'PY'
import json, sys, time, os
COLOR = sys.stdout.isatty()
def c(code, s):
    return f"\033[{code}m{s}\033[0m" if COLOR else s
EVENT_COLORS = {
    "alert": "1;31",
    "state_change": "1;33",
    "panda_change": "1;35",
    "cruise_change": "1;36",
    "long_state_change": "0;36",
    "long_plan_source_change": "0;90",
    "experimental_mode_change": "1;34",
    "forceDecel_change": "1;31",
    "button": "1;32",
    "dm_events": "1;31",
    "dm_distraction_change": "1;31",
    "calibration_status": "1;33",
    "locationd_status": "0;33",
    "brake_pred_state_change": "1;35",
    "brake_pred_cross_30": "0;90",
    "heartbeat": "0;90",
    "snapshot": "0;90",
    "monitor_started": "1;32",
    "monitor_stopping": "1;33",
    "monitor_crash": "1;31",
    "handler_error": "0;31",
    "sock_recv_error": "0;31",
    "sub_failed": "0;31",
    "sub_connected": "0;32",
}
filt = os.environ.get("FILTER_EVENT", "")
since = float(os.environ.get("SINCE_TS", "0") or 0)
limit = int(os.environ.get("LIMIT", "0") or 0)
quiet_heartbeat = os.environ.get("QUIET_HEARTBEAT", "1") == "1"
rows = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    ts = r.get("ts", 0)
    if since and ts < since:
        continue
    ev = r.get("event", "?")
    if filt and ev != filt:
        continue
    if quiet_heartbeat and ev == "heartbeat" and not filt:
        continue
    rows.append(r)
if limit > 0:
    rows = rows[-limit:]
for r in rows:
    ts = r.get("ts", 0)
    ev = r.get("event", "?")
    when = time.strftime("%H:%M:%S", time.localtime(ts))
    ms = int((ts - int(ts)) * 1000)
    rest = {k: v for k, v in r.items() if k not in ("ts", "event")}
    rest_s = json.dumps(rest, ensure_ascii=False) if rest else ""
    code = EVENT_COLORS.get(ev, "0")
    print(f"{c('0;90', when + '.' + f'{ms:03d}')}  {c(code, ev):<28} {rest_s}")
PY
)

run_pretty() { python3 -c "$PRETTY"; }

case "$CMD" in
  raw)
    fetch_all
    ;;
  tail)
    n="${1:-50}"
    QUIET_HEARTBEAT=1 LIMIT="$n" fetch_tail $((n * 4)) | run_pretty
    ;;
  follow)
    ssh "$HOST" "tail -F /data/drive-monitor.log" | QUIET_HEARTBEAT=1 run_pretty
    ;;
  since)
    arg="${1:-1h}"
    sec="$(duration_to_sec "$arg")"
    if [[ "$sec" == "BAD" ]]; then
      echo "bad duration: $arg (use 30s, 5m, 1h, 2d)" >&2; exit 2
    fi
    now=$(date +%s)
    SINCE_TS=$((now - sec)) QUIET_HEARTBEAT=1 fetch_all | run_pretty
    ;;
  alerts)
    n="${1:-100}"
    FILTER_EVENT=alert LIMIT="$n" fetch_all | run_pretty
    ;;
  state-changes|states)
    n="${1:-100}"
    FILTER_EVENT=state_change LIMIT="$n" fetch_all | run_pretty
    ;;
  buttons)
    n="${1:-100}"
    FILTER_EVENT=button LIMIT="$n" fetch_all | run_pretty
    ;;
  stats)
    fetch_all | python3 -c '
import json, sys
from collections import Counter
c = Counter()
total = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line).get("event", "?")
    except Exception:
        continue
    c[ev] += 1
    total += 1
print(f"total events: {total}")
for ev, n in c.most_common():
    print(f"  {n:>8}  {ev}")
'
    ;;
  *)
    cat <<EOF
usage: $0 <subcommand> [args]

  tail [N]            last N events (default 50), heartbeats hidden
  since DURATION      events newer than DURATION (30s|5m|1h|2d)
  alerts [N]          recent alerts
  state-changes [N]   recent engagement transitions
  buttons [N]         recent button presses
  stats               count of each event type
  follow              live tail with pretty-print
  raw                 dump raw concatenated log

env:
  HOST=comma          ssh host (default: comma)
EOF
    exit 2
    ;;
esac
