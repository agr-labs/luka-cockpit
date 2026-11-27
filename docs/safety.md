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
4. **SSH access** — `agi` over **publickey only**; password authentication is disabled on
   the installed image. No key is provisioned on this Mac, so there is no robot-side path:
   no ROS 2 process can be installed, and the arm topic stays out of reach. Read-only checks
   live in `tools/luka-ssh.sh`; nothing on the robot is installed or changed by it.

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
- The hand is a **mounted approximation**: an MIT Inspire RH56DFX model scaled to Luka's
  hand envelope, driven by the six `GetHandState` channels. Its geometry is not Luka's CAD
  and its scale/mount are estimates. Finger telemetry remains display-only and never feeds
  back to the robot. `HAND=0` rebuilds the old synthetic-box fallback.

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

---

# The gateway layer

`gateway/` adds a second authority model above the proxy. It is independent of the arm
schema and of the proxy allowlist, so a mistake in one does not open the other.

| Guard | What it does | Tested? |
|---|---|---|
| Profile locks | refuses `base.velocity` / `legs.posture` on the suspended profile before any adapter is consulted | yes, `profile.test.mjs` |
| Capability gate | a commandable capability requires an adapter that declares `commandable` *and* a verified write path | yes, `physical.test.mjs` |
| Gateway physical flag | `GATEWAY_ALLOW_PHYSICAL=1` is required in addition to the adapter's claim | yes |
| Mode gate | `observe` cannot command; `simulate` can never reach a physical robot | yes |
| Configuration gate | capabilities requiring a floor refuse a suspended robot | yes |
| Lease | exclusive, expiring, epoch-stamped; revoked by the stop | yes, `lease.test.mjs` |
| Validation | schema + documented limits; refuses with the bound, never clamps | yes, `contract.test.mjs` |
| Deadline | absolute expiry per command | yes |
| Rate limit | 60/s sustained, 120 burst per robot | yes |
| **Software stop** | latches, revokes leases, asks the adapter to stop, reports `delivered` | **UI + simulator only** |

## The gateway stop is not an emergency stop

The stop response carries `certified: false` and the adapter's own answer. On the AimDK
adapter that answer is `supported: false, delivered: false`: it is a read-only telemetry
adapter and there is nothing for it to stop. The console displays both facts.

The latch is still useful: it blocks every gateway command, revokes leases, and forces an
explicit, audited `POST /rearm`. What it must never do is imply that it reached the
manufacturer's safety system.

## The suspended profile is policy, not physics

Luka is suspended with his feet clear. The profile records that, and locks locomotion and
leg-posture commands. It does **not**:

- relax the legs;
- claim that upper-body servo makes the legs passive;
- make a grounded robot's feet-contact procedure optional;
- replace the rig, the e-stop, or a human watching the first motion.

Whether `PASSIVE_UPPER_BODY_*` or `RL_*_ARM_EXT_JOINT_SERVO` changes leg behaviour on this
firmware is an open question, and the gateway's configuration fields (`configuration` and
`profile`) exist so that it cannot be silently answered by assumption.

## Compute is not authority

The robot-side sandbox ([sandbox.md](sandbox.md)) protects the robot's software from test code:
no `/agibot`, no devices, no loopback, no privileges, capped and time-limited. It is **not** a
safety layer. It grants no motion authority, and a job that "ran fine in the sandbox" says
nothing about whether a command is safe to send. Motion still requires the lease, capability and
physical-write gates above, and the factory e-stop remains the only certified stop.
