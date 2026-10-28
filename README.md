# Luka cockpit

Browser digital twin of an AGIBOT A2 Ultra humanoid, with a read-only telemetry bridge, a
control-authority state machine, and a fully specified — but deliberately disabled — arm
command layer. WebGPU with a WebGL2 fallback. No npm dependencies.

Built by [AGR Labs](https://github.com/agr-labs) while commissioning a real A2 Ultra. The
safety posture in this repository is not decoration: every gate exists because of something
that happened on the robot. See [decisions](docs/decisions.md).

**Live demo: <https://luka.steadwell.cc>** — SIM mode, no robot required.

```sh
git clone https://github.com/agr-labs/luka-cockpit.git
cd luka-cockpit
sh tools/fetch-model.sh     # restores the gitignored model payloads, then builds
node serve.mjs              # → http://127.0.0.1:8787/
```

Without a robot the page runs in **SIM** mode: twin, playback, presets. Live telemetry needs
the local proxy talking to an A2 on the same network.

`?renderer=webgl` forces WebGL2. `?renderer=webgpu` forbids the fallback.

---

## Status, in one table

| Capability | State | Notes |
|---|---|---|
| Digital twin render | **works** | WebGPU + WebGL2 verified, 306k tris, 30–60 fps |
| Twin kinematics | **verified** | matches MuJoCo to 3.0e-7 m across 49 bodies |
| Luka telemetry (read) | **works** | `GetAction` at 0.2 Hz + `GetJointState` at 5 Hz |
| Live twin mirroring | **works** | 26 body + 2 neck joints + 12 finger channels, real time |
| Recording playback | **works** | 3 real Luka joint recordings, 26 joints each |
| Arm command schema | **known** | vendor guide §7.1.9, see [interface notes](docs/interface-notes.md) |
| Arm command transport | **blocked** | needs a process on the robot (ROS 2 / SSH) |
| Arm joint feedback | **solved** | `McDataService/GetJointState`, 26 joints @ 5 Hz |
| Head / hands telemetry | **works** | `GetNeckState` (2 joints), `GetHandState` (12 channels) |
| Finger rendering | **approximate** | synthetic boxes — the vendor model has no finger geometry |
| Motion action gate | **closed** | Luka is in `McAction_DEFAULT`, which forbids arm commands |
| Physical motion | **disabled** | `config/arm-schema.json` → `enabled: false` |
| Static deploy | **works** | Cloudflare Pages, SIM mode, no gateway needed |

Nothing in this repository can move Luka today. That is deliberate and enforced in
three places: the proxy allowlist, the schema interlock, and the action gate.

## Quickstart

```sh
node serve.mjs                                  # cockpit on :8787
curl -s localhost:8787/api/health               # proxy + robot target
curl -s -X POST localhost:8787/api/robot/getAction | python3 -m json.tool | head -12
```

In the page: **connect live** to poll Luka, **play** to replay a recording, drag/wheel to
orbit, `space` for deadman, `esc` for the software stop.

## The four gates between us and motion

1. **Action gate.** Arm commands are only valid in `PASSIVE_UPPER_BODY_JOINT_SERVO`,
   `RL_LOCOMOTION_ARM_EXT_JOINT_SERVO` or `RL_WHOLE_BODY_EXT_JOINT_SERVO`. Luka runs
   `McAction_DEFAULT`. Switching is a write (`SetAction`) and nobody has authorised it.
2. **motion_player.** In JOINT_SERVO mode it takes over the arm topic; the vendor requires
   disabling it first. It is remotely reachable at `POST :56444/…/DisableMotionPlayer`
   (reverse-engineered from a v1.3 adapter; unverified on our v2.1 build).
3. **Joint feedback.** There is no HTTP route to arm angles — nine candidates 404'd. The
   topic takes *absolute* positions, so publishing before we know the current pose is a
   blind jump of unknown size.
4. **Credentials.** The SSH account is `agi`; the password lives in `password.md` inside
   the AimDK package, which AGIBOT does not publish. That package is the remaining
   procurement task.

## Reading order

| Doc | What's in it |
|---|---|
| [docs/interface-notes.md](docs/interface-notes.md) | every interface fact we have, its source, and what is still unknown |
| [docs/runbook.md](docs/runbook.md) | power-on, health checks, cockpit start, troubleshooting, first-motion protocol |
| [docs/safety.md](docs/safety.md) | authority model, stop semantics, what each guard actually proved |
| [docs/decisions.md](docs/decisions.md) | why the dangerous-looking choices are the safe ones |
| [docs/sdk-notes.md](docs/sdk-notes.md) | vendor SDK contents, the control-source model, what it does and doesn't unlock |
| [docs/deploy.md](docs/deploy.md) | static build, CI, payload limits, sim-vs-local parity |

## Two modes, on purpose

The page detects its environment at boot and says which one it is in — chip in the top
bar, and an explanation in the link panel.

| Mode | Where | Behaviour |
|---|---|---|
| **SIM** | static hosting (Cloudflare Pages) | twin, playback, presets, sliders. Link panel reads `STATIC`; connect is disabled; arm gate says *sim build · no robot transport* |
| **LOCAL** | `node serve.mjs` | everything above plus live `GetAction` telemetry through the proxy |

A static build carries a `luka-env` marker so it never fires a probe that would 404, and
never shows a fake "offline" alarm. Build it with:

```sh
node tools/package-site.mjs      # → dist/ (≈39.6 MB, 29 files)
cd dist && python3 -m http.server 8791
```

Deployment is a GitHub Action in this repo — see [docs/deploy.md](docs/deploy.md)
for the workflow, the two required secrets, and the 25 MiB per-asset budget.

## What the twin is, and is not

Generated from the public AgiBot A2 model
([MDeanH/luka-a2-ultra-model](https://github.com/MDeanH/luka-a2-ultra-model) →
`Link-U-OS/rl_training` @ `8bf8fd8`, Mulan PSL v2).

| Property | Value | Source |
|---|---|---|
| Links / joints | 49 links, 48 joints → **28 primary DOF** + 8 linkage | vendor URDF |
| Actuated | **12** (legs only, 6 DOF each) | vendor MJCF |
| Mass | 69.344 kg | URDF inertials |
| Standing height | **1.6913 m** — exactly the vendor reference | built FK |
| Mesh | 47 STLs, 306,130 triangles, 22 MB merged | vendor meshes |

**It is an estimate, not Luka.** The source model is `A2 T2D0`; Luka's software reports
`A2_T3D1_FLAGSHIP`. Every Luka-specific row in `model/measurements.csv` is blank. The 16
arm/head joints carry vendor limits that are unverified for him. The UI says so: unactuated
joints are badged `unverified`, and the viewport reads *"estimated model · FK checked
against MuJoCo, not calibrated to Luka"*.

## Verification you can re-run

```sh
node tools/build-model.mjs     # URDF + STLs → model.json + mesh.bin (asserts counts)
node tools/verify-fk.mjs       # FK vs MuJoCo; fails if drift > 1e-6 m
```

`verify-fk.mjs` compares against MuJoCo 3.17 evaluating the same model
(`tools/mj_reference.py`). Current result: **3.0e-7 m max error across 49 bodies**, zero
pose and a 24-joint perturbed pose, plus a per-joint sweep of all 28.

Three silent bugs were caught this way — a double-applied Z-up→Y-up rotation, a
destination/source aliasing bug in the matrix multiply that broke every posed frame while
leaving the zero pose intact, and a 7-vs-6 floats-per-vertex mismatch that rendered a
screen-filling wash. All three failed quietly; none would have been visible without the
numeric check.

## Layout

```
index.html · styles.css
src/main.js        UI, render loop, presets, playback controls, arm panel
src/model.js       FK over the generated joint tree, limits, clamping
src/renderer.js    WebGPU (WGSL, 4× MSAA) + WebGL2 (GLSL ES 3.0), per-link draws
src/armcontrol.js  arm command layer, limit intersection, action gate, transports
src/a2rec.js       A2REC1 parser + playback clock
src/env.js         sim/local detection (meta marker or /api/health probe)
src/link.js        0.2 Hz telemetry poll
src/safety.js      authority state machine, deadman, watchdog, clamps
serve.mjs          static server + coalescing read-only AimDK proxy
config/            arm-schema.json (the interlock)
robot-bridge/      arm_bridge.py — on-robot publisher, 100 Hz, holds on expiry
tools/             build-model · package-site · mc (rate-limited RPC) · mj_reference ·
                   verify-fk · fetch-model · onrobot-probe
docs/              interface notes · sdk notes · runbook · safety · decisions · deploy
model/             vendored URDF, meshes, recordings, provenance, build report
```

`model/meshes/`, `model/recordings/`, `model/generated/`, `model/mjcf/` are gitignored
(≈53 MB); `tools/fetch-model.sh` restores them and rebuilds.

## Licence

Original code is **MIT** (see [LICENSE](LICENSE)). The vendored robot model is **Mulan PSL
v2**, and the joint recordings come from the vendor's app — both are third-party material
with their own terms. See [NOTICE](NOTICE). No credentials, SDK binaries or robot secrets are
included.

## Controller-preservation tests — still not performed

| Test | Required result | Status |
|---|---|---|
| Laptop disconnected | Factory controller operates normally | ☐ |
| Laptop connected, idle | Controller still operates normally | ☐ |
| Laptop reading telemetry | No interference | ☐ |
| Link dropped | No unexpected movement | ☐ |
| Factory e-stop | Robot responds per manufacturer procedure | ☐ |
| Reconnection | No unrequested motion or mode switch | ☐ |

E-stop testing on a humanoid can cause a collapse: support rig, clear area, second person
on physical safety.
