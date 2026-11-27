# Joint calibration — matching the twin to Luka

Why the twin's arms did not follow the robot, what the model actually contains, and how the
per-joint mapping works now.

---

## 1. Why a naive mapping cannot work

The public model (`model/urdf/agibot_a2_dof12.urdf`) is a **12-DoF leg model**. Every arm and
head joint in the twin was added by `tools/build-model.mjs` from the vendor's joint frames and
limits (`addedBeyondVendor`), with a Z axis in each frame. The frames are plausible
(roll/pitch/roll/pitch/roll/yaw/roll), but they are not the vendor's arm description.

Three separate mismatches follow:

1. **Different zero.** The model's zero pose has the arms hanging. The robot's factory zero is
   nearer a T-pose: hanging reports roughly `idx14 ≈ 1.24`, `idx17 ≈ 1.65` rad.
2. **Legs are absolute; arms are relative.** Legs come from the vendor URDF, so raw angles are
   correct in the model's own frame. The old reference capture subtracted the pose from *every*
   joint, including the legs — zeroing a stance that should have been absolute.
3. **Direction is per joint.** A single global convention (`raw`, `flip joint 2`, …) cannot
   describe 14 arm joints, and the auto-selected `flip2` was a geometric heuristic, not a
   calibration.

## 2. The model now

For each measured joint:

```
model_angle = clamp( sign × gain × (measured − offset), joint.lower, joint.upper )
```

| Group | Default offset | Why |
|---|---|---|
| Legs `idx01…idx12` | **0** | vendor URDF, absolute angles |
| Arms `idx13…idx26` | captured pose | model zero ≠ robot zero |
| Head `joint1`, `joint2` | captured pose | added joints, different zero |

`sign` starts at **+1** and is flipped per joint when a movement runs backwards. `gain`
starts at **1** and trims travel: a shoulder or elbow that rotates slightly too far gets
`gain = 0.95` (or lower), one that under-travels gets >1. The result is clamped to the model's
own joint limits, not to a guessed envelope.

## 3. The file

`config/joint-calibration.json` is the shared baseline. It is served with the cockpit and loaded
by every client:

```json
{
  "version": 1,
  "robot": "luka",
  "capturedAt": "2026-11-03T15:31:00.000Z",
  "pose": "rope-assisted straight-leg standing, arms hanging",
  "rules": "legs absolute; arms/head relative to capture; sign per joint",
  "joints": {
    "idx01_left_hip_roll": { "offset": 0, "sign": 1 },
    "idx14_left_arm_joint2": { "offset": 1.239315, "sign": 1, "gain": 1 }
  }
}
```

Local edits live in `localStorage['luka.calibration.v1']` and win only when their `savedAt` is
newer than the file's `capturedAt`. **use shared** clears the local copy and reloads the file.

## 4. Operating procedure

1. Open the cockpit (`:8787`) and **connect live**.
2. Put Luka in the pose that should be neutral — arms hanging, still.
3. Press **capture current pose** in *Joint calibration*. Legs are stored absolute; arms and
   head store their offsets.
4. Verify the static pose: hands should hang at his sides, symmetric, and the leg stance should
   be his actual stance, not a straight-legged zero.
5. Move **one joint at a time**. If the twin moves opposite, press `+`/`−` on that row. The
   `0` button sets that joint's offset to its current measured value.
6. When it tracks, press **download** and replace `config/joint-calibration.json` with the file,
   then commit it. Every browser and the deployed twin will use it.

If a joint only overshoots at the extremes of a gesture while tracking in the middle, gain is a
stopgap — the real fix is a per-joint soft limit. Note the joint and the pose; the clamp layer
is the next change.

The old convention selector and reference button are disabled while a calibration is loaded.
They remain only as a fallback when no calibration exists.

## 4b. Model axis corrections (not calibration)

Some added arm joints had the wrong **local axis**, which no offset/sign/gain can fix. These are
corrected in `tools/build-model.mjs`:

