#!/usr/bin/env python3
"""Live drive monitor v3 - persistent, rotating-log, reconnecting.

Designed to run continuously under systemd. Subscribes to cereal sockets and
emits JSON-line events for state transitions, alerts, engagement events,
panda transitions, longitudinal plan flips, driver monitoring events,
brake-pred crossings, location/calibration status changes, and button presses.

Outputs:
  /data/drive-monitor.log[.1..5]   rotating, 100MB each (configurable via env)

Environment overrides:
  DRIVE_MONITOR_LOG       default /data/drive-monitor.log
  DRIVE_MONITOR_MAX_BYTES default 104857600 (100 MB)
  DRIVE_MONITOR_BACKUPS   default 5
  DRIVE_MONITOR_OP_DIR    default /data/openpilot
  DRIVE_MONITOR_HEARTBEAT default 10 (seconds)
  DRIVE_MONITOR_SNAPSHOT  default 60 (seconds)
"""
from __future__ import annotations

import json
import logging
import logging.handlers
import os
import signal
import sys
import time
from typing import Any, Dict

LOG_PATH = os.environ.get("DRIVE_MONITOR_LOG", "/data/drive-monitor.log")
MAX_BYTES = int(os.environ.get("DRIVE_MONITOR_MAX_BYTES", str(100 * 1024 * 1024)))
BACKUPS = int(os.environ.get("DRIVE_MONITOR_BACKUPS", "5"))
OP_DIR = os.environ.get("DRIVE_MONITOR_OP_DIR", "/data/openpilot")
HEARTBEAT_SEC = float(os.environ.get("DRIVE_MONITOR_HEARTBEAT", "10"))
SNAPSHOT_SEC = float(os.environ.get("DRIVE_MONITOR_SNAPSHOT", "60"))
VERSION = 4  # v4: brake_pred Schmitt trigger + carState context for regen-hypothesis testing

SOCKETS = [
    "selfdriveState",
    "pandaStates",
    "controlsState",
    "carState",
    "longitudinalPlan",
    "modelV2",
    "driverMonitoringState",
    "liveCalibration",
    "liveLocationKalman",
]

logger = logging.getLogger("drive-monitor")
logger.setLevel(logging.INFO)
logger.propagate = False
_handler = logging.handlers.RotatingFileHandler(
    LOG_PATH, maxBytes=MAX_BYTES, backupCount=BACKUPS
)
_handler.setFormatter(logging.Formatter("%(message)s"))
logger.addHandler(_handler)

_stderr = logging.StreamHandler(sys.stderr)
_stderr.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
_stderr.setLevel(logging.WARNING)
logger.addHandler(_stderr)


def emit(event: str, **fields: Any) -> None:
    rec = {"ts": time.time(), "event": event}
    rec.update(fields)
    try:
        logger.info(json.dumps(rec, default=str))
    except Exception as e:
        sys.stderr.write(f"emit-fail {event}: {e}\n")


_shutdown = False


def _sig_handler(signum, _frame):
    global _shutdown
    _shutdown = True
    emit("monitor_signal", signum=int(signum))


signal.signal(signal.SIGTERM, _sig_handler)
signal.signal(signal.SIGINT, _sig_handler)
signal.signal(signal.SIGHUP, _sig_handler)

sys.path.insert(0, OP_DIR)
try:
    import cereal.messaging as messaging  # type: ignore
except Exception as e:
    emit("fatal_import", err=str(e)[:300], op_dir=OP_DIR)
    sys.stderr.write(f"cereal import failed: {e}\n")
    sys.exit(2)


def _subscribe(name: str):
    return messaging.sub_sock(name, timeout=500, conflate=True)


subs: Dict[str, Any] = {}


def _ensure_subs() -> None:
    for name in SOCKETS:
        if name in subs:
            continue
        try:
            subs[name] = _subscribe(name)
            emit("sub_connected", sock=name)
        except Exception as e:
            emit("sub_failed", sock=name, err=str(e)[:200])


