#!/usr/bin/env python3
"""Transient SSH worker for bounded neck control. No files or ROS publishers.

The browser bridge owns a gateway lease; this worker independently expires its
neck ownership on the Orin, including when the SSH input closes.
"""
import json
import math
import signal
import socket
import sys
import threading
import time
import urllib.request

STEP = math.radians(2)
ENVELOPE = {"yaw": math.radians(10), "pitch": math.radians(5)}
LIMITS = {"yaw": (-0.785, 0.785), "pitch": (-0.401, 0.401)}
TEST_ACTIONS = {"McAction_RL_LOCOMOTION_ARM_EXT_JOINT_SERVO", "McAction_RL_WHOLE_BODY_EXT_JOINT_SERVO", "McAction_PASSIVE_UPPER_BODY_JOINT_SERVO"}
TOLERANCE = math.radians(0.4)
RPCS = {
    "neck": (56322, "McDataService/GetNeckState"),
    "action": (56322, "McActionService/GetAction"),
    "owner": (56444, "MotionCommandService/GetMotionStatus"),
    "disable": (56444, "MotionCommandService/DisableNeckMotionPlayer"),
    "enable": (56444, "MotionCommandService/EnableNeckMotionPlayer"),
    "move": (56322, "McMotionService/SetNeckCommand"),
}


class HeadError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def rpc_call(method, body=None):
    port, route = RPCS[method]
    req = urllib.request.Request(
        "http://192.168.100.100:%d/rpc/aimdk.protocol.%s" % (port, route),
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json", "timeout": "1500"},
    )
    with urllib.request.urlopen(req, timeout=2) as response:
        result = json.load(response)
    # The installed motion_player returns CommonResponse as {state: ...}
    # without a header. If a header is present its code still has to succeed.
    if "header" in result and str(result["header"].get("code")) != "0":
        raise HeadError("rpc_failed", "Luka refused %s" % method)
    if method in ("enable", "disable", "move") and result.get("state") != "CommonState_SUCCESS":
        raise HeadError("rpc_refused", "Luka did not accept %s" % method)
    return result


def claim_neck_lock():
    # Linux abstract sockets act as process-lifetime locks without creating a
    # file. Separate bridge instances cannot own the neck at the same time.
    guard = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        guard.bind("\0steadwell-luka-head-control")
    except OSError:
        guard.close()
        raise HeadError("lease_held", "Another connection already controls Luka's neck")
    return guard


