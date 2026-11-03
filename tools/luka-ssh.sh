#!/bin/sh
# luka-ssh.sh — read-only access checks for Luka, with an explicit manifest.
#
#   sh tools/luka-ssh.sh --explain     what each subcommand does, and does not do
#   sh tools/luka-ssh.sh check         is TCP/22 answering?
#   sh tools/luka-ssh.sh discover      find Luka's MAC on the local subnet (bounded ICMP)
#   sh tools/luka-ssh.sh auth          can we authenticate as `agi`?
#   sh tools/luka-ssh.sh inventory     read-only interface inventory
#
# The password is read from LUKA_SSH_PASSWORD or prompted for. It is never a
# command-line argument (shell history), never written to disk, and never
# echoed. `password.md` inside the vendor archive stays unopened: a third-party
# mirror is not a trustworthy source for a credential.
#
# Nothing here writes, installs, restarts, or changes a setting on the robot.
# Every remote command is listed by --explain before it can run.

set -eu

HOST=${LUKA_HOST:-192.168.4.136}
USER_NAME=${LUKA_USER:-agi}
SSH_KEY=${LUKA_SSH_KEY:-}
ROBOT_MAC=${LUKA_MAC:-ac:45:ef}
BOOT_WAIT_NOTE="Luka answers ICMP/SSH ~40 s after power-on and 56322 at ~85 s. A half-booted robot looks dead."

# Remote commands, kept in one place so --explain and execution cannot drift.
INVENTORY='
printf "== identity ==\n"; id; hostname; uname -a; uptime
printf "== os ==\n"; head -6 /etc/os-release 2>/dev/null
printf "== addresses ==\n"; ip -4 -o addr show 2>/dev/null | head -20
printf "== listening ==\n"; ss -ltn 2>/dev/null | head -30
printf "== ros environment ==\n"; env | grep -iE "ROS|DDS|RMW" | head -20; command -v ros2 || echo "ros2: not on PATH"
printf "== running services ==\n"; systemctl list-units --type=service --state=running 2>/dev/null | grep -iE "aim|robot|mc|ros|motion" | head -20
printf "== /opt ==\n"; ls -1 /opt 2>/dev/null | head -20
printf "== home ==\n"; ls -1 "$HOME" 2>/dev/null | head -20
'

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

explain() {
  cat <<EOF
luka-ssh.sh — manifest

Target      $HOST (port 22), account "$USER_NAME"
Transport   ssh with SSH_ASKPASS (no pty), ConnectTimeout 6 s, one password attempt
Credential  LUKA_SSH_KEY (preferred) → ssh -i, BatchMode, no prompt.
            LUKA_SSH_PASSWORD (fallback) from the environment or a prompt;
            never argv, never echoed, never logged.

Subcommands

  check       nc -z against port 22. No login, no remote command.
  discover    one ICMP echo to every address in each /24 this Mac's netmask covers,
              then reads the ARP table for Luka's vendor MAC (${ROBOT_MAC}). Read-only;
              needs --yes because it touches the whole subnet. Use it when DHCP has
              moved him off .136.
  auth        ssh ... "id -un" — one command, proves the credential.
  inventory   ssh ... with the read-only command list below.

Remote commands used by inventory (verbatim, in order):

$(printf '%s\n' "$INVENTORY" | sed '/^$/d; s/^/    /')

Installed or changed by this script: nothing. No sudo. No package manager.
No service control. No writes to the robot filesystem.

Credential note: the operator's password is weak. Keep Luka on an isolated
network, prefer key auth, and change the password through the manufacturer's
supported path when commissioning allows. This script never stores it.

Known limitation: a Wi-Fi subnet change breaks reachability before it breaks
the credential. Check the Mac's address against the robot's subnet first:

    ipconfig getifaddr en0        # this Mac
    ping -c 2 $HOST

$BOOT_WAIT_NOTE
EOF
}

askpass_init() {
  # expect needs a pty, and this host ran out of them ("no more ptys"), which
  # made an earlier version report success without ever authenticating. SSH's
  # own askpass hook needs no pty at all.
  ASKPASS=$(mktemp "${TMPDIR:-/tmp}/luka-askpass.XXXXXX")
  chmod 700 "$ASKPASS"
  printf '#!/bin/sh\nprintf "%%s\\n" "$LUKA_SSH_PASSWORD"\n' > "$ASKPASS"
  trap 'rm -f "$ASKPASS"' EXIT INT TERM
}

