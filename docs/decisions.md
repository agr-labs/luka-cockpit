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

---

## D13 — One application contract, adapters installed independently

**Context.** Every application that wants Luka would otherwise learn AimDK protobufs, ROS 2
topics, DDS domains, or a third-party bridge. That knowledge would fork per app and rot per
firmware version.

**Decision.** One HTTP/WebSocket contract (`/api/v1`) with capability negotiation, and
adapters as separate modules: `simulator`, `aimdk`, `ros2`. The gateway never speaks a vendor
protocol; an adapter never makes an authority decision.

**Consequence.** The simulator and the real robot appear in the same API with different
authority, which is exactly the distinction applications need. Adding Nori or ToddlerBot
means writing an adapter, not a new app contract.

---

## D14 — A capability is not a command: three gates for every physical write

**Context.** An adapter could plausibly claim it can command arms because the message format
is documented. The format being known is not the same as the path being verified.

**Decision.** A physical capability reaches hardware only when (1) the gateway was started
with `GATEWAY_ALLOW_PHYSICAL=1`, (2) the adapter declares `writeVerified` for that specific
capability, and (3) the lease is `manual` or `assisted`. `assisted` additionally requires a
`supervision` claim. No adapter makes either claim today.

**Consequence.** Enabling one joint on Luka requires an adapter change, a config change, and a
human decision — three reviewable diffs, not an env var. Every refusal names which gate
closed.

---

## D15 — The suspended profile locks locomotion in software

**Context.** Luka is fully suspended, feet clear, full weight on a rated rig. A third-party
procedure describes feet-contact balancing; an earlier suspended configuration had no contact
at all. Whether upper-body servo relaxes the legs is unknown, and "probably not" is not a
safety case.

**Decision.** Encode the rig state as a profile: `suspension`, `feet`, `rig`, `locomotion`,
`armControl`, `motionSchema`, and explicit `locks` for `base.velocity` and `legs.posture`. The
lock is checked before the adapter, so it holds online, offline, and with no write path.

**Consequence.** Our applications cannot request walking even if a verified path appears
tomorrow — removing a lock is a reviewed configuration change. Leg passivity during
upper-body servo remains an open hardware question, stated as such rather than inferred.

---

## D16 — The software stop revokes leases and reports delivery honestly

**Context.** A red button labelled "stop" invites the assumption that it stops the robot. On
the AimDK path there is nothing to stop: it is a read-only adapter.

**Decision.** The latch revokes every lease for that robot, zeroes what the adapter can zero,
and returns `certified: false` plus the adapter's `supported`/`delivered` flags. Clearing it
requires `{"confirm":"rearm"}` and is audited separately. The console shows the delivery
result, including `delivered: false`.

**Consequence.** Nobody can point at a 200 response and claim an emergency stop. The factory
e-stop remains the only certified stop, and the API says so in the stop response itself.

---

## D17 — Validation refuses, it never clamps

**Context.** The cockpit clamps joint targets to the stricter of documentation and model, and
reports which layer binds. That is right for a UI slider.

**Decision.** The gateway rejects out-of-range values with `422` and the binding limit, rather
than silently rewriting them. Only the caller may decide to clamp.

**Consequence.** The audit log records exactly what the client sent. The cost is that a client
must handle `422`; the alternative cost was an audit trail that disagrees with the wire.

---

## D18 — SSH is key-only, so there is no robot-side process

**Context.** The vendor guide describes `agi` plus a password, and an operator-supplied
password existed. The installed sshd offers `publickey` and nothing else (verified
2026-11-03). A bounded port check found only 22, 5000, 56322 and 56444 open — no rosbridge on
9090, nothing on 9000.

**Decision.** Stop treating the password as the access path. Do not modify the robot's sshd,
do not guess credentials, and do not install anything to work around it. Record the limit and
design around it.

**Consequence.** The arm command topic is unreachable from here: no ROS 2 publisher can run on
the robot without a key. The AimDK read-only adapter is the entire programmatic surface until
either a key is provisioned or AGIBOT exposes a supported service. The gateway's capability
model already reports this as "observable, not commandable" with a reason, so applications see
the truth rather than a stack trace.

---

## D19 — Measure the output, not the intent

**Context.** The face and speaker are the most legible parts of the robot, and the vendor has RPCs
for both. But the face has a player and no getter, and the audio-state RPCs sit on ports that are
not exposed on the Wi-Fi interface. It is tempting to record "we sent expression 7" as "the face
shows expression 7".

**Decision.** Treat face and audio as physical quantities. A microphone measures the speaker; a
camera measures the display. Both are opt-in, local-only, and labelled as measured by this Mac.
No inference about displayed state is recorded as fact.

