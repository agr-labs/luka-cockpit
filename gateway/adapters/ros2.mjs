// ROS 2 adapter — present, declared, and deliberately incapable.
//
// The arm command topic is documented (`/motion/control/arm_joint_command`,
// sensor_msgs/JointState, 14 joints, 100 Hz, domain 232 behind a Fast DDS
// profile). What does not exist is a process on the robot that publishes it, or
// any measured joint feedback on that path that we have read ourselves.
//
// So this adapter reports the interface as unavailable, with the reason. It is
// better to have a visible "blocked" adapter than a hidden TODO: applications
// can see the difference between "the robot is off" and "the bridge was never
// installed".

export const ADAPTER = 'ros2';
export const KIND = 'physical';

const REASON = 'requires a ROS 2 process on the robot (domain 232, Fast DDS profile); nothing is installed on Luka';

export function create({ config } = {}) {
  const id = config.id;
  return {
    id,
    kind: KIND,
    adapterName: ADAPTER,
    configuration: config.configuration ?? 'suspended',
    physical: true,
    started: false,
    start() { this.started = true; },
    stop() { this.started = false; },
    status() {
      return { online: false, health: 'unknown', detail: REASON };
    },
    state() {
      return {
        robotId: id,
        timestamp: new Date(config.now?.() ?? Date.now()).toISOString(),
        source: 'none',
        online: false,
        health: 'unknown',
        action: null,
        actionLabel: null,
        controllerOwner: null,
        configuration: config.configuration ?? 'suspended',
        posture: null,
        base: null,
        speech: null,
        listening: false,
        lastCommand: null,
        link: { detail: REASON },
        cameras: [],
      };
    },
    joints() {
      return { robotId: id, timestamp: new Date().toISOString(), source: 'none', joints: {}, neck: {}, hands: { left: {}, right: {} } };
    },
    snapshot() {
      return { state: this.state(), joints: this.joints() };
    },
    capabilities() {
      const out = {};
      for (const cap of [
        'head.gaze', 'head.joints', 'arms.joints', 'arms.cartesian', 'hands.grasp',
        'legs.posture', 'base.velocity', 'voice.speak', 'voice.listen', 'camera.stream',
        'motion.state',
      ]) {
        out[cap] = { observable: false, commandable: false, writeVerified: false, reason: REASON };
      }
      return out;
    },
    cameras: () => [],
    execute(capability) {
      return { accepted: false, applied: false, code: 'unsupported', note: `${REASON} (${capability})` };
    },
    stopHardware() {
      return { supported: false, delivered: false, note: 'no ROS 2 process on the robot to ask' };
    },
  };
}
