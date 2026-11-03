# Steadwell Robot Gateway

One browser-native contract for operating a robot, with the vendor's motion
supervision, controller arbitration and emergency stop left exactly where the
manufacturer put them.

The gateway is not a collection of actuator endpoints. It is an authority and
restraint layer: leases, modes, capability negotiation, payload validation, and
an audit trail. Adapters know hardware. Applications know the contract. Nothing
else knows anything.

```
Applications
  cockpit · CoRA · Physical AI MCP · SINTINEL · XR teleoperation
        │  HTTP + WebSocket, one contract
        ▼
Steadwell Robot Gateway
  auth · leases · capability gates · validation · audit
        │  adapter interface
        ├── simulator   full body, no hardware
        ├── aimdk       read-only telemetry (McActionService / McDataService)
        └── ros2        declared, blocked, honest about it
        ▼
Luka's factory stack: AimMaster · MC · motion_player · e-stop (untouched)
```

Run it:

```sh
node gateway/server.mjs                 # console at http://127.0.0.1:8788/
npm test                                # 99 contract, gate, adapter, presence and lidar tests
```

Options: `--port`, `--host`, `--config`, `--token`, `--telemetry-hz`,
`--allow-physical` (which still does nothing without a verified adapter write
path). Environment equivalents are `GATEWAY_*`; see `--help`.

---

## 1. The contract

Eleven capabilities. Units are SI: radians, metres, metres/second, seconds.
The finger channel is the vendor's 0–2000 sensor count and is labelled as such.

| Capability | Observed | Commandable | Physical effect | Extra precondition |
|---|---|---|---|---|
| `head.gaze` | yes | yes | yes | — |
| `head.joints` | yes | yes | yes | — |
| `arms.joints` | yes | yes | yes | — |
| `arms.cartesian` | no | yes | yes | no IK; coarse box only |
| `hands.grasp` | yes | yes | yes | — |
| `legs.posture` | yes | yes | yes | grounded configuration |
| `base.velocity` | yes | yes | yes | grounded configuration |
| `voice.speak` | no | yes | audio | — |
| `voice.listen` | yes | yes | microphone | — |
| `camera.stream` | yes | yes | no | — |
| `motion.state` | yes | **no** | no | read-only by contract |

"Observed" and "commandable" above are the *contract ceiling*. Each adapter
reports its own support underneath, and the gateway serves the intersection. A
robot without dexterous fingers reports `hands.grasp: supported: false` with a
reason; it does not fail mysteriously at command time.

### Command envelope

```json
POST /api/v1/robots/luka/commands
{
  "commandId": "web_9f2c…",          // idempotency key, 6–64 chars
  "robotId": "luka",                 // optional, must match the URL
  "capability": "arms.joints",
  "payload": { "joints": { "idx13_left_arm_joint1": 0.2 } },
  "leaseId": "lease_…",
  "deadlineMs": 1793576185402         // absolute epoch ms, required
}
```

A repeated `commandId` with the same payload replays the stored response
(`X-Idempotent-Replay: true`) without re-executing. Reusing it with a different
payload is `409 command_id_conflict`.

### Endpoints

| Method + path | Purpose |
|---|---|
| `GET /api/v1/health` | liveness; no robot state, no auth |
| `GET /api/v1/contract` | capabilities, schemas, units, status codes |
| `GET /api/v1/adapters` | which adapters are loaded, and startup errors |
| `GET /api/v1/robots` | discovery, capability counts, profile, lease, stop |
| `GET /api/v1/robots/:id` | one robot, including composed state |
| `GET /api/v1/robots/:id/capabilities` | merged capability view with modes and reasons |
| `GET /api/v1/robots/:id/state` | action, health, lease, stop, profile, link |
| `GET /api/v1/robots/:id/joints` | measured joint positions |
| `GET /api/v1/robots/:id/cameras` | available streams (empty on Luka today) |
| `POST /api/v1/robots/:id/presence` | ingest one room-sensor sample (scalars only) |
| `GET /api/v1/robots/:id/presence` | latest sample, age and staleness |
| `POST /api/v1/robots/:id/lidar` | binary xyz frame ingest (bridge or simulator) |
| `GET /api/v1/robots/:id/lidar` | frame metadata, never points |
| `WS /api/v1/robots/:id/lidar` | binary point-cloud frames for a viewer |
| `WS /api/v1/robots/:id/telemetry` | state + joints at `telemetryHz` (10 Hz) |
| `GET /api/v1/robots/:id/telemetry` | same stream as Server-Sent Events |
| `GET /api/v1/telemetry` | WebSocket, all robots |
| `POST /api/v1/robots/:id/leases` | acquire control authority |
| `POST /api/v1/robots/:id/leases/:leaseId/renew` | extend |
| `DELETE /api/v1/robots/:id/leases/:leaseId` | release |
| `POST /api/v1/robots/:id/commands` | validated command |
| `POST /api/v1/robots/:id/stop` | latch the software stop |
| `POST /api/v1/robots/:id/rearm` | clear the latch (`confirm: "rearm"`) |
| `POST /api/v1/robots/:id/speech` | convenience wrapper over `voice.speak`; same gates |
| `GET /api/v1/audit` | append-only event log, newest first |