**Consequence.** `room.html` is a sensor page, not a telemetry panel. It is honest about measuring
light and sound rather than emotion or intent, and it works without any robot API. The gap it
leaves — no machine-readable expression/audio state — is visible in the docs instead of hidden in
a UI.

---

## D20 — Presence is an unleased, expiring, scalar channel

**Context.** Getting the room sensors onto the dashboard could have been done by making them a
capability, or by shipping audio/video to the gateway. Both would have been wrong: presence is not
something the robot does, and media is not telemetry.

**Decision.** A separate channel (`POST/GET /api/v1/robots/:id/presence`, fanned out over the
telemetry socket) that carries only scalars, requires no lease, is capped at 10 Hz, goes stale
after 2 s and disappears after 30 s. Its source is self-declared and labelled
`notRobotTelemetry` in the contract.

**Consequence.** Any authenticated client can publish presence, and that is acceptable because it
grants no authority. A dead publisher becomes visibly stale rather than a frozen gauge. The
dashboard can show "he is speaking" without ever holding the audio that proves it.

---

## D21 — LiDAR is a binary pipe with interchangeable sources

**Context.** The Mid-360 topic is ROS 2-only, like the arm topic. The tempting shortcut is to have
the browser speak ROS 2 through a bridge, or to stream PointCloud2 frames as JSON. Both make the
viewer depend on a vendor protocol that is not reachable and cannot be tested.

**Decision.** Define one frame: Float32 xyz triples, little-endian, posted as
`application/octet-stream` and fanned out on a dedicated binary WebSocket. The simulator and any
future robot-side bridge are the same producer. The viewer does not know which one it is talking
to; the frame header says so.

**Consequence.** The pipeline, framing, rate limits, staleness and renderer are all built and
tested without robot access. Enabling the real sensor later is a bridge process, not a rewrite.
The cost is a translation step on the robot side (PointCloud2 → xyz), which is the one place
where vendor-specific knowledge belongs.

---

## D22 — Access is key-only, and recovery is physical

**Context.** SSH worked on 2026-11-02 and refused passwords on 2026-11-03. Every account offers
`publickey` only; the host key is unchanged since Oct 27 (no reimage); the key installed on Oct 27
is not on this Mac and no agent holds it. The robot's logs are the only place that could settle
why the change happened.

**Decision.** Treat key-only as the intended state. Do not re-enable password auth to work around
it, do not brute-force, and do not edit `sshd_config` without a console fallback. Recover through
a local console and install a dedicated key; keep password auth off afterwards.

**Consequence.** All robot-side work — shim, jobs, ROS 2, LiDAR, arms — is gated on one physical
action. The evidence and the recovery ladder live in `docs/access.md`, not in a chat log, so the
next lockout starts from facts. A dedicated key exists at `.secrets/luka_ed25519`
(gitignored); it is not yet authorised.

---

## D23 — Two compute tiers: a trusted shim and untrusted jobs

**Context.** Experimental code should run on the robot, but ROS 2 discovery needs the robot's
network graph, while a sandbox strong enough to be useful denies loopback and local sockets. One
profile cannot do both without being either leaky or useless.

**Decision.** Split them. A reviewed, minimal shim is the only ROS 2 subscriber and the only
component allowed on the robot's DDS graph. Arbitrary job code runs in transient systemd units
with no devices, no loopback, no `/agibot`, caps, and a TTL. Sensor data leaves the robot
outbound only; inference happens off-board; results return as annotations.

**Consequence.** Test code never needs motion authority or DDS access, and the shim stays small
enough to audit. The strict profile cannot use a GPU or localhost, so any job that needs either
gets a documented, per-job relaxation rather than a global one. The sandbox protects software,
not people; the factory e-stop remains the only certified stop.

---

## D24 — Calibration is data, not a heuristic

**Context.** The public URDF is a 12-DoF leg model; every arm and head joint in the twin was
added from vendor frames and limits. The robot's zero is not the model's zero, the legs were
being offset by a reference captured for the arms, and a global `flip2` convention was chosen by
a geometric heuristic. The result was a plausible pose that did not track the robot.

**Decision.** Store per-joint `{offset, sign}` calibration in a shared file
(`config/joint-calibration.json`). Legs default to absolute (offset 0) because their kinematics
are vendor-authoritative. Arms and head default to the captured hanging pose as neutral. Signs
start at +1 and are flipped per joint when motion runs backwards. A local calibration overrides
the shared file only when it is newer, and the old convention/reference controls are disabled
while a calibration is active.

**Consequence.** The twin's static pose is exact to the captured configuration and its offsets
are reproducible across browsers and devices. Direction is exact only after a human sign pass;
the table makes that a 28-row, one-click operation rather than a code change. The parallel wrists
remain the weakest part until a vendor arm description exists.
