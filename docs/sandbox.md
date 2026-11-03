# Robot-side sandbox and distributed compute

How to run test code on Luka safely, and how to put heavy inference somewhere that is not the
motion controller.

**Status: designed, not deployed.** No SSH access ([access](access.md)). Nothing in this
document has run on the robot.

---

## 1. Goals and non-goals

**Goals**

- Run experimental code on the X86 or ORIN without touching `/agibot`, device nodes, or the
  factory motion stack.
- Cap CPU, memory and I/O so motion control always wins.
- Let code ship frequently with a hard time limit and a kill switch.
- Stream sensor data **outbound** to a Mac or GPU host for inference, and bring results back as
  annotations — never as motor commands.

**Non-goals**

- A certified safety boundary. The sandbox protects software, not people.
- Running code with motion authority.
- Persistence across reboot.
- Kernel-level isolation. systemd hardening is not a VM; assume no hostile kernel exploits.

## 2. Two tiers, because ROS 2 and isolation conflict

A strict sandbox (no loopback, no local network) cannot subscribe to ROS 2 topics: DDS discovery
and transport need the robot's network graph, and camera topics may use shared memory. Trying to
have one profile do both produces either a leaky sandbox or a shim that cannot see sensors.

So:

| Tier | Runs | Authority | Isolation |
|---|---|---|---|
| **Shim** `steadwell-shim.service` | reviewed, small, fixed code: subscribe to selected topics, pack frames, POST to the gateway | none | filesystem-protected, outbound-only, no writes outside its state dir |
| **Jobs** `steadwell-job-<id>` | arbitrary test code from this repository | none | strict: no `/agibot`, no devices, no loopback, no ROS, network only to the gateway, capped, TTL |

The shim is the only component that speaks ROS 2. Jobs never do. A job that needs sensor data
asks the shim or the gateway; it cannot reach the DDS graph.

## 3. Runtime

A dedicated unprivileged account and three directories:

```
/var/lib/steadwell/
├── inbox/      uploaded artifacts, verified then moved
├── jobs/<id>/  extracted job, the only writable path
├── state/      shim cursors and last-known offsets
└── models/     weights, read-only to jobs
```

Transient unit, no enablement, no persistence:

```sh
systemd-run --unit=steadwell-job-$ID --slice=steadwell.slice \
  --uid=steadwell --gid=steadwell \
  --working-directory=/var/lib/steadwell/jobs/$ID \
  -p NoNewPrivileges=yes \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p PrivateDevices=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
  -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
  -p RestrictAddressFamilies="AF_INET AF_INET6" \
  -p IPAddressAllow=192.168.4.138 -p IPAddressDeny=any \
  -p MemoryMax=4G -p CPUQuota=200% -p IOWeight=10 -p TasksMax=256 \
  -p RuntimeMaxSec=900 \
  -p ReadWritePaths=/var/lib/steadwell/jobs/$ID \
  /var/lib/steadwell/jobs/$ID/run
```

| Property | Blocks |
|---|---|
| `NoNewPrivileges`, `RestrictSUIDSGID` | setuid escalation |
| `ProtectSystem=strict`, `ProtectHome` | writes outside the job dir; `/agibot` is read-only |
| `PrivateDevices` | cameras, motors, serial, GPU nodes |
| `RestrictAddressFamilies` | AF_UNIX/AF_NETLINK — no talking to local daemons |
| `IPAddressAllow=…138`, `IPAddressDeny=any` | all egress except the Mac gateway; loopback included. The address is this Mac's today — parameterise it in the profile, do not hard-code it in the job. |
| `MemoryMax`, `CPUQuota`, `IOWeight`, `TasksMax` | resource contention with motion control |
| `RuntimeMaxSec` | jobs cannot outlive their window |
| `MemoryDenyWriteExecute` | **not used** — breaks PyTorch/Java/Node JITs |

Two deliberate omissions: **no GPU** (`PrivateDevices`) and **no localhost**. A job that needs
either moves to a relaxed profile that is documented per job, not a global setting.

## 4. Artifact and deploy flow

```
Mac: build tar.zst + manifest.json (sha256, entrypoint, limits, ttl)
  → scp to /var/lib/steadwell/inbox/<id>/
  → sha256sum -c
  → extract to jobs/<id>
  → systemd-run (above)
  → journalctl -u steadwell-job-<id> -f
  → stop / expire → delete job dir, keep last N log digests
```

Proposed `sandboxctl` verbs: `push`, `run`, `logs`, `stop`, `ls`, `gc`. All use the existing SSH
key; no agent, no inbound port on the robot.