class HeadSession:
    def __init__(self, rpc=rpc_call, now=time.monotonic, sleep=time.sleep, settle_seconds=2.5, wall=time.time, claim=claim_neck_lock):
        self.rpc, self.now, self.sleep = rpc, now, sleep
        self.settle_seconds = settle_seconds
        self.wall = wall
        self.claim = claim
        self.lock = threading.RLock()
        self.session = None
        self.target = None
        self.note = "Factory control"
        self.action_cache = None
        self.action_at = -math.inf

    def _pose(self):
        data = self.rpc("neck").get("data", {})
        pose = {"yaw": data.get("shake", {}).get("position"),
                "pitch": data.get("nod", {}).get("position")}
        for axis, value in pose.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise HeadError("bad_feedback", "No valid measured %s angle" % axis)
        return pose

    def _owner(self):
        value = self.rpc("owner").get("is_neck_enable")
        if not isinstance(value, bool):
            raise HeadError("bad_feedback", "Luka did not report neck ownership")
        return value

    def _action(self, fresh=False):
        if fresh or self.now() - self.action_at >= 5:
            self.action_cache = self.rpc("action").get("info", {}).get("current_action")
            if not isinstance(self.action_cache, str) or not self.action_cache:
                raise HeadError("bad_feedback", "Luka did not report its motion action")
            self.action_at = self.now()
        return self.action_cache

    @staticmethod
    def _hard_limits(pose):
        for axis, bounds in LIMITS.items():
            value = pose.get(axis)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise HeadError("invalid_target", "Both target angles must be finite numbers")
            if not bounds[0] <= value <= bounds[1]:
                raise HeadError("head_limit", "%s target exceeds Luka's documented range" % axis)

    def _restore(self, reason):
        if self.session is None:
            return
        # Keep the session if restoration fails: the watchdog will retry and
        # new movement stays blocked until the handback has been verified.
        if self.session["restoreFactory"]:
            self.rpc("enable")
            if self._owner() is not True:
                raise HeadError("handback_failed", "Factory neck ownership could not be verified")
        self.session["guard"].close()
        self.session = None
        self.target = None
        self.note = reason

    def expire(self):
        with self.lock:
            if self.session and self.now() >= self.session["expires"]:
                self._restore("Controls released after heartbeat timeout")

    def _require(self, lease_id):
        self.expire()
        if not self.session or lease_id != self.session["id"]:
            raise HeadError("lease_required", "Enable head controls before moving Luka")

    def _snapshot(self):
        measured = self._pose()
        return {"connected": True, "measured": measured, "target": self.target,
                "start": self.session["start"] if self.session else None,
                "factoryNeckEnabled": self._owner(), "action": self._action(),
                "sessionActive": self.session is not None, "note": self.note,
                "clockMs": int(self.wall() * 1000)}

    def state(self):
        with self.lock:
            self.expire()
            return self._snapshot()

    def acquire(self, lease_id, ttl_ms):
        with self.lock:
            self.expire()
            if self.session:
                raise HeadError("lease_held", "The neck is already under dashboard control")
            if not isinstance(lease_id, str) or not 12 <= len(lease_id) <= 100:
                raise HeadError("invalid_lease", "Invalid head lease")
            pose, original_owner, action = self._pose(), self._owner(), self._action(fresh=True)
            self._hard_limits(pose)
            if action not in TEST_ACTIONS:
                raise HeadError("action_unready", "Head testing needs an upper-body joint-servo action; current action is " + action)
            guard = self.claim()
            self.session = {"id": lease_id, "start": pose, "action": action, "guard": guard,
                            "restoreFactory": original_owner, "expires": self.now() + 10}
            try:
                if original_owner:
                    self.rpc("disable")
                if self._owner():
                    raise HeadError("handoff_failed", "Factory neck control did not release")
                # Use measured motor angles after handoff, never twin offsets.
                self.session["start"] = self._pose()
                self._hard_limits(self.session["start"])
                self.target = dict(self.session["start"])
                self.note = "Head controls enabled"
                self.heartbeat(lease_id, ttl_ms)
                return self._snapshot()
            except Exception:
                self._restore("Head acquisition failed; factory control restored")
                raise

    def heartbeat(self, lease_id, ttl_ms):
        with self.lock:
            self._require(lease_id)
            if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)) or not 1000 <= ttl_ms <= 10000:
                raise HeadError("invalid_ttl", "Head heartbeat must expire within 10 seconds")
            self.session["expires"] = self.now() + ttl_ms / 1000
            return {"renewed": True}

    def _deadline(self, deadline_ms):
        if (isinstance(deadline_ms, bool) or not isinstance(deadline_ms, (int, float))
                or not math.isfinite(deadline_ms) or not self.wall() * 1000 < deadline_ms <= self.wall() * 1000 + 3500):
            raise HeadError("command_expired", "Head command expired before reaching Luka")

    def move(self, lease_id, target, home=False, deadline_ms=None):
        with self.lock:
            self._require(lease_id)
            self._deadline(deadline_ms)
            pose = self._pose()
            if self._owner() or self._action(fresh=True) != self.session["action"]:
                self._restore("Head controls released because factory state changed")
                raise HeadError("ownership_changed", "Factory neck control or motion action changed; enable again")
            if home:
                target = dict(self.session["start"])
            self._hard_limits(target)
            for axis in LIMITS:
                if abs(target[axis] - self.session["start"][axis]) > ENVELOPE[axis] + 1e-8:
                    raise HeadError("test_limit", "Reached the %s test range; return to start or jog back" % axis)
                if not home and abs(target[axis] - pose[axis]) > STEP + TOLERANCE:
                    raise HeadError("stale_target", "The head moved before this jog; refresh its measured position")
            self._deadline(deadline_ms)
            now = self.wall()
            body = {"header": {"timestamp": {"seconds": int(now), "nanos": int(now % 1 * 1e9),
                                             "ms_since_epoch": int(now * 1000)},
                               "control_source": "ControlSource_SAFE"},
                    "data": {"shake": {"name": "idx27_head_joint1", "position": target["yaw"], "velocity": 0.0, "effort": 0.0},
                             "nod": {"name": "idx28_head_joint2", "position": target["pitch"], "velocity": 0.0, "effort": 0.0}}}
            try:
                self.rpc("move", body)
                self.target = dict(target)
                deadline = self.now() + self.settle_seconds
                while True:
                    measured = self._pose()
                    if all(abs(measured[a] - target[a]) <= TOLERANCE for a in LIMITS):
                        self.note = "Returned to start" if home else "Jog reached its measured target"
                        return self._snapshot()
                    if self.now() >= deadline:
                        raise HeadError("target_not_reached", "Luka accepted the target but measured motion did not reach it")
                    self._require(lease_id)
                    self.sleep(0.1)
            except Exception:
                self._restore("Head test stopped; factory control restored")
                raise

    def release(self, lease_id):
        with self.lock:
            if self.session and self.session["id"] != lease_id:
                raise HeadError("lease_mismatch", "This dashboard does not hold the head lease")
            self._restore("Head controls released")
            return self._snapshot()

    def close(self):
        with self.lock:
            self._restore("Head connection closed; factory control restored")


def main():
    head = HeadSession()
    stopped = threading.Event()

    def shutdown(_signum=None, _frame=None):
        stopped.set()
        try:
            head.close()
        finally:
            raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, shutdown)

    def watchdog():
        while not stopped.wait(0.25):
            try:
                head.expire()
            except Exception as error:
                print("neck handback retry: " + str(error), file=sys.stderr, flush=True)
                stopped.wait(1)

    threading.Thread(target=watchdog, daemon=True).start()
    try:
        for line in sys.stdin:
            packet = {}
            try:
                if len(line) > 16384:
                    raise HeadError("invalid_request", "Head request too large")
                packet = json.loads(line)
                operation, args = packet.get("operation"), packet.get("args", {})
                if operation == "state":
                    result = head.state()
                elif operation == "acquire":
                    result = head.acquire(args.get("leaseId"), args.get("ttlMs"))
                elif operation == "heartbeat":
                    result = head.heartbeat(args.get("leaseId"), args.get("ttlMs"))
                elif operation in ("move", "home"):
                    result = head.move(args.get("leaseId"), args.get("target"), home=operation == "home", deadline_ms=args.get("deadlineMs"))
                elif operation == "release":
                    result = head.release(args.get("leaseId"))
                else:
                    raise HeadError("invalid_operation", "Unknown head operation")
                response = {"id": packet.get("id"), "ok": True, "result": result}
            except Exception as error:
                response = {"id": packet.get("id"), "ok": False,
                            "error": {"code": getattr(error, "code", "head_unavailable"), "message": str(error)}}
            print(json.dumps(response, separators=(",", ":")), flush=True)
    finally:
        stopped.set()
        head.close()


if __name__ == "__main__":
    main()
