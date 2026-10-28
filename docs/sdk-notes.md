# Vendor SDK notes

The AimDK SDK, what is inside it, and the rules for handling it. Companion:
[interface notes](interface-notes.md) · [decisions](decisions.md).

---

## 1. Provenance and handling rules

| Item | Value |
|---|---|
| Archive | `AimDK-A2-Ultra-V1.3-0130.zip` |
| Bytes | 65 018 698 |
| SHA-256 | `2512076da9b3d1f59e6f74ba6f7640e964a89d8c741f656fa26227c0f566f563` |
| Origin | `https://docs.illeon.de/downloads/aimdk/` — **third-party mirror, not AGIBOT** |
| Root | `agibot_a2_aimdk-dev1.3/`, 797 files |
| Archive comment | git commit `e1f9a8af…` |
| Chosen because | Luka's controller firmware is `1.3.37.251229` — the 1.3 line |

Other builds on the same page: `V1.3-0106`, `V2.0-0212`, `V2.0-0304`, `A2-Lite-V2.0-0310`.

**Rules we follow**

1. Read offline. Nothing from this archive has been executed.
2. Nothing is installed, copied to the robot, or deployed.
3. Text files only were extracted (`*.proto`, `*.py`, `*.sh`, `*.msg`, `*.srv`); binaries were
   not run and the archive's PNGs were not extracted.
4. `password.md` exists in the archive. It has **not** been opened. It is the operator's
   credential, and a mirror is not a trustworthy source for it — the official AGIBOT package
   or support portal is.
5. Treat every executable in the archive as untrusted until matched against an official
   distribution. The interface *documents* are useful even if the *binaries* are suspect.

---

## 2. Layout

```
agibot_a2_aimdk-dev1.3/
├── README.md                     Chinese; points at the official docs site
├── password.md                   NOT opened
├── protocol/
│   ├── protobuf/aimdk/protocol/  260 .proto files, the authoritative API surface
│   └── ros2/                     ros2_plugin_proto msg/srv wrappers
├── examples/
│   ├── mc/                       GetJointState, GetJointAngle, arm, SetAction, actions …
│   ├── motion_player/            disable/enable/get_status .sh
│   ├── pnc/                      action cancel/pause/resume
│   └── agent/, hal/, interaction/ …
└── prebuilt/                     aarch64 + x86_64 protocol libraries (not run)
```

The protos are organised by subsystem: `action`, `agent`, `calibration`, `common`, `digital`,
`em`, `gateway`, `guardian`, `hal`, `hds`, `interaction`, `manipulation`, `mc`, `media`,
`mm`, `motion_player`, `ota`, `perception`, `plc`, `pnc`, `rc`, `resource_manager`, `rtc`,
`setting`, `skill`, `slam`, `sm`, `task_engine`, `tf`, `trace`.

---

## 3. What answered our open questions

### 3.1 Control-source filtering — the likely reason `SetAction` was ignored

`common/control_source.proto`, verbatim comment:

> 控制源，由安全模块向 MC 设置，用于 MC 过滤不匹配的控制源输入
> *"Control source, set by the safety module to MC, used by MC to **filter mismatched
> control-source inputs**."*

```proto
enum ControlSource {
  ControlSource_AUTO     = 0;    // automatic algorithm
  ControlSource_MANUAL   = 1;    // from the remote-control module
  ControlSource_SAFE     = 2;    // from the safety module
  ControlSource_DISABLED = 255;  // MC default
}
```

Our `SetAction` calls carried `ControlSource_SAFE`. If the active source was `MANUAL` (the
controller) the request would be accepted at the transport and **filtered** at MC — exactly
the observed behaviour: `CommonState_SUCCESS`, no transition.

This is documentation, not proof. The getter that would confirm it
(`McService/GetAimMasterControlSource`) is **not exposed** on the gateway — tested and 404.
Priorities for confirmation, in order: read the source through the controller UI, read it via
ROS 2 on the robot, or ask AGIBOT.

### 3.2 The action list is queryable (read-only)

