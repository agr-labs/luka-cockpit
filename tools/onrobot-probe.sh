#!/bin/sh
# onrobot-probe.sh — v2 (bounded, read-only inspection of Luka / A2 Ultra)
#
# Run ON Luka. Copies of this file should be reviewed before execution:
#   sh onrobot-probe.sh --explain      # print exactly what it does, run nothing
#   sh onrobot-probe.sh                # perform the inspection
#
# WHAT IT DOES — every action below is a read:
#   * prints kernel/OS identity                    (uname, /etc/os-release)
#   * prints version files under /opt/agibot, /etc (cat/head, truncated)
#   * lists listening sockets                      (ss -tulpn, read-only)
#   * locates .proto / *_pb2 / aimdk package dirs  (find, bounded to 6 levels
#                                                   under /opt /usr/local
#                                                   /usr/lib/python3* /home /etc)
#   * prints matching process lines                (ps, read-only)
#   * optionally, with PROBE_ROS=1, sources the ROS 2 setup and lists topics
#
# WHAT IT DELIBERATELY DOES NOT DO:
#   * no file creation, modification or deletion; no redirects to disk
#   * no RPC of any kind — it never contacts 56322 or any AimDK service
#   * no service start/stop/restart, no systemctl, no chmod/chown
#   * no ROS configuration change, no ros2 daemon start
#   * no `import` of vendor Python modules (v1 did; that executes their code)
#   * no mutation of the invoking shell's environment (v1 sourced setup.bash)
#
# Root is not required. `ss -p` simply omits process names for other users'
# sockets when run unprivileged; every section still produces output.

set -u

# Portable bounded execution: `timeout` is GNU/coreutils and absent on macOS,
# so every long-running read goes through this instead of failing silently.
bounded() {
  secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else "$@"
  fi
}

MANIFEST() {
  cat <<'TXT'
onrobot-probe.sh — planned actions, in order:

 1. uname -a ; cat /etc/os-release (head -4) ; hostname ; uptime        read
 2. head -20 of /opt/agibot/*/version* /opt/agibot/VERSION* /etc/agibot* read
    ls -1 /opt                                                          read
 3. ss -tulpn (falls back to netstat -tulpn)                           read
 4. pip3 show -f aimdk ; ls of its site-packages directory              read
    (no `import aimdk` — locating a package must not execute it)
 5. bounded find for *.proto / *_pb2*.py under five roots, then
    grep 'service|package|rpc' from up to 20 hits                       read
 6. ps -eo pid,comm,args  | grep for mc|rc_|motion|aim|agibot           read
 7. ss -tulpn | grep 56322                                              read

Not performed: any RPC, any write, any service control, any ROS daemon
start, any vendor module import, any environment mutation.
Optional section 8 (PROBE_ROS=1) sources /opt/ros/*/setup.bash and runs
`ros2 topic list` / `ros2 service list`; it is skipped by default because
sourcing vendor shell init and joining the DDS graph is not a pure read.
TXT
}

case "${1:-}" in
  --explain|-n) MANIFEST; exit 0 ;;
esac

echo "===== 1. identity ====="
uname -a
head -4 /etc/os-release 2>/dev/null
echo "hostname: $(hostname 2>/dev/null)"
echo "uptime: $(uptime 2>/dev/null)"

echo
echo "===== 2. robot software / versions ====="
for f in /opt/agibot/*/version* /opt/agibot/VERSION* /etc/agibot*; do
  if [ -f "$f" ]; then echo "--- $f"; head -20 "$f"; fi
done 2>/dev/null
echo "--- /opt entries"
ls -1 /opt 2>/dev/null | head -20

echo
echo "===== 3. listening sockets ====="
if command -v ss >/dev/null 2>&1; then
  ss -tulpn 2>/dev/null | head -40
else
  netstat -tuln 2>/dev/null | head -40
fi

echo
echo "===== 4. aimdk python package (located, not imported) ====="
if command -v pip3 >/dev/null 2>&1; then
  bounded 20 pip3 show -f aimdk 2>/dev/null | head -15
  bounded 20 pip3 list 2>/dev/null | grep -iE "aimdk|agibot|agv|grpc" | head -10
fi
for d in /usr/lib/python3/dist-packages/aimdk /usr/local/lib/python3*/dist-packages/aimdk \
         /usr/local/lib/python3*/site-packages/aimdk /opt/*/lib/python3*/site-packages/aimdk; do
  if [ -d "$d" ]; then echo "--- dir $d"; ls -1 "$d" 2>/dev/null | head -30; fi
done

echo
echo "===== 5. proto / interface definitions (bounded) ====="
echo "--- *.proto under five roots, maxdepth 6"
for root in /opt /usr/local /usr/lib/python3* /home /etc; do
  [ -d "$root" ] || continue
  bounded 20 find "$root" -maxdepth 6 -name '*.proto' 2>/dev/null
done | grep -iE "aimdk|agibot|mc|hal|robot" | head -40
echo "--- services declared in matching protos"
for f in $(for root in /opt /usr/local /usr/lib/python3* /home /etc; do
             [ -d "$root" ] || continue
             bounded 20 find "$root" -maxdepth 6 -name '*.proto' 2>/dev/null
           done | grep -iE "aimdk|agibot" | head -20); do
  echo "### $f"
  grep -nE "^[[:space:]]*(service|package|rpc)[[:space:]]" "$f" | head -40
done

echo
echo "--- generated stubs and package directories"
for root in /opt /usr/local /usr/lib/python3* /home; do
  [ -d "$root" ] || continue
  bounded 20 find "$root" -maxdepth 6 \( -name "*_pb2*.py" -o -type d -name "aimdk*" \) 2>/dev/null
done | head -30

echo
echo "===== 6. process map ====="
ps -eo pid,comm,args 2>/dev/null | grep -iE "mc|rc_|motion|robot|aim|agibot" \
  | grep -v grep | head -25

echo
echo "===== 7. owner of port 56322 ====="
ss -tulpn 2>/dev/null | grep 56322 || echo "56322 not in socket list"

if [ "${PROBE_ROS:-0}" = "1" ]; then
  echo
  echo "===== 8. ROS 2 surface (PROBE_ROS=1: sources vendor setup, joins DDS) ====="
  if command -v ros2 >/dev/null 2>&1; then
    for s in /opt/ros/*/setup.bash; do
      if [ -f "$s" ]; then echo "--- sourcing $s (subshell only)"; . "$s"; break; fi
    done
    echo "--- topics"; bounded 20 ros2 topic list 2>/dev/null | head -60
    echo "--- services"; bounded 20 ros2 service list 2>/dev/null | grep -iE "arm|joint|servo|mc|rc" | head -40
  else
    echo "ros2 CLI not on PATH; nothing sourced"
  fi
else
  echo
  echo "===== 8. ROS 2 surface: SKIPPED (set PROBE_ROS=1 to enable) ====="
fi

echo
echo "===== DONE — no RPC was issued and nothing was written ====="