### Modes

A lease carries one mode. The mode is the client's declaration of intent; the
gates decide what it is actually allowed to reach.

| Mode | Meaning | Available when |
|---|---|---|
| `observe` | read only | always, when the capability is observable |
| `simulate` | commands apply to a simulator only | simulator robots |
| `manual` | commands may reach hardware | physical robot + enabled gateway + verified write path |
| `assisted` | manual + verified motion supervision | additionally requires `supervision` from the adapter — no adapter claims it |

### Status codes

| Code | Meaning |
|---|---|
| 400 | malformed request, bad `commandId`, unknown lease capability |
| 401 | bearer token required or wrong |
| 404 | unknown robot, capability or route |
| 405 | capability is read-only (`motion.state`) |
| 409 | state conflict: lease, mode, profile lock, configuration, deadline, unverified path |
| 413 | body over 64 KiB |
| 422 | payload failed validation; `details.errors[]` names field and bound |
| 423 | software stop latched |
| 429 | command rate limit (default 60/s sustained, 120 burst, per robot) |
| 503 | adapter offline |

Validation refuses, it never clamps. A joint at `3.0` rad when the limit is
`2.91` returns the bound, because an audit log that records a different number
than the client sent is worse than no audit log.

---

## 2. Gate order

Every command passes the same chain, in this order. The first closed gate wins,
and its code is returned and audited.

1. **Stop latch** — a latched stop outranks everything, including a malformed
   payload. `423 stop_latched`.
2. **Lease** — present, unexpired, matching `leaseId`. `409 lease_required` /
   `lease_mismatch`.
3. **Read-only** — `motion.state` is not a command. `405`.
4. **Profile lock** — the robot's configured policy. Checked before the adapter
   so the answer does not depend on whether the robot is online. `409 profile_lock`.
5. **Capability** — the adapter must implement it and declare it commandable.
   `409 capability_not_commandable` with the adapter's reason.
6. **Link** — offline robots refuse. `503`.
7. **Mode** — `observe` cannot command. `409 mode_read_only`.
8. **Physical reality** — for a physical capability on a physical robot:
   `simulate` is refused (`409 physical_in_simulate_mode`); the gateway must be
   started with `GATEWAY_ALLOW_PHYSICAL=1` (`409 physical_path_unverified`); the
   adapter must declare `writeVerified` for that capability (`409
   physical_path_unverified`); `assisted` additionally needs `supervision`
   (`409 supervision_unavailable`).
9. **Configuration** — capabilities that need a floor refuse a suspended robot.
   `409 configuration_mismatch`.
10. **Lease scope** — a scoped lease cannot exceed itself. `409 lease_scope`.
11. **Payload** — schema-lite validation. `422`.
12. **Deadline** — absent or past. `409 deadline_required` / `deadline_expired`.

The order is a safety argument, not an accident: authority before capability
detail, physical reality before payload convenience, and the stop before
everything.

---

## 3. Adapter status

| Adapter | Robot | Observable | Commandable | Why |
|---|---|---|---|---|
| `simulator` | `luka-sim` | 9/11 | 10/11 | full-body kinematic stand-in; `motion.state` read-only, `voice.speak` has nothing to observe |
| `aimdk` | `luka` | 5/11 when online | **0/11** | four verified read calls; no write path exists |
| `ros2` | `luka-ros2` (disabled) | 0/11 | 0/11 | requires a process on the robot; nothing is installed |

