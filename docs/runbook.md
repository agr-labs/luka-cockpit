# Runbook — Luka A2 Ultra

Operational procedures only. Interface facts live in
[interface-notes.md](interface-notes.md); safety reasoning in [safety.md](safety.md).

## 1. Network facts

| Item | Value |
|---|---|
| Luka (X86) | `192.168.4.136` · MAC `ac:45:ef:a4:81:4d` |
| This Mac | `192.168.4.138/22` on `en0` (Wi-Fi) |
| SSH | port 22 · account **`agi`** |
| Action gateway | port `56322` — `McActionService`, `McDataService` |
| Motion command gateway | port `56444` — `MotionCommandService` (e.g. `DisableMotionPlayer`) |
| Closed | 80, 443, 8080, and 40 probed app routes on 5000 |

### Three documented ways in

| Route | Procedure | Status here |
|---|---|---|
| Rear debug port | ethernet → `192.168.2.50`, `ssh agi@192.168.2.50` | **not possible** — no USB/Thunderbolt ethernet adapter on this Mac |
| ORIN AP hotspot | join `Robot-…`, `ssh agi@192.168.88.88` | untried |
| Via X86, then ORIN | `ssh agi@192.168.4.136`, then `ssh agi@192.168.100.110` | works — this is our path |

The SSH password is in `password.md` inside the AimDK package, per the vendor guide.
It is not published, and it is not on this Mac (searched Downloads/Desktop/Documents).

## 2. Power-on sequence

Measured 2026-10-28 after a charge cycle:

| t after power-on | What appears |
|---|---|
| ~40 s | ICMP answers, SSH (22) open |
| **~85 s** | `56322` starts listening |
| +few s | `56444` listening |
| stable | `GetAction` → `McAction_DEFAULT / RUNNING` |

**Do not probe before ~100 s.** A half-booted robot looks exactly like a dead one: no
ICMP, no ports. We lost time to that false alarm once already.

## 3. Health check

```sh
ping -c 3 192.168.4.136
for p in 22 56322 56444; do nc -G 2 -z 192.168.4.136 $p && echo "$p open"; done
curl -s -X POST http://192.168.4.136:56322/rpc/aimdk.protocol.McActionService/GetAction \
     -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool | head -20
```

Expect `code: "0"` and `status: "McActionStatus_RUNNING"`. A 404 means the gateway is up
but the method name is wrong — the router returns the *same* 404 for unknown services and
unknown methods, so a 404 proves nothing about a name being valid.

## 4. Starting the cockpit

```sh
cd a2-cockpit
node serve.mjs                 # foreground; prints the URL
# → http://127.0.0.1:8787/
```

```sh
curl -s localhost:8787/api/health
curl -s -X POST localhost:8787/api/robot/getAction | head -c 200
curl -s -X POST localhost:8787/api/robot/getJointState | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print(len(d["states"]),"joints")'
```

`JOINT_HZ` sets the joint stream rate (default 5, `0` disables). The mode poll stays at
0.2 Hz regardless.

Then in the page press **connect live**. The link badge should read `LIVE` within 5 s.

## 4a. Link budget vs the arm stream

The arm topic wants 100 Hz with adjacent commands ≤ 0.03 s. Measured on this Wi-Fi link over
20 ICMP samples: **min 3.9 ms, avg 16.0 ms, max 98.9 ms, σ 22.4 ms**. A second run during
the 0.2 Hz observation peaked at 197 ms with σ 96 ms.

That is not a 100 Hz link. A single 200 ms stall is ~20 missed setpoints, and
`arm_bridge.py` holds position after 300 ms of silence — so the first physical arm test
would stutter, and any deliberate movement would be interpolated across gaps rather than
streamed.

**Consequence: wired Ethernet is a prerequisite for arm commissioning, not a convenience.**
The rear debug port (`192.168.2.50`) exists for exactly this and needs a USB-C/Thunderbolt
Ethernet adapter on this Mac — none is currently attached. The Path A/B/C table above is
written around that.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE 127.0.0.1:8787` | another `serve.mjs` is already up | `lsof -ti:8787 \| xargs kill -9`, then restart |
| Link shows `OFFLINE`, SSH answers | robot still booting | wait to ~100 s, press connect again |
| Link shows `OFFLINE`, nothing answers | powered down / off network | check charge and Wi-Fi |
| A tab shows 429 / stale | two clients, pre-fix proxy | fixed: proxy now coalesces and serves `X-A2-Cache: hit` |
| Renderer chip says `WEBGL2` | no WebGPU adapter (or `?renderer=webgl`) | fine — both paths are verified |
| Twin looks like a flat wash | stale cached mesh | hard-reload; caching for generated assets is disabled |
| Badge reads `SIM` but you expected `LOCAL` | page served by a plain static server, not `serve.mjs` | start `node serve.mjs`, or use `?mode=local` to see the probe fail explicitly |
| Badge reads `LOCAL` on a static host | dist was not built by `package-site.mjs` | run it — it stamps the `luka-env` marker |
| Twin says `pose source: operator` while linked | joint stream not running or stale | check `JOINT_HZ`, then `/api/robot/getJointState`; the UI declares stale after 1.2 s |
| Joint values frozen | stream stopped but last pose still drawn | by design it stops claiming `LIVE`; if it doesn't, that's a bug |
| `ros2 topic list` empty **on the robot** | wrong DDS domain | `ROS_DOMAIN_ID=232`, `ROS_LOCALHOST_ONLY=0`, `FASTRTPS_DEFAULT_PROFILES_FILE=<robot image profile>` |

## 6. First-motion protocol — NOT YET AUTHORISED

Every step is separate, verified, and reversible. Stop at the first surprise.

**Preconditions**

- [ ] Operator's hand is on the factory e-stop (not merely "he's secured").
- [ ] Luka is awake and `GetAction` reports a single stable action.
- [ ] `config/arm-schema.json` still shows which step we're on.
- [ ] Someone is watching the arms, not the screen.

**Step 1 — read current angles (no motion)**

Requires ROS 2 access to `/motion/control/arm_joint_state` on domain 232. Until this
succeeds, steps 3+ are impossible: the command topic takes absolute positions.

**Step 2 — switch motion action (write, reversible-ish)**

```json
POST /rpc/aimdk.protocol.McActionService/SetAction
{
  "header": { "timestamp": {}, "control_source": "ControlSource_SAFE" },
  "command": { "action": "McAction_USE_EXT_CMD",
               "ext_action": "RL_LOCOMOTION_ARM_EXT_JOINT_SERVO" }
}
```

Then poll `GetAction` until it reports the new action — the call is asynchronous. Watch
the arms: do they hold or sag? That observation answers the open `DEFAULT` question.

**Step 3 — disable motion_player (write)**

```sh
curl -X POST http://192.168.4.136:56444/rpc/aimdk.protocol.MotionCommandService/DisableMotionPlayer \
     -H 'Content-Type: application/json' -d '{}'
```

Method name comes from a v1.3 adapter, not the v2.1 guide — verify before relying on it.
May stop factory preset gestures.

**Step 4 — hold, then move**

Publish a stream at the measured pose before any deliberate movement. Then one joint,
one degree, watching. Never the first command as a jump.

## 7. Shutting down

```sh
# stop the cockpit (Ctrl-C in its terminal, or:)
lsof -ti:8787 | xargs kill -9
```

`robot-bridge/arm_bridge.py` holds its last commanded position when Ctrl-C'd; it does not
ramp down by itself. Prefer stopping the publisher *before* the browser for that reason.
