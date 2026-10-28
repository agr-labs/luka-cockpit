# Safety model

What each guard does, what it has actually been tested against, and what it has not.

## The three authorities

```
browser            operator intent, deadman, UI authorisation
  ↓ request only
gateway (serve.mjs) control lease, freshness, joint validation, command expiry
  ↓ read-only today
manufacturer        McActionService, motion_player, actuator safety, factory handoff
```

The browser is **not** a safety mechanism. The spacebar deadman and the software stop are
conveniences that reduce the chance of a bad command leaving the page. The manufacturer's
system remains authoritative, and the factory e-stop is the only certified stop.

## Guards, and their honest status

| Guard | What it does | Tested? |
|---|---|---|
| Deadman (space / button) | must be held for `COMPUTER`; release drops authority and zeroes | yes, in-browser |
| Command watchdog | 250 ms without a streamed setpoint ⇒ zero velocity + banner | yes |
| Telemetry freshness | 7 s window (one 5 s poll cycle + margin) ⇒ drop to `MANUAL` | yes |
| Velocity clamps | vx ±0.35, vy ±0.25, wz ±0.60 | yes |
| Joint limit clamping | intersection of vendor doc limits, URDF limits, wrist envelope | unit-tested |
| Slew limiting | 8 °/s, ≤5° per jog | unit-tested |
| Action gate | refuses when the reported action does not permit arm commands | yes, live |
| Transport interlock | `config/arm-schema.json` `enabled:false` ⇒ nothing can send | yes, live |
| **Software stop** | latches `SAFE_HANDOFF`, zeroes commands, logs | **UI only** |

### The software stop is not an emergency stop

It is labelled `SOFTWARE STOP` with a red caption, and the banner says *"unverified stop;
use the factory e-stop"*, for one reason: **nothing has tested whether it reaches the
manufacturer's safety system.** Right now it changes local state and stops publishing.
Whether that is enough to stop a moving arm is unknown, and will stay unknown until the
robot-side path exists and someone tests it deliberately.

## The four gates before any motion

1. **Action gate** — Luka must be in a servo action, not `McAction_DEFAULT`.
   Unauthorised: nobody has approved the `SetAction` write.
2. **motion_player** — takes over the arm topic in JOINT_SERVO mode.
   Unresolved: the disable route is known but unverified on v2.1.
3. **Joint feedback** — no HTTP route to arm angles. Unresolved: needs ROS 2 access.
   This is the one that makes a first command unsafe regardless of the other three,
   because the topic takes absolute positions.
4. **SSH credentials** — `agi` + the password in `password.md` from the AimDK package.

## What live mirroring does and does not mean

The cockpit now renders **measured** joint angles at 5 Hz. That is an observation channel and
nothing more:

- It grants no authority. The proxy still allowlists two read-only RPCs; every write returns
  `403`.
- "Measured" and "commanded" stay separate: the arm panel's `current` is the last value *we*
  sent, the telemetry is what the *robot* reports, and they are displayed apart.
- If the stream stops, the UI stops calling it live (1.2 s) rather than freezing on the last
  pose. A frozen pose that still says LIVE would be worse than no pose at all.
- Seeing the arms move in the twin is not evidence that anything we did caused it. Right now
  the controller is the only thing moving him.

## Joint limits are three layers deep

```
documented hard limit          vendor guide §7.1.9 (authoritative)
  ∩ URDF/model limit           the twin's own kinematic table
  ∩ recommended envelope       wrists 6/7: ±0.3 and ±0.2 rad (parallel mechanism)
```

`src/armcontrol.js` applies all three and reports which one is binding. The wrist envelope
exists because the parallel mechanism's reachable set is rhombic, not rectangular: a joint
pair that is legal individually can be unreachable together.

Open: the vendor's `idx26` limit is printed as `0.35 ~ 0.35`, almost certainly a typo for
`±0.35`. We treat it as mirrored `±0.35` and flag it rather than silently guessing.

## What has *not* been verified

- Controller coexistence: whether AimMaster and AimDK can hold authority simultaneously.
- Whether releasing the deadman mid-motion stops the arms, or just stops new setpoints.
- What `McAction_DEFAULT` does to arm stiffness (hold? sag?).
- Whether any of the 16 arm/head joints exist on Luka with the vendor's limits.
- The manufacturer's supported response to link loss and command cancellation.

The controller-preservation test table in the [README](../README.md) is still empty for
exactly these reasons.
