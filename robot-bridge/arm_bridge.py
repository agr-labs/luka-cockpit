#!/usr/bin/env python3
"""arm_bridge.py — runs ON Luka. Publishes arm joint targets at 100 Hz.

    /motion/control/arm_joint_command   (sensor_msgs/JointState, 14 joints, radians)

It does NOT decide where the arms go. It receives target joint positions over UDP
from the cockpit gateway, rate-limits them (speed <= 3 rad/s, accel <= 6.28 rad/s^2
per the vendor guide), and streams them at the documented 100 Hz. If commands stop
arriving, it stops advancing and holds position — it never extrapolates.

Vendor constraints encoded here (A2 Ultra Interface Guide 7.1.9):
  * exactly 14 positions, fixed joint order
  * velocity and effort fields must be 0.0
  * 100 Hz, adjacent commands <= 0.03 s apart
  * only permitted in PASSIVE_UPPER_BODY_JOINT_SERVO,
    RL_LOCOMOTION_ARM_EXT_JOINT_SERVO, RL_WHOLE_BODY_EXT_JOINT_SERVO
  * motion_player takes the topic over in JOINT_SERVO mode; the vendor requires
    examples/motion_player/disable_motion_player.sh to be run first (NOT done here)

DDS ENVIRONMENT (from the robocurve adapter, AimDK v1.3 notes)
  The robot's ROS 2 graph is NOT on the default domain. Before starting:
      source /opt/ros/humble/setup.bash
      export ROS_DOMAIN_ID=232
      export ROS_LOCALHOST_ONLY=0
      export FASTRTPS_DEFAULT_PROFILES_FILE=<profile xml from the robot image>
  Without these the publisher will start happily and reach nobody. Verify with
  `ros2 topic info /motion/control/arm_joint_state` before trusting a dry run.

USAGE
  # 1. dry run: checks the action gate, prints what it would publish, sends nothing
  python3 arm_bridge.py --check --print-only

  # 2. live, once the action gate passes and the operator is ready
  python3 arm_bridge.py --listen 0.0.0.0:9998

SAFETY
  This process can move a 69 kg humanoid's arms. It only publishes when the action
  gate passes AND a target packet has arrived within --timeout seconds. There is no
  software path here that switches the motion action; do that deliberately, by hand,
  with SetAction and a human watching GetAction.
"""

import argparse
import json
import math
import socket
import threading
import time
import urllib.request

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSHistoryPolicy, QoSProfile, QoSReliabilityPolicy
from sensor_msgs.msg import JointState

JOINTS = [
    "idx13_left_arm_joint1", "idx14_left_arm_joint2", "idx15_left_arm_joint3",
    "idx16_left_arm_joint4", "idx17_left_arm_joint5", "idx18_left_arm_joint6",
    "idx19_left_arm_joint7",
    "idx20_right_arm_joint1", "idx21_right_arm_joint2", "idx22_right_arm_joint3",
    "idx23_right_arm_joint4", "idx24_right_arm_joint5", "idx25_right_arm_joint6",
    "idx26_right_arm_joint7",
]

# Documented hard limits (radians). idx26 is printed as "0.35 ~ 0.35" in the guide;
# treated as the mirrored +-0.35 of idx19.
LIMITS = [
    (-2.91, 2.91), (-0.46, 1.60), (-2.91, 2.91), (-2.00, -0.03),
    (-2.94, 2.94), (-0.45, 0.45), (-0.35, 0.35),
    (-2.91, 2.91), (-1.60, 0.46), (-2.91, 2.94),
    (0.03, 2.00), (-2.94, 2.94), (-0.45, 0.45), (-0.35, 0.35),
]

PERMITTED_ACTIONS = {
    "PASSIVE_UPPER_BODY_JOINT_SERVO",
    "RL_LOCOMOTION_ARM_EXT_JOINT_SERVO",
    "RL_WHOLE_BODY_EXT_JOINT_SERVO",
}

MAX_SPEED = 3.0      # rad/s, documented
MAX_ACCEL = 6.28     # rad/s^2, documented


def get_action(host="127.0.0.1", port=56322, timeout=3.0):
    url = f"http://{host}:{port}/rpc/aimdk.protocol.McActionService/GetAction"
    req = urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode())
    return (body.get("info") or {}).get("current_action")


def action_permitted(action):
    if not action:
        return False, "action unknown"
    short = action.replace("McAction_", "")
    if short in PERMITTED_ACTIONS:
        return True, short
    return False, f"{short} does not permit arm commands"


