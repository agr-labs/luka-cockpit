# Luka Upper-Body Embodied Sim & Application Hub

The **Steadwell · Luka v. A2U Application Hub** (`/`) provides a single animated launcher for every local and static simulation, telemetry, voice, and operations console in the workspace.

## Applications

| # | App | Path / Port | Purpose |
|---|---|---|---|
| `01` | **Luka Upper-Body Sim** | `/luka-sim.html` | Embodied upper-body digital twin with obsidian OLED head, speech, Kameyoko vision, Trellis context & AimDK hardware safety envelope |
| `02` | **Full-Body A2U Cockpit** | `/cockpit.html` | Complete 52-DOF bipedal digital twin, recordings playback, joint inspector & read-only AimDK telemetry link |
| `03` | **Robot Gateway** | `:8788/` | Lease-gated capability control plane, safety contract, software stop & audit trail |
| `04` | **LukaChat** | `:8791/chat` | Conversational voice & gamepad interface with hardware-verified `±10° / ±5°` neck jog controls |
| `05` | **Voice Console** | `:8788/voice.html` | Push-to-talk speech diagnostics, provider readiness & bounded turn inspection |
| `06` | **Audio + Transcript** | `:8791/` | Live Whisper transcript monitor, Inworld TTS voice selector & head panel |
| `07` | **LiDAR Space** | `:8788/lidar.html` | Real-time 3D point-cloud viewport with live-frame & room-accumulation modes |
| `08` | **Room Sensors** | `:8788/room.html` | Host microphone dBFS & camera presence ground-truth telemetry |

Quick launch from `/` with keys `1`–`8`. On static deploys (`<meta name="luka-env" content="static">`), cross-port localhost health probes are skipped automatically.

---

## Upper-Body Embodied Sim (`/luka-sim.html`)

### 1. Visuals & Kinematics
- **AgiBot A2 Ultra Upper-Body Skinning** (`src/upper-renderer.js`): Glossy obsidian black head (`head_link02`) with animated cyan OLED eyes & speech-RMS reactive waveform visor, pearl-white shell & anodized gunmetal joints, chest `logo.stl`, and lower body hidden by default (toggleable).
- **Articulated Inspire RH56 Hands** (`model/hand/`, `src/luka-motion.js`): 6 independent curl channels per hand (`thumbOpp`, `thumb`, `index`, `middle`, `ring`, `pinky`) driving 12 primary + mimic finger joints with non-hyperextending mimic clamps.

### 2. Hardware-Faithful Safety Envelope (`src/hw-safety.js`)
The sim defaults to **`HW Spec (A2 Ultra)`** aligned directly to `gateway/lib/contract.mjs` and `config/arm-schema.json` (AimDK §7.1.5–6, §7.1.9):

- **Neck limits**: `idx27` pan `[-0.785, +0.785]` (`±45°`), `idx28` tilt `[-0.401, +0.401]` (`±23°`).
- **Elbow stop clearance**: `idx16 ∈ [-2.00, -0.03]` and `idx23 ∈ [+0.03, +2.00]` (stays clear of `0.00` straight-arm hard stop).
- **Coupled rhombic parallel wrist guard (`clampRhombicWrist`)**: projects `(j6, j7)` onto `|j6|/0.30 + |j7|/0.20 <= 1.0` so pushrod wrists never enter mechanically binding corners.
- **Exact discrete-time braking velocity & acceleration limiter**: enforces per-joint speed and acceleration caps with zero overshoot or wall-snap spikes across three selectable profiles:
  - **`Bring-Up Safe`**: `<= 0.85 rad/s` arms / `0.90 rad/s` neck, `<= 2.5 / 2.8 rad/s²`, 90% wrist diamond.
  - **`HW Spec (A2 Ultra)`** *(default)*: `<= 2.40 / 1.95 rad/s`, `<= 5.0 rad/s²` (20%+ margin below vendor `3.0 rad/s` & `6.28 rad/s²`).
  - **`Studio Wide (Sim Only)`**: expanded offline visual range.
