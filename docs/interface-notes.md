# Interface notes — Luka A2 Ultra

What we know about the robot's interfaces, where each fact came from, and what is still
unknown. Companion docs: [runbook](runbook.md) · [safety](safety.md) ·
[decisions](decisions.md) · [SDK notes](sdk-notes.md) · [deploy](deploy.md).

Dates are 2026-10. "Verified" means observed against Luka, not read in a document.

---

# 1. Verified interfaces

## 1.1 Motion state — `McActionService/GetAction`

```
POST http://192.168.4.136:56322/rpc/aimdk.protocol.McActionService/GetAction   {}
→ {"header":{"code":"0",…},"info":{"current_action":"McAction_…","ext_action":"","status":"McActionStatus_RUNNING"}}
```

Read-only, unauthenticated, no rate limit enforced by the robot. We poll at 0.2 Hz per the
vendor's guidance. **This reports the motion *mode*, not motion.** Operator-confirmed: a
physical arm gesture produces no change here.

## 1.2 Motion action — `McActionService/SetAction`

```json
{"header":{"timestamp":{"seconds":…,"nanos":…,"ms_since_epoch":…},
           "control_source":"ControlSource_SAFE"},
 "command":{"action":"McAction_USE_EXT_CMD","ext_action":"<ACTION_CODE>"}}
```

Returns `CommonState_SUCCESS` when **accepted**, which is not the same as applied — the call
is documented as asynchronous. Four attempts (§5) returned success and changed nothing while
the controller was off.

## 1.3 Joint telemetry — `McDataService/GetJointState`

```
POST http://192.168.4.136:56322/rpc/aimdk.protocol.McDataService/GetJointState   {}
→ McJointStatesResponse { header, states[] }
```

`states[]` fields: `name`, `sequence`, `position` (rad), `velocity` (rad/s), `effort` (N·m).
**26 joints, `idx01…idx26`** — every leg and arm joint.

Verified live 2026-10-28 08:32: **26/26 names match the cockpit model exactly**, which
independently validates the twin's joint naming against the hardware.

Not reported: the 8 linkage joints and `idx27_head_joint1` / `idx28_head_joint2`.

> Found in the vendor SDK, not by guessing. Nine earlier guesses (`GetMcJointState` on
> `McDataService`, `GetJointState` on `McService`, `HalService/…`) all returned the
> gateway's standard 404. See §6.

## 1.4 Arm command — `/motion/control/arm_joint_command`

ROS 2 topic, `sensor_msgs/msg/JointState`, **14 joints in fixed order** `idx13…idx26`,
radians, `velocity` and `effort` must be `0.0`.

| Constraint | Value |
|---|---|
| Rate | 100 Hz recommended; adjacent ≤ 0.03 s |
| Speed | ≤ 3 rad/s |
| Acceleration | ≤ 6.28 rad/s² |
| Smoothing | first-order low-pass advised by the vendor |
| Feedback | `/motion/control/arm_joint_state` (joints 6/7 position-only, parallel pair) |

Valid only in `PASSIVE_UPPER_BODY_JOINT_SERVO`, `RL_LOCOMOTION_ARM_EXT_JOINT_SERVO`,
`RL_WHOLE_BODY_EXT_JOINT_SERVO`.

**Not reachable from the Mac.** It is a ROS 2 topic on `ROS_DOMAIN_ID=232` behind a Fast DDS
profile; discovery from macOS on domains 0/230/231/232 produced zero datagrams. Publishing
requires a process on the robot.

## 1.5 Other read-only endpoints (verified live)

| Call | Returns |
|---|---|
| `McActionService/GetAvailableActions` | 25 action names the unit supports |
| `McActionService/SetAction` | write — see §1.2 |
| `McDataService/GetJointAngle` | same 26 joints, different shape |
| `McDataService/GetNeckState` | `idx27_head_joint1`, `idx28_head_joint2` |
| `McDataService/GetHandState` | 6 finger positions per hand, 0–2000 |

`GetAvailableActions` matters because it is the robot's own truth: it lists `CURLED_UP` and
`PACKAGE_SIT`, which the public v2.1 table does not. Where the website and the robot disagree,
the robot wins.

**All three are now wired** into the cockpit stream: 26 body joints, 2 neck joints, and 12
finger channels (6 per hand), all read-only.

Finger rendering needs a caveat the other two do not: the vendor URDF has **no finger
geometry and no finger joints** — each hand is a single STL. The cockpit therefore appends
ten **synthetic** finger boxes, positioned from the hand link's bounding box and curled from
the telemetry. They are an approximation and are labelled as such in code; they never feed
anything back to the robot.

## 1.6 Why `SetAction` was accepted and ignored

`common/control_source.proto` documents the field as *"set by the safety module to MC, used by
MC to filter mismatched control-source inputs"*, with `AUTO=0`, `MANUAL=1` (remote-control
module), `SAFE=2`, `DISABLED=255`.