| Joint | Was | Now | Evidence |
|---|---|---|---|
| `idx14_left_arm_joint2` | pitch about local Y, limits `[−0.524, 1.658]` | **abduction about local −X**, limits `[−1.658, 0.524]` | `direction_upper left` trace: hand moved 30 cm *behind*; after the change it moves 31 cm up / 33 cm out. The limits must be mirrored with the axis or the model clamps at −0.524 and cannot reach the robot's pose. |
| `idx21_right_arm_joint2` | correct abduction axis, mirrored limits `[−1.658, 0.524]` | limits swapped to `[−0.524, 1.658]` | right lift clamped at +0.524 before reaching the robot pose |
| `idx20_right_arm_joint1` | arm roll (axis along the forearm) | **abduction about local Z** | captured right-arm pose: +1.41 rad, and this axis raises the elbow above the shoulder |
| `idx24_right_arm_joint5` | forearm roll | **roll** (override removed) | the hinge change came from the bad-offset pass; with the corrected neutral it twisted the forearm. Restored. |

The right arm exposed a different failure: its **offsets had been captured in the wrong pose**.
At rest the right arm read `idx20 −0.97`, `idx23 −0.96`, `idx24 −0.87` from its neutral, so every
gesture was mapped from a false zero. Recapturing the right offsets at the hanging pose fixed the
neutral, and then the real lift joint became clear: `idx20_right_arm_joint1` (+1.41 rad) is the
shoulder abduction, not an arm roll. Its axis is now local **Z**. With those two corrections the
captured `direction_upper right` pose puts the elbow 17 cm above the shoulder and the hand out
and up. `idx21` limits stay swapped to `[−0.524, 1.658]`. The right elbow’s **range** is mirrored (`[0, 2.094]`) but its hinge axis is the same local
**+Y** as the left. The `−Y` experiment bent the forearm backwards; with `+Y` and sign `+1`
the elbow folds forward and the delta stays inside the positive range. The shared file carries a `correctedAt` stamp so a local
calibration saved before these right-arm corrections yields to the shared baseline.

## 5. What is verified, and what is not

Verified (2026-11-03):

- Fresh capture at the hanging pose yields **hands symmetric** at `y ≈ 0.87`, `z = ∓0.31`.
- Leg joints apply **absolute** values: `pose == measured` (e.g. `idx03 −0.133`).
- Arm joints apply offsets: `idx14 pose 0` at the captured pose.
- Local calibration survives reload; **use shared** restores the baseline.
- The model still renders 306k tris; nothing else in the twin changed.

Not verified:

- **Signs are +1 everywhere in the committed baseline.** A direction pass needs one human
  observation per joint that moves the wrong way. Until then, the mapping is exact in offset and
  approximate in direction for any joint whose encoder runs opposite to the model frame.
- **Wrist joints 6/7** are parallel mechanisms. The robot reports *equivalent serial* angles;
  the model's joints 6/7 are promoted frames, so wrist orientation is the weakest part.
- **Leg linkage joints** (`idx05_01`, `idx06_01`, …) are not reported and stay at zero; the
  primary leg joints carry the pose.
- **Fingers are now an articulated hand**, not synthetic boxes: the MIT Inspire RH56DFX model
  is mounted at each wrist (scale 1.32) and driven by the six `GetHandState` channels
  (0 open → 2000 closed), with the URDF mimic couplings for the distal joints. It is an
  approximation: Luka's welded hand measures 163 × 210 × 55 mm, the RH56 82 × 159 × 101 mm.
  Rebuild with `HAND=0 node tools/build-model.mjs` to fall back to the old synthetic boxes.
  The calibration panel still shows all six raw channels per hand.

## 6. Why not replace the model?

The correct fix would be the vendor's full-arm URDF/Xacro. It is not in the public model
(12 DoF), not in the AimDK archive, and not reachable on the robot without SSH. The calibration
layer is the precise fix that is possible with the interfaces we hold: offsets remove the zero
error, per-joint signs remove the direction error, and legs stay on the vendor's authoritative
kinematics.

If a full-arm description appears later, replace `tools/build-model.mjs`'s added joints with it
and re-capture; the calibration file format does not change.