_ensure_subs()
emit(
    "monitor_started",
    pid=os.getpid(),
    version=VERSION,
    log_path=LOG_PATH,
    max_bytes=MAX_BYTES,
    backups=BACKUPS,
    sockets=list(subs.keys()),
)
sys.stderr.write(f"drive-monitor v{VERSION} pid={os.getpid()} log={LOG_PATH}\n")

prev: Dict[str, Any] = {}
prev_buttons: Dict[str, bool] = {}
last_heartbeat = 0.0
last_snapshot = 0.0
err_count = 0
loop_count = 0


def _process_selfdrive(payload) -> None:
    cur = {
        "state": str(payload.state),
        "enabled": payload.enabled,
        "active": payload.active,
        "alertText1": payload.alertText1 or "",
        "alertText2": payload.alertText2 or "",
        "alertType": payload.alertType or "",
        "alertStatus": str(payload.alertStatus) if hasattr(payload, "alertStatus") else "",
        "alertSize": str(payload.alertSize) if hasattr(payload, "alertSize") else "",
        "experimentalMode": payload.experimentalMode,
        "engageable": payload.engageable,
        "personality": str(payload.personality),
    }
    p = prev.get("selfdriveState", {})
    if cur["alertText1"] != p.get("alertText1", ""):
        emit(
            "alert",
            alertText1=cur["alertText1"],
            alertText2=cur["alertText2"],
            alertType=cur["alertType"],
            alertStatus=cur["alertStatus"],
            alertSize=cur["alertSize"],
            state=cur["state"],
            enabled=cur["enabled"],
        )
    if cur["state"] != p.get("state"):
        emit("state_change",
             **{"from": p.get("state", "?"), "to": cur["state"],
                "enabled": cur["enabled"], "active": cur["active"]})
    if cur["experimentalMode"] != p.get("experimentalMode"):
        emit("experimental_mode_change", to=cur["experimentalMode"], state=cur["state"])
    if cur["personality"] != p.get("personality") and "personality" in p:
        emit("personality_change", **{"from": p["personality"], "to": cur["personality"]})
    prev["selfdriveState"] = cur


def _process_panda(payload) -> None:
    if not payload:
        return
    ps = payload[0]
    cur = {
        "safetyModel": str(ps.safetyModel),
        "ignitionCan": ps.ignitionCan,
        "ignitionLine": ps.ignitionLine,
        "controlsAllowed": ps.controlsAllowed,
        "voltage": round(ps.voltage / 1000.0, 2),
        "faultStatus": str(ps.faultStatus),
        "safetyTxBlocked": ps.safetyTxBlocked,
    }
    p = prev.get("pandaStates", {})
    if (p.get("controlsAllowed") != cur["controlsAllowed"]
            or p.get("ignitionCan") != cur["ignitionCan"]
            or p.get("ignitionLine") != cur["ignitionLine"]
            or p.get("safetyModel") != cur["safetyModel"]
            or p.get("faultStatus") != cur["faultStatus"]):
        emit("panda_change", **cur)
    prev["pandaStates"] = cur


def _process_controls(payload) -> None:
    cur = {
        "longControlState": str(payload.longControlState),
        "lateralControlState": payload.lateralControlState.which() if hasattr(payload, "lateralControlState") else "?",
        "curvature": round(float(payload.curvature), 5),
        "forceDecel": bool(payload.forceDecel),
    }
    p = prev.get("controlsState", {})
    if cur["longControlState"] != p.get("longControlState"):
        emit("long_state_change",
             **{"from": p.get("longControlState", "?"), "to": cur["longControlState"]})
    if cur["forceDecel"] != p.get("forceDecel"):
        emit("forceDecel_change", to=cur["forceDecel"])
    if cur["lateralControlState"] != p.get("lateralControlState") and "lateralControlState" in p:
        emit("lat_state_change",
             **{"from": p.get("lateralControlState", "?"), "to": cur["lateralControlState"]})
    prev["controlsState"] = cur


def _process_long_plan(payload) -> None:
    src = str(payload.longitudinalPlanSource)
    p = prev.get("longitudinalPlan")
    if p != src:
        emit("long_plan_source_change", to=src, **({"from": p} if p else {}))
        prev["longitudinalPlan"] = src