Our requests carried `ControlSource_SAFE`; the active source was presumably `MANUAL` (the
controller). Transport accepted, MC filtered — which is exactly what we observed. **This is
documentation-level evidence, not proof:** the getter (`McService/GetAimMasterControlSource`)
is not exposed on the gateway, tested and 404.

## 1.5b Per-joint limits (vendor guide §7.1.9, radians)

| Joint | Hard limit | Joint | Hard limit |
|---|---|---|---|
| idx13 L arm 1 | −2.91 … 2.91 | idx20 R arm 1 | −2.91 … 2.91 |
| idx14 L arm 2 | −0.46 … 1.60 | idx21 R arm 2 | −1.60 … 0.46 |
| idx15 L arm 3 | −2.91 … 2.91 | idx22 R arm 3 | −2.91 … 2.94 |
| idx16 L arm 4 | −2.00 … −0.03 | idx23 R arm 4 | 0.03 … 2.00 |
| idx17 L arm 5 | −2.94 … 2.94 | idx24 R arm 5 | −2.94 … 2.94 |
| idx18 L arm 6 | −0.45 … 0.45 | idx25 R arm 6 | −0.45 … 0.45 |
| idx19 L arm 7 | −0.35 … 0.35 | idx26 R arm 7 | −0.35 … 0.35 * |

\* printed as "0.35 ~ 0.35" in the guide; treated as mirrored ±0.35. The vendor recommends a
narrower "yellow region" for the coupled wrist: joints 6/7 at **±0.30 / ±0.20**.

The cockpit clamps to `max(model, documented)` ∩ envelope, and reports which layer binds.

---

# 2. The motion state machine, as observed

| Action | Meaning | Legs | Arm control | Seen |
|---|---|---|---|---|
| `McAction_DEFAULT` | controller **standby** | **relaxed — he hangs** | refused | yes |
| `McAction_RL_JOINT_DEFAULT` | reinforced position-control standing | stiff, straight | no | yes — he moved |
| `McAction_RL_LOCOMOTION_DEFAULT` | walking, force control | balance policy live | no | yes |
| `McAction_RL_LOCOMOTION_ARM_EXT_JOINT_SERVO` | walking + upper-limb servo | balance policy live | **yes** | yes — thumbs-up ran |

Two facts matter more than the table:

1. **A mode change moves him.** Operator-confirmed at 08:08:20 (`DEFAULT →
   RL_JOINT_DEFAULT`). Our four `SetAction` attempts did not change the action, and therefore
   did **not** move him.
2. **`McAction_DEFAULT` relaxes the legs.** He hangs from the rig in standby, so lowering the
   hoist does not create a standing robot — it folds him. Stiffen first, lower second.

---

# 3. The controller

| Item | Value |
|---|---|
| Firmware (AimMaster) | `1.3.37.251229` |
| Effect on state | sets the motion action (observed) |
| Arm control in standby | refused |
| Arm control in `RL_LOCOMOTION_ARM_EXT_JOINT_SERVO` | **works** — thumbs-up executed |
| Coupling to `GetAction` | **yes**; an earlier claim of decoupling was wrong (§6) |

Reaching the servo action is possible **through the controller**, which is the supported path
and the one that worked. No `SetAction` is needed for it.

---

# 4. Telemetry bridge (ours)

```
browser ⇄ serve.mjs (proxy, coalescing) ⇄ 192.168.4.136:56322
```

| Endpoint | Upstream | Rate | Notes |
|---|---|---|---|
| `/api/robot/getAction` | `McActionService/GetAction` | 0.2 Hz | last good state cached 15 s |
| `/api/robot/getJointState` | `McDataService/GetJointState` | **5 Hz** | `JOINT_HZ` env; `0` disables |

The allowlist is exactly these two; `SetAction`, `DisableMotionPlayer` and everything else
return `403`. 5 Hz is a deliberate, documented exception to the 0.2 Hz guidance
([D9](decisions.md)). The twin's pose precedence is **measured > playback > operator**, and
the UI names the active source. The stream declares itself stale after 1.2 s without samples
rather than freezing on the last pose.

---

# 5. Field log (chronological, condensed)

**10-27 — link up.** `192.168.4.136`, MAC `ac:45:ef:a4:81:4d`, Ubuntu 22.04. Ports 22/56322
open; 80/443/8080 closed. `GetAction` → `McAction_DEFAULT / RUNNING`. No ethernet adapter on
the Mac, so the documented wired route (`192.168.2.50`) was unavailable.

**10-28 ~00:00 — robot offline**, unexplained, back after a charge.

**07:33 — boot timeline.** ICMP/SSH ~40 s; `56322` ~85 s; `56444` shortly after. Do not probe
before ~100 s — a half-booted robot looks exactly like a dead one.

**07:44–07:50 — four `SetAction` attempts.** All `CommonState_SUCCESS`, none applied,
verified at 10 Hz and 0.5 Hz. Controller was off. Recorded verbatim in git history; not
repeated.