`aimdk` maps, from Luka's HTTP gateway on port `56322`:

| Call | Used for | Rate |
|---|---|---|
| `McActionService/GetAction` | action, status, controller owner | 0.2 Hz |
| `McDataService/GetJointState` | 26 body joints | 5 Hz |
| `McDataService/GetNeckState` | 2 head joints | 2 Hz |
| `McDataService/GetHandState` | 12 finger channels | 2 Hz |

It implements no writes. That is the design, not an omission: the gateway will
not invent a ROS 2 publisher behind an HTTP adapter, and the vendor warning about
malformed motion messages is taken at face value.

When the link drops, the adapter reports `online: false`, `health: unknown`, and
every capability becomes `supported: false` with the link error as the reason.
It never freezes the last state and calls it live.

---

## 4. The Suspended Test profile

Luka is fully suspended: full weight on a rated rig, feet clear of the floor.
That is a different operating configuration from a grounded robot, and the
gateway encodes it as policy rather than as a comment.

```json
"profile": {
  "name": "suspended-test",
  "suspension": "full weight",
  "feet": "clear of floor",
  "rig": "rated for full weight",
  "locomotion": "locked",
  "armControl": "simulation only",
  "motionSchema": "unverified",
  "controller": "AimMaster (preserved)",
  "locks": [
    { "capability": "base.velocity", "reason": "…" },
    { "capability": "legs.posture", "reason": "…" }
  ]
}
```

What this does:

- **Locks locomotion in software, before any adapter.** A `base.velocity` or
  `legs.posture` command returns `409 profile_lock` with the reason, whether the
  robot is online, offline, or the adapter has no write path. The lock is
  configuration; removing it is a reviewed diff.
- **Advertises itself.** `GET /state`, `GET /capabilities` and `/robots` all
  carry the profile, so the console and any application can display the rig
  state and the locks without guessing.
- **Keeps upper-body commands gated.** On Luka, `head.*`, `arms.*` and
  `hands.*` are observable and not commandable: `aimdk` is read-only. On the
  simulator they are exercisable.

What this does **not** do:

- It does not relax the legs, and it does not claim that upper-body servo makes
  the legs passive. Whether `RL_LOCOMOTION_ARM_EXT_JOINT_SERVO` or a
  `PASSIVE_UPPER_BODY_*` mode changes leg behaviour on this firmware is an open
  hardware question.
- It does not replace a certified stop. The software stop latches the gateway,
  revokes leases, and asks the adapter to stop; on `aimdk` the adapter answers
  `delivered: false`, because nothing was delivered.
- It does not make the manufacturer's feet-contact startup procedure optional
  for a grounded robot. `configuration` and `profile` are separate facts and
  both are served.

---

## 5. Security posture

- Binds `127.0.0.1` by default. It is a local control surface, not an internet service. A
  robot-side shim that pushes frames needs `--host 0.0.0.0` plus a token and a firewall rule
  limited to the robot's subnet ([sandbox](sandbox.md) §5).
- `GATEWAY_TOKEN` (or `--token`) turns on bearer auth for every `/api/v1` route except
  `/health`. Compared in constant time. WebSocket and SSE clients pass the token as
  `?token=` because browsers cannot set headers on those transports.
- CORS is permissive (`*`) so a cockpit on another local port can call it. With no token,
  any page in the browser can reach a local gateway and command **the simulator**. Set a
  token if the machine is shared, and never expose the port without one.
- No TLS. Put a proxy in front if it ever leaves the loopback interface.
- No persistence: leases, audit and idempotency keys are in memory, so a restart is a clean
  slate. That is the right default for an authority layer.
- The audit log is a ring buffer of 2000 events; `GET /audit` returns the tail.

---

## 6. What is deliberately absent

- **No persistence.** Leases, audit and idempotency are in memory. A restart is
  a clean slate, which is the correct default for an authority layer.
- **No multi-gateway coordination.** One process owns one set of robots. Two
  gateways pointed at one robot would each be honest and jointly wrong.
