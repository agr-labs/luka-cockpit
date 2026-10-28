# Decisions

Short records of the choices that look cautious from outside and are load-bearing inside.
Format: context → decision → consequence.

---

## D1 — No probing write endpoints, even with empty bodies

**Context.** `SetAction` exists at a known path. An empty body returns a deserialisation
error and moves nothing. That looks harmless enough to use for schema discovery.

**Decision.** No write-endpoint traffic of any kind until we hold official definitions. An
empty-body POST to a motion-mutating service is a write probe, not a read, regardless of
the response.

**Consequence.** We learned less by probing and more by reading documentation. That turned
out to be faster: the vendor guide names every field, limit, and precondition. The one
thing probing did establish — that `SetAction` exists — the documentation states outright.

---

## D2 — `config/arm-schema.json` ships disabled, and stays disabled

**Context.** It would be easy to wire the topic name in and let the panel work.

**Decision.** The schema file is the interlock. `enabled:false` is the default, and
`makeTransport()` returns an `UnconfiguredTransport` that cannot send.

**Consequence.** The cockpit can never accidentally command motion through a config the
human forgot about. Turning it on is a deliberate, reviewable diff.

---

## D3 — "Software stop", never "e-stop"

**Context.** The red button latches authority to `SAFE_HANDOFF` and zeroes commands. It
feels like an emergency stop.

**Decision.** Label it `SOFTWARE STOP` with an explicit caption that it does not reach the
manufacturer's safety system, and make the banner say the same on every latch.

**Consequence.** Nobody can point at the UI and claim a safety function we have not
tested. The factory e-stop remains the only certified stop, and the UI says so.

---

## D4 — Joint limits are the *stricter* of documentation and model

**Context.** The vendor guide's per-joint limits differ from the URDF's, and the wrist pair
has a narrower recommended envelope than either.

**Decision.** Clamp to `max(doc, model)` and then intersect the envelope. Report which
layer is binding.

**Consequence.** Some joints lose a few degrees of range they might physically have. That
is the correct direction to be wrong in, especially for a mechanism whose reachable set is
rhombic rather than rectangular.

---

## D5 — No first command without measured joint state

**Context.** The arm topic takes 14 absolute positions at 100 Hz. If commands stop, the
arms hold.

**Decision.** Do not publish until `/motion/control/arm_joint_state` has been read at least
once. Publishing a "safe" guess would be a jump of unknown size and direction.

**Consequence.** Physical motion now depends on robot-side access (ROS 2 on domain 232, or
SSH). This is the single most important consequence in the project: telemetry is not a
nice-to-have, it is the precondition for the first millimetre of movement.

---

## D6 — The proxy coalesces; it does not rate-limit clients

**Context.** The vendor asks for ≤0.2 Hz continuous polling. The first implementation
enforced that as a global 4 s budget and returned `429` to any second client.

**Decision.** Keep the robot-side budget, but serve the cached response
(`X-A2-Cache: hit`, plus `X-A2-Age-Ms`) to clients inside the window, and serve last-good
state for up to 15 s when the robot times out.

**Consequence.** Two cockpit tabs no longer starve each other, and a brief robot hiccup
does not look like a dead link. The robot still sees ≤0.25 Hz.

---

## D7 — The twin is labelled "estimated" everywhere it matters

**Context.** The FK matches MuJoCo to 3e-7 m, which feels like validation.

**Decision.** MuJoCo agreement is a *simulation* result. The viewport says "estimated
model · FK checked against MuJoCo, not calibrated to Luka"; unactuated joints carry an
`unverified` badge; provenance is a first-class panel in the UI.

**Consequence.** Nobody mistakes kinematic correctness for physical fidelity. The model is
`A2 T2D0`; Luka reports `A2_T3D1_FLAGSHIP`; no Luka measurement exists.

---

## D8 — Read-only discovery tools are published, not run silently

**Context.** `tools/onrobot-probe.sh` would give us the interface inventory quickly.

**Decision.** The script carries an `--explain` manifest, avoids importing vendor modules,
avoids sourcing ROS setup by default, bounds every `find`, and is documented as requiring
review before execution.

**Consequence.** A reviewer can audit it in a minute and know exactly what it will touch.
Trust in the tooling is worth more than the ten seconds a silent version would save.

---

## D9 — The joint stream runs at 5 Hz, as a declared exception

**Context.** The vendor guidance is ≤0.2 Hz for continuous polling. Mirroring a moving humanoid
needs better than one frame per five seconds.

**Decision.** `GetJointState` polls at 5 Hz through the proxy, configurable by `JOINT_HZ`, `0` to
disable. The mode poll stays at 0.2 Hz. The exception is written down here, in the runbook, and
in the interface notes.

**Consequence.** 25× the guidance on one small read-only payload. It is bounded server-side,
it is one env var to stop, and it is *not* used as precedent for write paths.

---

## D10 — The SDK is read, never run, and never installed on the robot

**Context.** The matching SDK came from a third-party mirror. It contains everything we wanted
and also binaries we cannot verify.

**Decision.** Extract text only; execute nothing; install nothing on Luka; leave `password.md`
unopened. Treat the interface documents as useful and the binaries as untrusted.

**Consequence.** We gained 260 protos and the control-source model without taking on supply-chain
risk. The cost is that a few questions (input-source ownership, motion_player state) remain
documented-but-unconfirmed.

---

## D11 — Pose precedence is measured > playback > operator, and the UI names it

**Context.** Three sources can drive the twin, and they can disagree.

**Decision.** Measured telemetry wins whenever it is fresh; recordings next; manual input last.
The viewport states which source is active, and the stream self-declares stale after 1.2 s.

**Consequence.** The twin can never silently show a plausible pose that is actually stale or
invented — the label changes with the source.

---

## D12 — Trust the robot's action list over the docs

**Context.** `GetAvailableActions` returns 25 actions including `CURLED_UP` and `PACKAGE_SIT`,
which the public v2.1 guide does not list.

**Decision.** Where the installed firmware and the website disagree, the robot is authoritative.

**Consequence.** Documentation is a hypothesis generator; the unit is the truth. The same
principle that overturned two of my earlier conclusions.
