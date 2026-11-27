"""Neck ownership and motion guard tests using a simulated RPC peer."""
import importlib.util
import math
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("head_worker", Path(__file__).with_name("luka-head-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
TOKEN = "lease_test_neck_123456"


class Clock:
    def __init__(self):
        self.t = 100.0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class Rpc:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.pose = {"yaw": 0.12, "pitch": -0.06}
        self.calls = []
        self.follows = True
        self.fail_enable = False

    def __call__(self, method, body=None):
        self.calls.append((method, body))
        if method == "neck":
            return {"data": {"shake": {"position": self.pose["yaw"]}, "nod": {"position": self.pose["pitch"]}}}
        if method == "owner":
            return {"is_neck_enable": self.enabled}
        if method == "action":
            return {"info": {"current_action": "McAction_RL_LOCOMOTION_ARM_EXT_JOINT_SERVO"}}
        if method == "disable":
            self.enabled = False
        if method == "enable":
            if self.fail_enable:
                raise worker.HeadError("handback_failed", "test handback failure")
            self.enabled = True
        if method == "move" and self.follows:
            self.pose = {"yaw": body["data"]["shake"]["position"], "pitch": body["data"]["nod"]["position"]}
        return {"state": "CommonState_SUCCESS"}

    def count(self, method):
        return sum(name == method for name, _ in self.calls)


class HeadTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.rpc = Clock(), Rpc()
        self.guard = Mock()
        self.head = worker.HeadSession(rpc=self.rpc, now=self.clock.now, sleep=self.clock.sleep, wall=self.clock.now, claim=lambda: self.guard)

    def acquire(self):
        return self.head.acquire(TOKEN, 10000)

    def move(self, target, **kwargs):
        return self.head.move(TOKEN, target, deadline_ms=self.clock.now() * 1000 + 2000, **kwargs)

    def test_state_only_reads(self):
        self.head.state()
        self.assertTrue(all(name in ("neck", "owner", "action") for name, _ in self.rpc.calls))

    def test_installed_motion_player_headerless_success_is_accepted(self):
        for method in ("enable", "disable"):
            with patch.object(worker.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"state":"CommonState_SUCCESS"}')) as urlopen:
                self.assertEqual(worker.rpc_call(method)["state"], "CommonState_SUCCESS")
                self.assertIn(worker.RPCS[method][1], urlopen.call_args.args[0].full_url)

    def test_rpc_failure_codes_and_refused_state_are_not_accepted(self):
        for body in [{"header": {"code": "5"}, "state": "CommonState_SUCCESS"},
                     {"state": "CommonState_UNKNOWN"}]:
            with patch.object(worker.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(body).encode())):
                with self.assertRaises(worker.HeadError):
                    worker.rpc_call("disable")

    def test_acquire_and_release_only_change_neck_owner(self):
        state = self.acquire()
        self.assertFalse(state["factoryNeckEnabled"])
        self.assertEqual(state["start"], {"yaw": 0.12, "pitch": -0.06})
        self.head.release(TOKEN)
        self.assertTrue(self.rpc.enabled)
        self.assertEqual(self.rpc.count("disable"), 1)
        self.assertEqual(self.rpc.count("enable"), 1)
        self.assertEqual(self.rpc.count("move"), 0)
        self.guard.close.assert_called_once()

    def test_originally_unowned_neck_is_not_enabled_on_release(self):
        self.rpc.enabled = False
        self.acquire()
        self.head.release(TOKEN)
        self.assertFalse(self.rpc.enabled)
        self.assertEqual(self.rpc.count("enable"), 0)
        self.assertEqual(self.rpc.count("disable"), 0)

    def test_jog_preserves_other_axis_and_home_uses_raw_start(self):
        self.acquire()
        self.move({"yaw": 0.12 + worker.STEP, "pitch": -0.06})
        data = next(body["data"] for name, body in self.rpc.calls if name == "move")
        self.assertEqual(data["nod"]["position"], -0.06)
        self.assertEqual(data["shake"]["name"], "idx27_head_joint1")
        self.assertEqual(data["nod"]["velocity"], 0.0)
        self.assertEqual(data["shake"]["effort"], 0.0)
        self.move(None, home=True)
        self.assertEqual(self.rpc.pose, {"yaw": 0.12, "pitch": -0.06})

    def test_rogue_lease_cannot_move_or_release(self):
        self.acquire()
        for call in [lambda: self.head.move("foreign_lease", self.rpc.pose, deadline_ms=102000),
                     lambda: self.head.release("foreign_lease")]:
            with self.assertRaises(worker.HeadError):
                call()
        self.assertFalse(self.rpc.enabled)
        self.assertEqual(self.rpc.count("move"), 0)

    def test_relative_range_and_large_steps_refuse_before_move(self):
        self.acquire()
        for target in [{"yaw": .12 + math.radians(12), "pitch": -.06},
                       {"yaw": .12, "pitch": -.06 + math.radians(6)},
                       {"yaw": .12 + math.radians(4), "pitch": -.06}]:
            with self.assertRaises(worker.HeadError):
                self.move(target)
        self.assertEqual(self.rpc.count("move"), 0)

    def test_vendor_limit_still_binds_inside_relative_range(self):
        self.rpc.pose["yaw"] = .78
        self.acquire()
        with self.assertRaises(worker.HeadError) as caught:
            self.move({"yaw": .78 + worker.STEP, "pitch": -.06})
        self.assertEqual(caught.exception.code, "head_limit")
        self.assertEqual(self.rpc.count("move"), 0)

    def test_late_wire_command_is_refused(self):
        self.acquire()
        with self.assertRaises(worker.HeadError) as caught:
            self.head.move(TOKEN, {"yaw": .12 + worker.STEP, "pitch": -.06}, deadline_ms=99000)
        self.assertEqual(caught.exception.code, "command_expired")
        self.assertEqual(self.rpc.count("move"), 0)

    def test_expiry_and_eof_restore_the_factory_owner(self):
        self.acquire()
        self.clock.sleep(11)
        self.head.expire()
        self.assertTrue(self.rpc.enabled)
        self.assertIsNone(self.head.session)
        self.acquire()
        self.head.close()
        self.assertTrue(self.rpc.enabled)

    def test_failed_restore_keeps_recovery_state_for_watchdog_retry(self):
        self.acquire()
        self.clock.sleep(11)
        self.rpc.fail_enable = True
        with self.assertRaises(worker.HeadError):
            self.head.expire()
        self.assertIsNotNone(self.head.session)
        self.guard.close.assert_not_called()
        self.rpc.fail_enable = False
        self.head.expire()
        self.assertIsNone(self.head.session)
        self.assertTrue(self.rpc.enabled)
        self.guard.close.assert_called_once()

    def test_a_second_worker_cannot_take_ownership(self):
        def already_owned():
            raise worker.HeadError("lease_held", "another process")
        self.head.claim = already_owned
        with self.assertRaises(worker.HeadError) as caught:
            self.acquire()
        self.assertEqual(caught.exception.code, "lease_held")
        self.assertEqual(self.rpc.count("disable"), 0)
        self.assertEqual(self.rpc.count("move"), 0)

    def test_accepted_but_unmeasured_motion_releases_ownership(self):
        self.acquire()
        self.rpc.follows = False
        with self.assertRaises(worker.HeadError) as caught:
            self.move({"yaw": .12 + worker.STEP, "pitch": -.06})
        self.assertEqual(caught.exception.code, "target_not_reached")
        self.assertTrue(self.rpc.enabled)
        self.assertIsNone(self.head.session)

    def test_changed_factory_owner_prevents_a_command(self):
        self.acquire()
        self.rpc.enabled = True
        with self.assertRaises(worker.HeadError) as caught:
            self.move({"yaw": .12 + worker.STEP, "pitch": -.06})
        self.assertEqual(caught.exception.code, "ownership_changed")
        self.assertEqual(self.rpc.count("move"), 0)


if __name__ == "__main__":
    unittest.main()