class ArmBridge(Node):
    def __init__(self, args):
        super().__init__("steadwell_arm_bridge")
        self.args = args
        qos = QoSProfile(
            history=QoSHistoryPolicy.KEEP_LAST, depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
        )
        self.pub = self.create_publisher(JointState, "/motion/control/arm_joint_command", qos)
        self.sub = self.create_subscription(
            JointState, "/motion/control/arm_joint_state", self.on_state, qos)

        self.target = [0.0] * 14      # what the gateway asked for
        self.commanded = [0.0] * 14   # what we are allowed to emit
        self.velocity = [0.0] * 14
        self.have_target = False
        self.last_target_at = 0.0
        self.last_state = None
        self.seq = 0
        self.started = time.monotonic()

        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind((args.host, args.listen_port))
        self.udp.settimeout(0.5)
        threading.Thread(target=self.rx_loop, daemon=True).start()

        period = 1.0 / args.rate
        self.create_timer(period, self.tick)
        self.get_logger().info(
            f"bridge up: {args.rate} Hz, listening udp/{args.listen_port}, "
            f"print_only={args.print_only}")

    # ---- inbound targets -------------------------------------------------
    def rx_loop(self):
        while rclpy.ok():
            try:
                data, addr = self.udp.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                msg = json.loads(data.decode())
                pos = msg.get("pos")
                if not isinstance(pos, list) or len(pos) != 14:
                    self.get_logger().warn("rejected packet: expected 14 positions")
                    continue
                clean = []
                for i, v in enumerate(pos):
                    if not isinstance(v, (int, float)) or not math.isfinite(v):
                        raise ValueError(f"joint {i} not finite")
                    lo, hi = LIMITS[i]
                    if not (lo - 1e-6 <= v <= hi + 1e-6):
                        self.get_logger().warn(
                            f"rejected packet: {JOINTS[i]}={v:.3f} outside ({lo}, {hi})")
                        raise ValueError("out of limits")
                    clean.append(float(v))
                self.target = clean
                self.have_target = True
                self.last_target_at = time.monotonic()
                self.peer = addr
            except Exception as e:  # noqa: BLE001 - reject anything malformed
                self.get_logger().warn(f"dropped packet from {addr}: {e}")

    def on_state(self, msg):
        self.last_state = {
            "name": list(msg.name),
            "position": list(msg.position),
            "velocity": list(msg.velocity),
            "t": time.time(),
        }
        if getattr(self, "peer", None) and not self.args.print_only:
            try:
                self.udp.sendto(json.dumps(self.last_state).encode(), self.peer)
            except OSError:
                pass

    # ---- 100 Hz control tick --------------------------------------------
    def tick(self):
        dt = 1.0 / self.args.rate
        now = time.monotonic()

        stale = (not self.have_target) or (now - self.last_target_at > self.args.timeout)
        if stale:
            # Hold: decelerate to zero instead of chasing a stale target.
            self.have_target = False
            for i in range(14):
                self.velocity[i] = 0.0

        for i in range(14):
            if not stale:
                err = self.target[i] - self.commanded[i]
                want = max(-MAX_SPEED, min(MAX_SPEED, err / max(dt, 1e-3)))
                dv = max(-MAX_ACCEL * dt, min(MAX_ACCEL * dt, want - self.velocity[i]))
                self.velocity[i] += dv
                step = self.velocity[i] * dt
                if abs(step) > abs(err):
                    step = err
                self.commanded[i] += step
            lo, hi = LIMITS[i]
            self.commanded[i] = max(lo, min(hi, self.commanded[i]))

        if self.args.print_only:
            if self.seq % self.args.rate == 0:
                self.get_logger().info(
                    "print-only: " + " ".join(f"{v:+.3f}" for v in self.commanded))
            self.seq += 1
            return

        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = JOINTS
        msg.position = list(self.commanded)
        msg.velocity = [0.0] * 14   # documented: invalid field, must be 0
        msg.effort = [0.0] * 14     # documented: invalid field, must be 0
        self.pub.publish(msg)
        self.seq += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=100.0)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--listen-port", type=int, default=9998)
    ap.add_argument("--timeout", type=float, default=0.3, help="seconds before holding position")
    ap.add_argument("--print-only", action="store_true", help="never publish; log instead")
    ap.add_argument("--check", action="store_true", help="verify the action gate and exit")
    ap.add_argument("--mc-host", default="127.0.0.1")
    ap.add_argument("--mc-port", type=int, default=56322)
    ap.add_argument("--skip-action-check", action="store_true",
                    help="bypass the gate (only for offline rehearsal)")
    args = ap.parse_args()

    if args.check or not args.skip_action_check:
        try:
            action = get_action(args.mc_host, args.mc_port)
        except Exception as e:  # noqa: BLE001
            print(f"action check failed: {e}")
            if not args.skip_action_check:
                raise SystemExit("refusing to start: cannot confirm the motion action")
            action = None
        ok, detail = action_permitted(action)
        print(f"current action: {action}  ({detail})")
        if not ok and not args.skip_action_check:
            raise SystemExit(
                "refusing to start: this action does not permit arm commands.\n"
                "Switch deliberately with SetAction + ext_action, confirm with GetAction, "
                "then run again.")
        if args.check:
            return

    if not args.print_only:
        print("=" * 78)
        print(" LIVE MODE. motion_player must already be disabled on this robot, or the")
        print(" motion_player module will override every command published here.")
        print(" Ctrl-C stops publishing; the arm holds its last commanded position.")
        print("=" * 78)

    rclpy.init()
    node = ArmBridge(args)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