# brake-pred state machine (Schmitt trigger). Single-threshold crossing produced
# bursty noise around 0.30; with a dead-band the signal only fires when the
# probability actually commits to "high" or "low". Tuned from observed 0.20..0.40
# noise envelope; widen if real-drive data shows real predictions sitting in band.
BRAKE_PRED_HIGH = 0.40
BRAKE_PRED_LOW = 0.20


def _process_model(payload) -> None:
    if not hasattr(payload, "meta"):
        return
    meta = payload.meta
    try:
        bp = list(meta.disengagePredictions.brakeDisengageProbs or [])
    except Exception:
        bp = []
    if not bp:
        return
    mb = max(bp)
    prev["modelV2_brake"] = mb
    state = prev.get("modelV2_brake_state", "low")
    new_state = state
    if state == "low" and mb >= BRAKE_PRED_HIGH:
        new_state = "high"
    elif state == "high" and mb <= BRAKE_PRED_LOW:
        new_state = "low"
    if new_state == state:
        return
    prev["modelV2_brake_state"] = new_state
    # Snapshot carState context so we can prove/refute the regen-braking hypothesis
    # from logged data on real drives, without re-running the device.
    cs = prev.get("carState", {})
    ss = prev.get("selfdriveState", {})
    cps = prev.get("controlsState", {})
    emit("brake_pred_state_change",
         **{"from": state, "to": new_state, "value": round(mb, 2)},
         vEgo_mph=cs.get("vEgo_mph"),
         gas_pressed=cs.get("gas_pressed"),
         brake_pressed=cs.get("brake_pressed"),
         regen_braking=cs.get("regen_braking"),
         cruise_enabled=cs.get("cruise_enabled"),
         long_state=cps.get("longControlState"),
         sd_state=ss.get("state"),
         sd_active=ss.get("active"))


def _process_dm(payload) -> None:
    cur = {
        "isDistracted": bool(payload.isDistracted),
        "events_count": len(payload.events),
        "awarenessStatus": round(float(payload.awarenessStatus), 2) if hasattr(payload, "awarenessStatus") else None,
    }
    p = prev.get("driverMonitoringState", {})
    if p.get("events_count", 0) != cur["events_count"]:
        emit("dm_events", **cur)
    if p.get("isDistracted") != cur["isDistracted"] and "isDistracted" in p:
        emit("dm_distraction_change", **{"from": p["isDistracted"], "to": cur["isDistracted"]})
    prev["driverMonitoringState"] = cur


def _process_car_state(payload) -> None:
    cs = payload
    cur = {
        "vEgo_mph": round(cs.vEgo * 2.23694, 1),
        "cruise_enabled": cs.cruiseState.enabled,
        "cruise_available": cs.cruiseState.available,
        "cruise_speed_mph": round(cs.cruiseState.speed * 2.23694, 1),
        "brake_pressed": cs.brakePressed,
        "gas_pressed": cs.gasPressed,
        "regen_braking": cs.regenBraking if hasattr(cs, "regenBraking") else False,
        "steering_pressed": cs.steeringPressed if hasattr(cs, "steeringPressed") else False,
        "door_open": cs.doorOpen if hasattr(cs, "doorOpen") else False,
        "seatbelt_unlatched": cs.seatbeltUnlatched if hasattr(cs, "seatbeltUnlatched") else False,
    }
    p = prev.get("carState", {})
    if (p.get("cruise_enabled") != cur["cruise_enabled"]
            or p.get("cruise_available") != cur["cruise_available"]):
        emit("cruise_change", **cur)
    if p.get("door_open") != cur["door_open"] and "door_open" in p:
        emit("door_change", to=cur["door_open"])
    if p.get("seatbelt_unlatched") != cur["seatbelt_unlatched"] and "seatbelt_unlatched" in p:
        emit("seatbelt_change", to=cur["seatbelt_unlatched"])
    if p.get("steering_pressed") != cur["steering_pressed"] and "steering_pressed" in p:
        emit("steering_override", to=cur["steering_pressed"])

    try:
        for be in cs.buttonEvents:
            btype = str(be.type)
            pressed = bool(be.pressed)
            last = prev_buttons.get(btype)
            if last != pressed:
                emit("button", type=btype, pressed=pressed)
                prev_buttons[btype] = pressed
    except Exception:
        pass

    prev["carState"] = cur


