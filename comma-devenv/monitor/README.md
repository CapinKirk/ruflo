# Drive Monitor v3

Persistent, self-restarting drive monitor for the comma four. Subscribes to
cereal sockets, emits JSON-line events to a rotating log on `/data`, and is
managed by `systemd --user` so it auto-starts at boot and recovers from
crashes.

## What it captures

| Event | When |
|---|---|
| `state_change` | `selfdriveState.state` flips (disabled / preEnabled / enabled / softDisabling / overriding) |
| `alert` | New `alertText1` from selfdriveState (full text + type + status + size) |
| `experimental_mode_change` | Experimental mode toggled |
| `personality_change` | Personality switched |
| `long_state_change` | `controlsState.longControlState` transitions (off / pid / stopping / starting) |
| `lat_state_change` | Lateral controller mode change |
| `forceDecel_change` | Force-decel asserted/cleared |
| `long_plan_source_change` | `longitudinalPlan.longitudinalPlanSource` flips (cruise / lead0 / lead1 / cruisePrev) |
| `panda_change` | controlsAllowed / ignitionCan / ignitionLine / safetyModel / faultStatus change |
| `cruise_change` | Cruise enabled/available transitions |
| `dm_events` / `dm_distraction_change` | Driver monitoring events |
| `brake_pred_state_change` | modelV2 brake-disengage prob commits high (≥0.40) or low (≤0.20); Schmitt trigger avoids flap. Event payload includes `vEgo_mph`, `gas_pressed`, `brake_pressed`, `regen_braking`, `cruise_enabled`, `long_state`, `sd_state` for post-hoc correlation (e.g., hybrid-regen vs. real braking-intent). |
| `calibration_status` | liveCalibration calStatus transitions |
| `locationd_status` | liveLocationKalman status / inputsOK / sensorsOK / gpsOK / posenetOK / deviceStable change |
| `button` | Steering-wheel buttons: cancel, setCruise, resumeCruise, accelCruise, decelCruise, gapAdjustCruise, lkas, mainCruise, leftBlinker, rightBlinker |
| `door_change` / `seatbelt_change` / `steering_override` | Carstate transitions |
| `heartbeat` | Every 10 s (liveness marker) |
| `snapshot` | Every 60 s (full current state) |
| `monitor_started` / `monitor_stopping` / `monitor_crash` | Lifecycle |
| `sub_connected` / `sub_failed` / `sock_recv_error` | Reconnect telemetry |

All events are one JSON object per line: `{"ts": <unix>, "event": "<name>", ...}`.

## Files

```
monitor/
  drive-monitor-v3.py       monitor itself (runs on device)
  drive-monitor.service     systemd --user unit (installed to ~/.config/systemd/user/)
  install-monitor.sh        Mac-side installer (scp + enable + verify)
  query-drive.sh            Mac-side log query/summarize
```

## Install

From the Mac:

```bash
cd /Users/prestonharris/Claude-Codex/Ruflo/comma-devenv/monitor
./install-monitor.sh
```

The installer:

1. Verifies ssh to `comma`.
2. Enables systemd linger for the `comma` user (so user-services boot
   without a login session) — required because AGNOS rootfs (`/etc/systemd/system`)
   is read-only; we cannot install a system unit there.
3. scp's `drive-monitor-v3.py` to `/data/drive-monitor-v3.py`.
4. Installs the unit at `~/.config/systemd/user/drive-monitor.service`.
5. Kills any running v2 monitor.
6. `systemctl --user enable --now drive-monitor.service`.
7. Waits 15 s and confirms heartbeats are landing in the log.

## Verify

Non-interactive ssh shells don't have `XDG_RUNTIME_DIR` set, so prefix
`systemctl --user` and `journalctl --user` calls with it (or just `ssh -t`).

```bash
# Active?
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active drive-monitor.service'

# Recent systemd output
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u drive-monitor -n 50 --no-pager'

# Live tail of the JSON log
ssh comma 'tail -F /data/drive-monitor.log'
```

Reboot test:

```bash
ssh comma 'sudo reboot'
# wait ~90s
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active drive-monitor.service'
ssh comma 'tail -5 /data/drive-monitor.log'   # heartbeat should be < 15s old
```

## Query from the Mac

```bash
./query-drive.sh tail 50              # last 50 events (heartbeats hidden)
./query-drive.sh since 30m            # everything in the last 30 minutes
./query-drive.sh since 1h             # last hour
./query-drive.sh alerts               # only alerts
./query-drive.sh state-changes        # only engagement transitions
./query-drive.sh buttons              # only button presses (cancel / set / resume / etc.)
./query-drive.sh stats                # count of each event type across rotated logs
./query-drive.sh follow               # live tail, pretty-printed
./query-drive.sh raw                  # raw JSON, all rotated logs concatenated
```

Color-coded by severity (alerts red, state changes yellow, buttons green,
plan-source changes dim). Times are printed in local-time HH:MM:SS.mmm.

## Log rotation

- Active log: `/data/drive-monitor.log`
- Rotated:    `/data/drive-monitor.log.1` ... `.5`
- Max size:   100 MB per file (configurable via `DRIVE_MONITOR_MAX_BYTES`)
- Backups:    5 (configurable via `DRIVE_MONITOR_BACKUPS`)
- Total cap:  ~600 MB on `/data` (well within available space)

Python's `RotatingFileHandler` does the rotation; no logrotate config needed
on AGNOS.

## Troubleshooting

All `systemctl --user` / `journalctl --user` commands below need
`XDG_RUNTIME_DIR=/run/user/$(id -u)` prefixed when run over non-interactive
ssh. Add it to your shell once with `alias scu='XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user'`
on the device if you'll be debugging often.

**Service won't start.**
```bash
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status drive-monitor.service --no-pager -l'
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u drive-monitor -n 100 --no-pager'
```

**Heartbeat missing after install.**
- Check the unit is enabled: `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-enabled drive-monitor.service`
- Confirm linger: `ls /var/lib/systemd/linger/comma`
- Inspect cereal import error: look for `fatal_import` in the log.

**v2 still running.**
The installer kills it; verify with `pgrep -fa drive-monitor`.

**Log spam from schema mismatches.**
The handler silently drops `no such member` errors. Other handler errors
emit at most every 100th occurrence to avoid filling disk.

**Stop / disable.**
```bash
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop drive-monitor.service'
ssh comma 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user disable drive-monitor.service'
```

## Why systemd --user (not a system unit)?

AGNOS mounts the root filesystem read-only:

```
/dev/sda6 on / type ext4 (ro,relatime,data=ordered)
```

`/etc/systemd/system/` is therefore not writable on an OTA-updated device.
`/home/comma` is on an overlay (`upperdir=/rwtmp/home_upper`) and writable;
`systemd --user` for the comma user is already running. Pairing that with
`loginctl enable-linger comma` (writes to `/var/lib/systemd/linger` which
*is* writable via sudo) gives us boot-time autostart without touching the
read-only system tree.

Alternative considered: patching `launch_chffrplus.sh` to fork the monitor.
Rejected — the launch script is part of the openpilot tree and gets
clobbered on update/reset, and the monitor would die whenever the openpilot
manager restarts.
