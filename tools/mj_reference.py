"""Dump MuJoCo reference body positions for FK verification."""
import json, sys
import mujoco
import numpy as np

XML = sys.argv[1] if len(sys.argv) > 1 else '/tmp/luka-model/build/luka_as_is.xml'
m = mujoco.MjModel.from_xml_path(XML)
d = mujoco.MjData(m)

def dump(path, joint_values):
    d.qpos[:] = 0.0
    for name, q in joint_values.items():
        jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, name)
        if jid < 0:
            raise SystemExit(f'unknown joint {name}')
        d.qpos[m.jnt_qposadr[jid]] = q
    mujoco.mj_forward(m, d)
    bodies = {}
    for i in range(m.nbody):
        name = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, i)
        if name:
            bodies[name] = [float(x) for x in d.xpos[i]]
    json.dump({'joints': joint_values, 'bodies': bodies}, open(path, 'w'), indent=1)
    print(path, len(bodies), 'bodies')

dump('/tmp/mj_pose_zero.json', {})
# A pose that exercises every joint type with non-degenerate angles.
dump('/tmp/mj_pose_perturbed.json', {
    'idx01_left_hip_roll': 0.21, 'idx02_left_hip_yaw': -0.15, 'idx03_left_hip_pitch': 0.42,
    'idx04_left_tarsus': 0.63, 'idx05_left_toe_pitch': -0.28, 'idx06_left_toe_roll': 0.11,
    'idx07_right_hip_roll': -0.19, 'idx08_right_hip_yaw': 0.12, 'idx09_right_hip_pitch': -0.25,
    'idx10_right_tarsus': 0.35, 'idx11_right_toe_pitch': -0.16, 'idx12_right_toe_roll': -0.09,
    'idx13_left_arm_joint1': 0.30, 'idx14_left_arm_joint2': 0.85, 'idx15_left_arm_joint3': -0.40,
    'idx16_left_arm_joint4': -0.55, 'idx17_left_arm_joint5': 0.20,
    'idx20_right_arm_joint1': -0.25, 'idx21_right_arm_joint2': -0.60, 'idx22_right_arm_joint3': 0.35,
    'idx23_right_arm_joint4': 0.45, 'idx24_right_arm_joint5': -0.18,
    'idx27_head_joint1': 0.22, 'idx28_head_joint2': -0.11,
})
