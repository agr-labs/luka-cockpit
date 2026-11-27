# Dashboard head controls

Open `http://127.0.0.1:8790/#head-controls` and refresh the dashboard.

1. **Enable head controls** captures the measured motor pose and takes neck-only
   ownership from the factory motion player.
2. Tap an arrow for a 2° target change. The initial travel envelope is ±10° pan
   and ±5° tilt around the captured start, intersected with the vendor limits.
3. **Return to start** targets that captured motor pose.
4. **Release controls** restores the previous neck owner. Hiding or closing the
   page also releases the session. A 10-second heartbeat timeout runs on Orin.

In LukaChat, use **Menu → Controller setup** to check/assign buttons and calibrate
the right stick. The attached 8BitDo Ultimate 2C gets LT talk and RB head hold
when the browser reports a standard layout; raw layouts require assignment.
The **8BitDo right stick · Luka's head** menu switch acquires the same bounded
lease. Center the stick and release RB once, then hold RB while steering.
Releasing the guard stops new 2° commands. Menu/setup panels suppress movement,
and disconnect, hidden-page and focus loss release control. Calibration and
profile changes switch head control off; enabling it again is explicit.
Physical controller-to-head validation is pending current robot SSH access.

LukaChat also has a default-off **Look toward visible faces** mode. It detects
the largest confident face in the forward interactive camera and makes bounded
2° adjustments. It uses the same exclusive head lease, so a manual session
blocks automatic movement; enabling the controller rocker first stops face follow.
The feed is currently about 1 Hz, and the camera-to-neck alignment is not yet
calibrated. The UI labels this as a limited prototype.

The panel displays measured and target angles. One movement can be outstanding;
buttons do not repeat while held. Motion is checked against measured feedback
with a 0.4° settling tolerance. These are bounded position targets; releasing
controls is an ownership handback, not a certified emergency stop.

## Implementation

The bridge hosts `/head/state`, `/head/acquire`, `/head/heartbeat`, `/head/jog`,
`/head/home` and `/head/release`. The scoped controller in
`gateway/lib/head-control.mjs` uses the existing gateway lease manager and head
payload validator. Its HTTP writes require same-origin JSON and a private lease
token. The general AimDK adapter remains an observation adapter; the head panel
has a dedicated, head-only path.

`tools/luka-head-worker.py` runs transiently over SSH on Orin. It calls only the
allowlisted neck/action getters, neck ownership RPCs and SetNeckCommand. It has
an independent lease timeout, range/step checks, command deadlines translated to
Orin's clock, and a Linux abstract-socket lock against a second control worker.
It creates no robot files and no ROS publisher. An ownership restoration failure
retains the lock and retries rather than permitting new movement.

The installed MotionCommandService returns `{ "state": "CommonState_SUCCESS" }`
without a response header. A present header must succeed; the explicit success
state and the measured ownership state are checked too.

## Verified on 2026-11-06

* 108 gateway tests and 15 worker tests passed.
* Desktop and phone browser checks passed with mocked hardware: initial motion
  interlock, enable/jog/home/release, rapid-tap suppression, visibility release,
  lost feedback and viewport width.
* A live browser test took neck ownership, requested a 2° pan, returned to start,
  requested a 2° tilt, returned to start and restored factory ownership. Measured
  positions followed within the settling tolerance.
* A separate live check sent no heartbeat and no movement requests. After 10.8 s,
  an independent read of factory MotionCommandService confirmed neck ownership
  restored, and the worker reported its heartbeat timeout.

Evidence: [`evidence/head-controls-2026-11-06.json`](evidence/head-controls-2026-11-06.json).
Camera captures from this test do not establish that the interactive camera is
rigidly attached to the moving neck; optical-to-neck geometry remains a separate
calibration task.

Checks: `npm test` and `npm run test:head`.