**08:05–08:10 — controller boots.** `DEFAULT → RL_JOINT_DEFAULT` at 08:08:20; operator
confirmed he moved. `GetAction` does track the controller.

**08:14:08 — `RL_JOINT_DEFAULT → DEFAULT`.** Standby; arm control unavailable.

**08:19–08:21 — controller mode chain**, after lowering:
`RL_JOINT_DEFAULT` → `RL_LOCOMOTION_DEFAULT` → **`RL_LOCOMOTION_ARM_EXT_JOINT_SERVO`**.

**~08:25 — factory arm control.** Left-hand thumbs-up from AimMaster while our read-only
polling ran. No interference observed. First controller-preservation evidence.

**08:32 — joint telemetry found** in the vendor SDK; proxy endpoint added; the twin mirrors
26 joints live.

---

# 6. Corrections and superseded conclusions

Kept deliberately. The pattern matters: probing yields *hypotheses about an interface*; only a
document or a working call turns them into facts.

| Claim | Status | Overturned by |
|---|---|---|
| "The action state is decoupled from the controller" | **wrong** | controller boot changed the action at 08:08:20 |
| "SSH is the only remaining path to joint telemetry" | **wrong** | `McDataService/GetJointState` |
| "No joint telemetry is reachable — exhaustive" | **wrong** | same; "exhaustive" was claimed about an API not yet read |
| "The silent no-op may be a v1.3/v2.1 mismatch" | **eliminated** | v1.3 guide contains every action code we used |
| "Lowering him will let his feet take weight" | **wrong** | standby relaxes the legs; he hangs |

## 7. Joint-convention mismatch (found 2026-10-28, operator-reported)

**Symptom:** on first live connection the twin's arms crossed through the torso.

**Cause, measured:** applying the robot's reported angles directly to the model puts both
hands on the *opposite* side of the body. Torso half-width is ~0.19 m; the left hand belongs
at negative z.

| Mapping | Left hand z | Right hand z | Verdict |
|---|---|---|---|
| as reported | **+0.241** | **−0.239** | crossed |
| negate `joint2` (idx14/idx21) | −0.700 | +0.700 | own sides, arms out at shoulder height |
| negate `joint2` + `joint5` | −0.699 | +0.699 | own sides, similar |
| `joint2 ∓ 90°` | −0.457 | +0.461 | own sides, arms lower |

So the model's joint-2 rotation runs opposite to the robot's. Whether the *magnitude* is also
offset (the ∓90° variant) cannot be decided from one pose — it needs a known reference.

**The real cause (2026-10-28, after operator feedback):** the robot's zero is nowhere near
the model's zero. With his arms *hanging*, the robot reports `idx14 = 73.7°`, `idx17 = 93.1°`.
Our model's zero pose — hands at `y=0.87, z=∓0.31` — is what "hanging" looks like. So the gap is
a large **constant offset**, not primarily a sign flip. Applying raw angles put the model at
73°/93°, i.e. arms out at shoulder height: the T-pose the operator saw.

**Reference capture (current mechanism).** With him in a known pose (arms hanging), the
operator presses *capture reference*. The bridge stores `reference[name] = measured[name]` and
renders `model_angle = measured − reference`, so the captured pose maps to the model's zero and
subsequent movement is mirrored **relative** to it.

Verified: before capture the twin's hands sat at `y=1.35, z=∓0.70` (T-pose); after capture,
`y=0.87, z=∓0.31` — the model's neutral, i.e. hanging at his sides.

What this does **not** settle: the *direction* of motion. An offset fixes the static pose; if a
joint's sign is also inverted, the twin will move opposite to him. That is resolved by moving
one arm slowly and watching, then applying the convention selector — not by inference.

**Earlier interim handling, still present:**

- A **joint-convention selector** (`raw`, `flip2`, `flip2_5`, `offset2`), persisted in
  `localStorage`.
- A **plausibility guard**: if the left hand lands at z > −0.05 or the right at z < 0.05, the
  UI says `convention mismatch — arms cross the torso` rather than rendering it silently.
- **First-run auto-detection**: if `raw` crosses, try the alternatives and adopt the first that
  does not, logging *"geometric heuristic from one pose, not a calibration"*.

This is a visualisation workaround. The real fix is Phase D calibration: put him in a known
pose, capture reported angles, and derive per-joint sign and offset. Until then the twin's
arm posture is approximately right at best, and the convention in force is shown in the UI.

## Open questions

1. Does `motion_player` still own the arm topic in servo mode?
2. Who owns the input source while the controller is connected, and what does the supported
   hand-off look like? (`SetMcInputSource` exists in `aimdk_msgs`; effects undocumented here.)
3. What does the controller's Movement screen offer beyond the four actions observed?
4. Are the vendor's arm limits true for this unit? No measurement exists.
5. Does publishing to the arm topic while the controller is active fight it, get ignored, or
   get rejected? **Untested, and not to be tested casually.**
