#!/usr/bin/env bash
# install-monitor.sh - Deploy drive-monitor-v3 to the comma four.
#
# Steps:
#   1. scp drive-monitor-v3.py to /data/drive-monitor-v3.py
#   2. Install systemd --user unit at ~/.config/systemd/user/drive-monitor.service
#      (AGNOS rootfs is RO; /etc/systemd/system is not writable.
#       Linger is enabled for 'comma' so user-services start at boot.)
#   3. Stop the old drive-monitor-v2.py if running
#   4. Enable & start the new service
#   5. Verify heartbeat after 15s
#
# Usage:  ./install-monitor.sh [host]
#   host: defaults to 'comma' (uses your ssh config)

set -euo pipefail

HOST="${1:-comma}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
LOCAL_PY="$SCRIPT_DIR/drive-monitor-v3.py"
LOCAL_UNIT="$SCRIPT_DIR/drive-monitor.service"

REMOTE_PY="/data/drive-monitor-v3.py"
REMOTE_UNIT_DIR="\$HOME/.config/systemd/user"
REMOTE_UNIT="\$HOME/.config/systemd/user/drive-monitor.service"

cyan()   { printf "\033[1;36m%s\033[0m\n" "$*"; }
green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }

[[ -f "$LOCAL_PY"   ]] || { red "missing $LOCAL_PY";   exit 1; }
[[ -f "$LOCAL_UNIT" ]] || { red "missing $LOCAL_UNIT"; exit 1; }

cyan "==> 1/6 verifying connectivity to $HOST"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "echo OK on \$(hostname)" \
  || { red "ssh $HOST failed"; exit 1; }

cyan "==> 2/6 ensuring linger enabled for 'comma' (so user-services boot)"
ssh "$HOST" "sudo loginctl enable-linger comma 2>/dev/null || true; \
             ls /var/lib/systemd/linger/comma >/dev/null && echo 'linger:ok' || echo 'linger:missing'"

cyan "==> 3/6 copying drive-monitor-v3.py -> $HOST:$REMOTE_PY"
scp -q "$LOCAL_PY" "$HOST:$REMOTE_PY"
ssh "$HOST" "chmod 755 $REMOTE_PY"

cyan "==> 4/6 installing systemd --user unit"
ssh "$HOST" "mkdir -p $REMOTE_UNIT_DIR"
scp -q "$LOCAL_UNIT" "$HOST:/tmp/drive-monitor.service.in"
ssh "$HOST" "mv /tmp/drive-monitor.service.in $REMOTE_UNIT"

cyan "==> 5/6 stopping old v2 monitor (if running) and starting v3"
# Killing the v2 monitor is tricky: pgrep/pkill -f matches the full cmdline,
# which on the remote includes our own ssh-shell argv. Two precautions:
#  (a) use a bracket character class in the pattern so the literal pattern
#      string in our own argv doesn't self-match the regex
#  (b) extract pids first, then kill by pid (so 'kill' doesn't carry the
#      pattern string in its own argv)
ssh "$HOST" 'pids=$(pgrep -f "[d]rive-monitor-v2"); if [ -n "$pids" ]; then kill $pids && echo v2:killed; else echo v2:not-running; fi'
# Non-interactive ssh shells lack XDG_RUNTIME_DIR; systemctl --user needs it
# to find the user instance bus. Set it explicitly from the comma uid.
ssh "$HOST" "export XDG_RUNTIME_DIR=/run/user/\$(id -u) && \
             systemctl --user daemon-reload && \
             systemctl --user enable drive-monitor.service && \
             systemctl --user restart drive-monitor.service && \
             sleep 2 && \
             systemctl --user is-active drive-monitor.service"

cyan "==> 6/6 waiting 15s then checking heartbeat..."
sleep 15
hb_count=$(ssh "$HOST" "tail -n 200 /data/drive-monitor.log 2>/dev/null | grep -c heartbeat || true")
if [[ "${hb_count:-0}" -ge 1 ]]; then
  green "heartbeat OK: $hb_count beats in last 200 lines"
else
  red "no heartbeat found in last 200 lines of /data/drive-monitor.log"
  yellow "diagnose with:  ssh $HOST 'XDG_RUNTIME_DIR=/run/user/\$(id -u) journalctl --user -u drive-monitor -n 50 --no-pager'"
  exit 2
fi

cyan "==> service status:"
ssh "$HOST" "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user status drive-monitor.service --no-pager -l | head -15" || true

green ""
green "Install complete. Tail the log live with:"
green "  ssh $HOST 'tail -F /data/drive-monitor.log'"
green ""
green "Query from this Mac:"
green "  $SCRIPT_DIR/query-drive.sh stats"
green "  $SCRIPT_DIR/query-drive.sh tail 50"