def _process_live_cal(payload) -> None:
    cur = {
        "calStatus": str(payload.calStatus),
        "calPerc": int(payload.calPerc) if hasattr(payload, "calPerc") else None,
        "validBlocks": int(payload.validBlocks) if hasattr(payload, "validBlocks") else None,
    }
    p = prev.get("liveCalibration", {})
    if p.get("calStatus") != cur["calStatus"]:
        emit("calibration_status",
             **{"from": p.get("calStatus", "?"), "to": cur["calStatus"], "calPerc": cur["calPerc"]})
    prev["liveCalibration"] = cur


def _process_live_loc(payload) -> None:
    cur = {
        "status": str(payload.status) if hasattr(payload, "status") else "?",
        "inputsOK": bool(payload.inputsOK) if hasattr(payload, "inputsOK") else None,
        "sensorsOK": bool(payload.sensorsOK) if hasattr(payload, "sensorsOK") else None,
        "gpsOK": bool(payload.gpsOK) if hasattr(payload, "gpsOK") else None,
        "posenetOK": bool(payload.posenetOK) if hasattr(payload, "posenetOK") else None,
        "deviceStable": bool(payload.deviceStable) if hasattr(payload, "deviceStable") else None,
        "excessiveResets": bool(payload.excessiveResets) if hasattr(payload, "excessiveResets") else None,
    }
    p = prev.get("liveLocationKalman", {})
    keys = ("status", "inputsOK", "sensorsOK", "gpsOK", "posenetOK", "deviceStable")
    if p and any(p.get(k) != cur.get(k) for k in keys):
        emit("locationd_status", **{f"prev_{k}": p.get(k) for k in keys}, **cur)
    elif not p:
        emit("locationd_status_init", **cur)
    prev["liveLocationKalman"] = cur


HANDLERS = {
    "selfdriveState": _process_selfdrive,
    "pandaStates": _process_panda,
    "controlsState": _process_controls,
    "longitudinalPlan": _process_long_plan,
    "modelV2": _process_model,
    "driverMonitoringState": _process_dm,
    "carState": _process_car_state,
    "liveCalibration": _process_live_cal,
    "liveLocationKalman": _process_live_loc,
}


def main() -> int:
    global last_heartbeat, last_snapshot, err_count, loop_count

    while not _shutdown:
        loop_count += 1
        if loop_count % 100 == 0:
            _ensure_subs()

        for name in list(subs.keys()):
            sock = subs.get(name)
            if sock is None:
                continue
            try:
                m = messaging.recv_one_or_none(sock)
            except Exception as e:
                err = str(e)[:200]
                emit("sock_recv_error", sock=name, err=err)
                subs.pop(name, None)
                continue
            if m is None:
                continue
            try:
                payload = getattr(m, name)
                handler = HANDLERS.get(name)
                if handler:
                    handler(payload)
            except Exception as e:
                err = str(e)[:200]
                if "no such member" in err:
                    continue
                err_count += 1
                if err_count < 100 or err_count % 100 == 0:
                    emit("handler_error", sock=name, err=err, total=err_count)

        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_SEC:
            emit("heartbeat", pid=os.getpid(), loop=loop_count, errors=err_count)
            last_heartbeat = now

        if now - last_snapshot >= SNAPSHOT_SEC:
            snap = {k: prev.get(k) for k in (
                "selfdriveState", "pandaStates", "controlsState", "carState",
                "driverMonitoringState", "liveCalibration", "liveLocationKalman")}
            snap["longitudinalPlanSource"] = prev.get("longitudinalPlan")
            emit("snapshot", **snap)
            last_snapshot = now

        time.sleep(0.05)

    emit("monitor_stopping", pid=os.getpid(), loops=loop_count, errors=err_count)
    for h in logger.handlers:
        try:
            h.flush()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        emit("monitor_crash", err=str(e)[:500])
        sys.stderr.write(f"drive-monitor crashed: {e}\n")
        sys.exit(3)