## 5. Data plane for distributed inference

Outbound only. The robot never opens a listening port.

```
shim (ROS 2) ── pack ──▶ POST/WS to gateway ──▶ Mac / Runpod
                                                │
console ◀── annotations ◀── results ◀───────────┘
```

| Stream | Rate | Notes |
|---|---|---|
| LiDAR | 2,200 pts × 12 B × 10 Hz ≈ **264 KB/s** | binary channel already implemented ([gateway](gateway.md) §10) |
| Camera 640×480 JPEG q70 @ 10 Hz | ~0.3–0.6 MB/s | downscale on the shim; never raw 1280×720 |
| Camera 1280×720 H.264 | ~1–2 Mbit/s | needs an encoder; experimental topic exists upstream |
| IMU | 200 Hz, ~100 B/s | trivial |

Results are annotations (boxes, labels, poses) or job parameters. They are **not** commands: the
gateway's motion gates remain the only path to actuation, and they are closed.

### Gateway reachability

The Mac gateway binds `127.0.0.1` by default. For the robot to push frames, it must listen on the
LAN:

```sh
GATEWAY_TOKEN=$(openssl rand -hex 24) node gateway/server.mjs --host 0.0.0.0 --token "$GATEWAY_TOKEN"
```

Then restrict port 8788 to the robot's subnet with the macOS firewall, and never expose it to the
internet. A token is mandatory here: presence and LiDAR ingest accept any authenticated client,
and the gateway does not otherwise restrict who may publish. Treat LAN binding as a reviewed
change, not a convenience.

## 6. Threat model and failure modes

| Risk | Mitigation | Residual |
|---|---|---|
| Test code touches factory software | `ProtectSystem=strict`, no `/agibot` writes, unprivileged user | read access to world-readable files |
| Test code talks to motion services | no AF_UNIX, loopback denied, only gateway IP | shim runs outside this profile by design |
| CPU/IO starvation affects control | `CPUQuota`, `IOWeight=10`, `MemoryMax` | no real-time guarantee; never run heavy jobs while walking |
| Runaway job | `RuntimeMaxSec`, `systemctl stop`, watchdog | needs access to stop it |
| Data exfiltration | single allowed IP, no DNS/FQDN egress | gateway is trusted |
| Sandbox escape | systemd hardening, no devices, no privileges | kernel exploit out of scope |

The sandbox is **not** a safety mechanism. The factory e-stop is the only certified stop; motion
authority stays with leases and adapter gates ([safety](safety.md)).

## 7. First three jobs, in order

1. **Read-only Lidar shim.** Subscribe to `/aima/hal/lidar/neck/pointcloud`, pack xyz, POST to
   the gateway. Success = the viewer on the Mac shows the real room at 10 Hz.
2. **Camera shim.** Downscale to 640×480, JPEG/H.264, same outbound path. Success = a live feed
   in the dashboard without opening a port on the robot.
3. **Inference client.** Consume the stream on the Mac, return annotations to the console.
   Success = labels on frames with no path to actuation.

Each job starts read-only, runs with a human watching, and has a stop command tested before it
starts.

## 8. Open questions

- **Where does compute live?** ORIN (GPU, always-on) vs X86 (AimMaster, face, audio) vs Mac vs
  Runpod. Placement decides device access and therefore the profile.
- **Does `agi` have sudo?** The installer needs it once. Unknown since the lockout.
- **DDS transport.** Fast DDS profile, domain 232, possible shared memory/iceoryx. The shim needs
  the exact environment from the X86 (`ROS_DOMAIN_ID`, `FASTRTPS_DEFAULT_PROFILES_FILE`).
- **Disk budget** for models and job artifacts; no quota design yet.
- **systemd version** on the X86 (Ubuntu 22.04 ships 249; all properties above exist).
- **Camera encoding** path and CPU cost on the X86 vs ORIN.
- **Does the robot survive a job being killed mid-write?** All job writes are confined to
  `/var/lib/steadwell/jobs/<id>`; the answer should be yes, and it needs a test.

## 9. First-run checklist (when access returns)

1. `id -un; hostname; uptime; systemctl --version`.
2. Confirm `agi` has sudo; create `steadwell` user and directories.
3. Install the shim unit, run it with `--dry-run` (print frames, no POST).
4. Start the lidar shim; watch the [gateway](gateway.md) viewer and `journalctl` together.
5. Kill the unit; confirm the viewer goes stale and no frames arrive.
6. Only then run a first user job with a 60 s TTL and no network.