- **No IK.** `arms.cartesian` is bounded and simulated with a crude correlation,
  labelled as such. Real cartesian control needs kinematics and a calibrated
  workspace.
- **No vendor protocol.** The gateway speaks HTTP/JSON and WebSocket. Protobuf,
  DDS and vendor SDKs belong in adapters.
- **No claim of safety certification.** Read `docs/safety.md` before trusting any
  button in the console.

---

## 7. Tests

`npm test` — 99 tests, no network, no dependencies:

| File | Covers |
|---|---|
| `contract.test.mjs` | schemas, limits, drift against `config/arm-schema.json` and the URDF |
| `lease.test.mjs` | exclusivity, expiry, renewal, epochs, scope, revocation |
| `api.test.mjs` | every endpoint, gate, idempotency, stop/rearm, rate limit, WS + SSE |
| `physical.test.mjs` | real `aimdk` adapter against a fake AimMaster; every physical gate |
| `profile.test.mjs` | suspended profile locks, config drift, lock auditing |
| `presence.test.mjs` | sample validation, 10 Hz cap, staleness, TTL, WS fan-out |
| `lidar.test.mjs` | frame framing, alignment, caps, simulator bounds, binary WS, ingest |

The drift tests are the point: if someone edits the arm limits in one place and
not the other, CI fails.

---

## 8. Measuring face and audio

The robot has a face (a display driven by AimMaster Face) and a speaker, and the vendor exposes
RPCs for both. Reachability decides what we can actually measure:

| Question | Answer | Why |
|---|---|---|
| Can we read the current expression? | **no** | no getter exists in the docs; `GetEmoticon` (list) is on 51049, not exposed on the Wi-Fi IP |
| Can we command an expression? | **yes, unauthorised** | `PlayerEmoticon` on 59001 answers with CORS; it is a write with a visible effect, so it was not called |
| Can we read TTS/audio state? | **no** | `GetAudioStatus` and `GetAudioVolume` live on 59301/56666, neither reachable from 192.168.4.136 |
| Can we measure the speaker? | **yes** | a microphone measures the actual output, which is stronger evidence than a status flag |
| Can we measure the display? | **yes, coarsely** | a camera measures luminance and frame motion; it does not read emotion |

`gateway/public/room.html` is the measurement path that exists today:

- **Microphone** — opt-in, local only. dBFS, peak, VAD state with 400 ms hangover, 20 s history
  on a canvas. This is how you tell whether Luka actually spoke.
- **Camera** — opt-in, local only. Mean luminance and frame-to-frame delta at 8 fps. Point it at
  the face screen: it changes when the face animates, and it is silent about what the face means.
- Neither stream is recorded, uploaded, or sent to the gateway. Closing the tab releases the
  devices; there is also an explicit stop button per sensor.

Verified with Chrome's fake capture devices (microphone −15.3 dBFS with VAD active, camera
luminance 110 and frame Δ 2.69). Real capture uses the same code path and the browser's
permission prompt.

This is a deliberate boundary: **do not infer displayed state from what we sent.** We may know
that we asked for expression 7; only the camera knows that the screen shows it.

## 9. The presence stream

The dashboard gets face and audio as **measured quantities**, because the robot will not report
them. A browser page with a camera and a microphone samples the physical output and posts
scalars to the gateway, which fans them out over the existing telemetry socket.

```
room.html (mic + camera)
   │  POST /api/v1/robots/:id/presence   5 Hz, 202 Accepted
   ▼
PresenceRegistry   seq · server timestamp · TTL 30 s · stale after 2 s · max 10 Hz
   │  WebSocket {type:"presence"} + state.presence
   ▼
dashboard console  meters, staleness, provenance
```

Sample payload — the complete set of fields that can leave the page:

```json
{
  "mic":    { "db": -15.3, "peak": -12.1, "speaking": true },
  "camera": { "luminance": 110, "motion": 2.69 },
  "devices": { "mic": "MacBook Microphone", "camera": "FaceTime HD Camera" }
}
```

Properties worth keeping:

- **Scalars only.** No audio buffers, no frames, no images. The page computes locally and sends
  numbers.
- **No lease and no authority.** Presence grants nothing and commands nothing; it is an
  observation channel. It is not audited per sample, because it would flood the log without
  changing what anyone is allowed to do.