read_password() {
  if [ -n "${LUKA_SSH_PASSWORD:-}" ]; then
    export LUKA_SSH_PASSWORD
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "LUKA_SSH_PASSWORD is unset and stdin is not a terminal" >&2
    exit 78
  fi
  printf 'SSH password for %s@%s: ' "$USER_NAME" "$HOST" >&2
  stty -echo
  IFS= read -r LUKA_SSH_PASSWORD
  stty echo
  printf '\n' >&2
  export LUKA_SSH_PASSWORD
}

run_remote() {
  if [ -n "$SSH_KEY" ]; then
    # Key auth: no password, no askpass, no prompt. This is the supported path
    # on the installed image (password auth is disabled there).
    ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=6 \
        "$USER_NAME@$HOST" "$1"
    return $?
  fi

  read_password
  askpass_init
  SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-:0}" \
    ssh -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=6 \
        -o NumberOfPasswordPrompts=1 \
        -o PreferredAuthentications=password,keyboard-interactive \
        -o PubkeyAuthentication=no \
        "$USER_NAME@$HOST" "$1"
}

case "${1:-}" in
  --explain|explain)
    explain
    ;;
  discover)
    if [ "${2:-}" != "--yes" ]; then
      if [ -t 0 ]; then
        printf 'Send one ICMP echo to every address in the local subnets and read the ARP table? [y/N] '
        IFS= read -r answer
        case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
      else
        echo "discover needs --yes when stdin is not a terminal" >&2
        exit 64
      fi
    fi
    scan_ip=$(ipconfig getifaddr en0 2>/dev/null || true)
    if [ -z "$scan_ip" ]; then
      echo "en0 has no IPv4 address; join the robot's network first" >&2
      exit 69
    fi
    prefix=$(printf '%s' "$scan_ip" | cut -d. -f1-2)
    third=$(printf '%s' "$scan_ip" | cut -d. -f3)
    mask=$(ifconfig en0 2>/dev/null | sed -n 's/.*netmask 0x\([0-9a-f]*\).*/\1/p' | head -1)
    case "$mask" in
      fffffc00) blocks=4 ;;
      fffffe00) blocks=2 ;;
      fffff800) blocks=8 ;;
      *)        blocks=1 ;;
    esac
    start=$((third - (third % blocks)))
    echo "interface $scan_ip · netmask 0x${mask:-unknown} · scanning $prefix.$start.0/24 through $prefix.$((start + blocks - 1)).0/24 for $ROBOT_MAC ..."
    b=0
    while [ "$b" -lt "$blocks" ]; do
      net=$((start + b))
      i=1
      while [ "$i" -le 254 ]; do
        ping -c 1 -W 200 "$prefix.$net.$i" >/dev/null 2>&1 &
        if [ $((i % 64)) -eq 0 ]; then wait; fi
        i=$((i + 1))
      done
      wait
      b=$((b + 1))
    done
    found=$(arp -an 2>/dev/null | grep -i "$ROBOT_MAC" || true)
    if [ -n "$found" ]; then
      echo "$found"
      foundip=$(printf '%s' "$found" | sed -n 's/.*(\([0-9.]*\)).*/\1/p' | head -1)
      [ -n "$foundip" ] && echo "found: $foundip — try  LUKA_HOST=$foundip sh tools/luka-ssh.sh auth"
    else
      echo "not found on $prefix.$start.0/24 through $prefix.$((start + blocks - 1)).0/24."
      echo "He is off, on another segment, or not yet through the ~40 s boot window." >&2
      exit 1
    fi
    ;;
  check)
    echo "checking $HOST:22 (no login)…"
    if nc -z -G 3 -w 3 "$HOST" 22 >/dev/null 2>&1; then
      echo "port 22: open"
    else
      echo "port 22: unreachable"
      echo "$BOOT_WAIT_NOTE" >&2
      echo "Also confirm this Mac is on the robot's subnet: ipconfig getifaddr en0" >&2
      exit 69
    fi
    ;;
  auth)
    echo "authenticating as $USER_NAME@$HOST (runs: id -un)…"
    rc=0
    run_remote 'id -un' || rc=$?
    case "$rc" in
      0) echo "auth: ok" ;;
      77) echo "auth: refused (wrong password, or the account is not $USER_NAME)" >&2 ;;
      69) echo "auth: host unreachable" >&2 ;;
      255) echo "auth: ssh failed — check the server's offered methods above" >&2 ;;
      *) echo "auth: ssh exited $rc" >&2 ;;
    esac
    exit "$rc"
    ;;
  inventory)
    echo "read-only inventory as $USER_NAME@$HOST ..."
    run_remote "$INVENTORY"
    ;;
  ""|-h|--help|help)
    usage
    echo
    echo "Run 'sh tools/luka-ssh.sh --explain' for the full manifest."
    ;;
  *)
    echo "unknown subcommand: $1" >&2
    usage >&2
    exit 64
    ;;
esac
