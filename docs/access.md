# Access — Luka

Operational access state, the 2026-11-03 lockout, and the recovery ladder.

**Current status: SSH is key-only, and no authorised key is on this Mac.** The robot is
reachable (`192.168.4.136`, ICMP + ports 22/56322/56444/59001/5000) but no shell is available.
The HTTP read path is unaffected.

---

## 1. Verified state (2026-11-03)

| Item | Value |
|---|---|
| SSH banner | `SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10` |
| Auth methods — `agi`, `ubuntu`, `root` | **`publickey` only** for all three → global config, not a per-user rule |
| Host key vs `known_hosts.old` (Oct 27) | **identical** (`SHA256:TRPDWlDSY…`) → the robot was not reimaged |
| Last host-key write | `known_hosts` mtime **2026-11-02 19:50** (the last connection we can date) |
| Local key `id_hbed25519` | rejected (`Permission denied (publickey)`) |
| `ssh-add -l` (launchd agent) | no identities |
| `~/.ssh/agent/*` sockets | stale; `ssh-add` against them hangs |
| Shell history | `ssh-copy-id agi@192.168.4.136`, then *"now runs key-auth, non-root"* |

The probe script that was piped into the robot (`tools/onrobot-probe.sh`) contains no `sshd`,
`authorized_keys` or password changes, and no commit in this repository ever contained
`PasswordAuthentication`.

## 2. What happened

The robot is in a persisted **key-only** state. Host keys are unchanged across the last known
connection, so this is not a reinstall. The key installed on Oct 27 is not present on this Mac
in any form we can find: not in `~/.ssh`, not in the login agent, and the forwarded-agent
sockets are dead.

Two readings fit the evidence, and the robot's logs are needed to separate them:

1. Last night's login used a key held by an agent or another machine that is no longer
   available — not a password.
2. Password auth was enabled then and something disabled it afterwards (an update, a hardening
   step, or a deployment-mode change), and the reboot made the persisted key-only state
   effective.

What is certain: nothing on this side modified the robot's SSH configuration. Every interaction
from here has been HTTP reads plus client-side `ssh` attempts.

## 3. Recovery ladder

### 3.1 Local console — preferred

`PasswordAuthentication no` affects SSH only. A monitor and USB keyboard on the X86 can still
log in locally with the account password, provided the account has one. Then install a key; do
not turn password auth back on.

A dedicated key already exists at `.secrets/luka_ed25519` (gitignored, mode 600), fingerprint:

```
SHA256:IkCc3ipYB8Sydzwu7dPIgrGYL8dtXIK4WUB8e2OwATo  steadwell-luka-20261103
```

As `agi` on the console:

```sh
install -d -m 700 ~/.ssh
cat >> ~/.ssh/authorized_keys    # paste the contents of .secrets/luka_ed25519.pub
chmod 600 ~/.ssh/authorized_keys
```

If the console session is `ubuntu`, write it for `agi` instead:

```sh
sudo -u agi install -d -m 700 /home/agi/.ssh
sudo -u agi tee -a /home/agi/.ssh/authorized_keys   # paste, then Ctrl-D
sudo -u agi chmod 600 /home/agi/.ssh/authorized_keys
```

Verify from the Mac:

```sh
ssh -i .secrets/luka_ed25519 -o IdentitiesOnly=yes agi@192.168.4.136 'id -un; hostname'
# or, once the tool's key path is available:
LUKA_SSH_KEY=.secrets/luka_ed25519 sh tools/luka-ssh.sh auth
```

### 3.2 Rear debug port — no auth bypass

The runbook lists `192.168.2.50` over Ethernet; this Mac has Ethernet adapters (`en2`, `en3`). It
does **not** bypass a key-only daemon, but it may expose a different interface, a console, or a
service that the Wi-Fi interface does not. Treat it as a path to a console, not to a shell.

### 3.3 ORIN access point — untested

Joining `Robot-…` and reaching `192.168.88.88` talks to the ORIN, which has its own sshd and may
not share the X86's hardening. Never tried; do not assume it will accept a password.

### 3.4 Manufacturer

AGIBOT support can re-provision access or confirm the intended key-only policy. This is the
non-destructive escalation path if no console is available.

### 3.5 Do not

- Re-enable `PasswordAuthentication` globally "just to get in" and leave it.
- Brute-force or enumerate accounts.
- Edit `sshd_config` without a console fallback open.
- Assume the Oct 27 key is gone from the robot — it may still be authorised for a key we no
  longer hold.

## 4. Once access is restored

1. Record the effective config, do not change it blindly:

   ```sh
   sudo sshd -T | grep -E 'passwordauthentication|pubkeyauthentication|allowusers|authenticationmethods'
   ```

2. Run the read-only inventory:

   ```sh
   LUKA_SSH_KEY=.secrets/luka_ed25519 sh tools/luka-ssh.sh auth
   LUKA_SSH_KEY=.secrets/luka_ed25519 sh tools/luka-ssh.sh inventory
   ```
3. Confirm whether the Oct 27 key is still in `/home/agi/.ssh/authorized_keys`; remove unknown
   entries only after recording them.
4. Keep key-only. If a break-glass password is re-enabled for one session, revert it immediately
   and record the window in this file.
5. Append the findings to §1 so the next lockout starts from facts.

## 5. Why this gates the roadmap

No key → no process on the robot → no ROS 2 bridge → no LiDAR, no camera stream, no arm
command, no robot-side sandbox ([sandbox](sandbox.md)). The entire read-only surface is what we
have until access returns.