```
POST /rpc/aimdk.protocol.McActionService/GetAvailableActions   {}
```

Returns 25 actions for our unit:

```
CURLED_UP, DEFAULT, MOBILE_PLATFORM_SIT_DOWN, MOBILE_PLATFORM_STAND_UP, PACKAGE_SIT,
PASSIVE_UPPER_BODY_COLLISON_ESCAPE, PASSIVE_UPPER_BODY_JOINT_SERVO,
PASSIVE_UPPER_BODY_ONLINE_PLANNING, PASSIVE_UPPER_BODY_PLANNING_MOVE,
RL_JOINT_DEFAULT, RL_LOCOMOTION_ARM_EXT_COLLISON_ESCAPE,
RL_LOCOMOTION_ARM_EXT_JOINT_SERVO, RL_LOCOMOTION_ARM_EXT_PLANNING_MOVE,
RL_LOCOMOTION_DEFAULT, RL_SIT_DOWN, RL_SIT_DOWN_PASSIVE_POWER_OFF, RL_SIT_DOWN_POWER_OFF,
RL_STAND_UP, RL_STAND_UP_POWER_OFF, RL_STAND_UP_PREP_POWER_OFF, RL_WHOLE_BODY_DANCE,
RL_WHOLE_BODY_EXT_JOINT_SERVO, RL_WHOLE_BODY_EXT_ONLINE_PLANNING, SIT_DOWN, STAND_UP
```

`CURLED_UP` and `PACKAGE_SIT` are not in the v2.1 table — the official docs and the installed
firmware are not identical. Trust the robot's own list over the website.

The response also carries a `commands` array; it was empty on our unit.

### 3.3 Head and hands are readable too

`McDataService` exposes more than joint state — all read-only, all verified live:

| Call | Returns |
|---|---|
| `GetJointState` | 26 joints: `idx01…idx26`, position/velocity/effort |
| `GetJointAngle` | the same joints in a different shape (`joints[]` with `position`) |
| `GetNeckState` | `idx27_head_joint1` (*shake*) and `idx28_head_joint2` (*nod*) |
| `GetHandState` | per hand: 6 finger positions (`thumb_pos_0/1`, `index`, `middle`, `ring`, `pinky`), range 0–2000 |

Sample from our unit while standing:

```
neck:  shake 0.0046 rad   nod −0.0087 rad
hand L: thumb 478/1023  index 1029  middle 1023  ring 1026  pinky 1028
hand R: thumb 446/1030  index 1031  middle 1032  ring 1021  pinky 1024
```

Adding neck + hands to the bridge would complete the visual twin: 26 body joints + 2 head +
12 finger channels.

### 3.4 `motion_player` control, exactly as the vendor does it

```sh
# disable_motion_player.sh
curl -i -H 'content-type:application/json' -H 'timeout: 1000' \
  -X POST http://192.168.100.100:56444/rpc/aimdk.protocol.MotionCommandService/DisableMotionPlayer \
  -d '{}'
```

Companions: `enable_motion_player.sh`, `get_motion_status.sh`, `send_motion_id.sh`, and the
neck equivalents. Note the host — `192.168.100.100`, the internal mc address — not the Wi-Fi
IP we talk to. Port `56444` is reachable on `192.168.4.136`, but we have not called any of
these: they are writes that change factory behaviour.

---

## 4. What the SDK does **not** give us

- Reachability. The arm command topic is still a ROS 2 topic on the robot, behind domain 232
  and a Fast DDS profile. The SDK documents it; it does not transport it to a Mac.
- Authority. Nothing here says we may command the arms while AimMaster is connected.
- Validation of the vendor's limits against this unit.
- Any statement about `motion_player` ownership during servo mode.

## 5. Vendor warning worth keeping

The docs caution that malformed message fields can destabilise motion control — in one
example, fields that do not affect movement still had to be populated correctly to avoid a
motion-controller crash. Publishing to `/motion/control/arm_joint_command` with a half-guessed
message is therefore not a benign experiment. This is why `config/arm-schema.json` stays
`enabled:false` and why the bridge validates every field before it publishes.