- **Soft Hold (`H`)**: freezes all upper-body targets cleanly in place with zero drift.
- **Dry-Run HW Packet Inspector**: translates the current sim pose into a read-only hardware preview packet applying the verified live neck pitch sign flip (`-sim = real UP` per `docs/evidence/head-controls-2026-11-06.json`), `0..2000` Inspire hand counts, and explicit pre-flight validation that refuses out-of-envelope neck goals and hard-blocks unverified arm joints (`idx13..26`).

### 3. Kameyoko Vision & Anti-Spaz Tracking-Loss Failsafe (`src/kameyoko-tracker.js`)
- MediaPipe 33-point 3D Pose + 2×21-point Hand tracking with One Euro smoothing, calibrated 3D orthogonal arm/wrist retargeting, scale-invariant 3D joint-angle finger curls, and Hand Smoothing & Calibration controls.
- **Pre-filter quality gating (`assessPoseTrackingQuality`)**: checks combined `visibility`/`presence` with hysteresis, in-frame margins, anatomical upper-arm/forearm bone lengths, and single-frame teleport rejection before updating `OneEuro` filters.
- **Per-arm 3-state failsafe (`LOCKED → HOLD → RELAX`)**:
  - Brief occlusion/glitch (`0–900 ms`): freezes that arm in **`HOLD`** with zero twitch while the visible arm and head keep tracking.
  - Sustained loss (`> 900 ms` or cropped arms at desk startup): gently eases the lost arm back to a calm resting pose (`RELAX`), requiring 3 consecutive clean frames + `0.38 s` blend-in to re-lock.
  - Seated desk-webcam hip anchoring (gravity vertical when hips are cropped) and continuous `atan2` roll unwrapping (`unwrapAngleNear`) eliminate sudden `±π` whips.

### 4. Speech Pipeline & Sovereign Trellis (`src/sim-api.mjs`, `src/trellis-engine.js`)
- **Local mode (`node serve.mjs`)**: Hold-to-Talk / Click-to-Toggle / `Space` → local `whisper-cli` ASR → embodied LLM reasoning (`[GESTURE:...]` / `[SKILL:...]`) → Inworld `inworld-tts-2` / macOS `say` TTS → WebAudio RMS-driven OLED visor & motion.
- **Static mode (Cloudflare Pages)**: automatically skips `/sim-api/*` probes (`meta[name="luka-env" content="static"]`), runs browser-local embodied gesture responses + Web Speech Synthesis, persists Trellis in `localStorage`, and loads MediaPipe directly from CDN.

### 5. Privacy-First Analytics & Learning Telemetry (`/analytics.html`)
- **Zero-PII batched SDK (`src/metrics.js`)**: ephemeral per-tab `session_id`, zero cookies, zero IPs, and strict metadata filtering (`src/metrics-agg.mjs`) that strips any raw speech transcripts, prompts, audio, or credentials.
- **Signals collected**: app launches, renderer & FPS boot metrics, top gestures/skills, speech pipeline latencies (`ASR ms`, `LLM ms`, voice vs. text), Kameyoko tracking-loss guard reasons (`out_of_frame`, `low_vis`, `bad_bone_len`, `teleport_glitch`), AimDK safety profile usage, Soft Hold triggers, peak actuator speed/accel/rhombic wrist loads, and Trellis skill growth.
- **Dual storage**:
  - **Production (Cloudflare Pages)**: Pages Functions (`functions/api/metrics*.js`) backed by Cloudflare D1 (`luka-metrics`, schema in `migrations/0001_metrics.sql`).
  - **Local (`node serve.mjs`)**: `/sim-api/metrics*` writing to gitignored `data/metrics/events.jsonl`.
- **Dashboard & Export**: open `/analytics` (or `/analytics.html`) for live 24h / 7d / 30d rollups, JSONL / CSV export, and a browser opt-out toggle.

## Tests

```sh
npm run test:sim         # 11 upper-body sim, safety, Kameyoko failsafe & Trellis tests
npm test                 # 113 gateway contract, lease, gate & adapter tests
npm run test:controller  # 9 LukaChat gamepad controller tests
```