- **Bounded.** dBFS −100…0, luminance 0…255, motion 0…1000, 10 Hz server-side cap, 120-character
  device labels.
- **Expiring.** A dead publisher stops being visible: `stale` after 2 s, gone after 30 s. The
  dashboard never freezes a value and calls it live.
- **Self-declared.** `source: "room-sensors"` is what the publishing client says it is. The
  console prints it with the sequence number, and the contract marks the channel
  `notRobotTelemetry: true`.

What it is not: a face-state API. If expression 7 was requested and the screen shows the neutral
face, presence reports light and motion, and the operator can see the difference. Inference from
command intent remains forbidden ([D19](decisions.md)).

## 10. The LiDAR pipeline

Real LiDAR is a Livox Mid-360 on the neck: `sensor_msgs/PointCloud2` at 10 Hz on
`/aima/hal/lidar/neck/pointcloud`. Like the arm topic, it is ROS 2-only and there is no bridge on
the Wi-Fi interface, so the pipeline is built around a **source-agnostic frame**:

```
simulator (room scan, 10 Hz)                 a future robot-side bridge
        │                                              │
        └──────────────┬───────────────────────────────┘
                       ▼
        POST /api/v1/robots/:id/lidar        application/octet-stream
        Float32 xyz triples, ≤ 262 144 points, ≤ 25 Hz
                       │
                       ▼
                    LidarHub      seq · server timestamp · stale 1.2 s · TTL 10 s
                       │  WebSocket binary (separate channel)
                       ▼
                lidar.html        WebGL2 points · live / accumulate · voxel snap
```

Wire format is deliberately dumb — `[u32 LE header length][JSON header][Float32 xyz]` — because a
bridge that can read `PointCloud2` can pack xyz and POST it without adopting our schema. No PCL,
no compression, no PointCloud2 field parsing in the browser.

Properties:

- **Separate channel.** Point clouds do not ride the state/joints socket: a dashboard tab should
  not receive 26 KB × 10 Hz because a viewer is open elsewhere.
- **Bounded.** 262 144 points per frame (3 MiB), 25 Hz ingest, 400 000-point accumulation ring in
  the viewer.
- **Expiring.** Metadata is marked stale after 1.2 s and dropped after 10 s. A stopped publisher
  does not leave a frozen room.
- **Metadata is safe to log.** `GET .../lidar` returns seq, count, source and age — never points.

### What the viewer does and does not do

`lidar.html` renders points with WebGL2 and offers three honest modes:

| Mode | Meaning |
|---|---|
| live frame | exactly the newest scan |
| accumulate | a ring buffer of recent points, so a static room builds up |
| voxel 0.1 m | snaps positions to a lattice **in the shader** — visual occupancy, not a surface |

There is no meshing, no normals, no TSDF, and no claim that the space has been reconstructed. The
simulator is a closed box with three obstacles and millimetre noise; it exists to exercise the
framing, the viewer and the ingest path, not to impersonate a Mid-360.

For the physical robot the viewer says *"Waiting for frames"* and stays there. That is correct
until a bridge can publish.

## 11. Next milestones

1. **Verified upper-body mode.** Read AimMaster's Movement screen and record the
   exact mode names and firmware string. The controller is the supported path;
   `SetAction` is not.
2. **Mechanical inventory on the robot.** `sh tools/luka-ssh.sh --explain`, then
   `discover` (bounded /22 sweep by MAC) if DHCP moved him, then `inventory` from the
   robot's subnet: ROS environment, listening ports, services, `/opt`. Read-only,
   no installs.
3. **Telemetry parity.** Nothing to add on the read path until new endpoints are
   verified; the twin already mirrors 26 + 2 + 12 channels.
4. **Voice, separately.** Browser capture and local TTS in the cockpit do not
   need any motor authority, and should not wait for it.
5. **One physical capability, end to end.** Only after its interface, semantics,
   limits, feedback, arbitration and stop behaviour are established — and only
   with a human watching the first motion.

The robot-side shape for these bridges — a reviewed ROS 2 shim plus unprivileged jobs with no
motion authority — is in [sandbox.md](sandbox.md). It is blocked on [access](access.md).
