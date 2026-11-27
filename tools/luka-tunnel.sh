#!/bin/sh
# Tunnel Luka's AimDK (x86 192.168.100.100:56322) to 127.0.0.1:56322
# through the LAN jump host. Uses the SSH agent; lukakey is not required on
# the jump. Keep this running while the cockpit/gateway mirror Luka.
set -eu
JUMP=${LUKA_JUMP:-agi@192.168.4.152}
TARGET=${LUKA_TARGET:-agi@192.168.100.110}
AIMDK=${LUKA_AIMDK:-192.168.100.100:56322}
KEY=${LUKA_SSH_KEY:-$HOME/.ssh/lukakey}
KEYARG=""
[ -f "$KEY" ] && KEYARG="-i $KEY"
exec ssh -N $KEYARG \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=20 \
  -o ServerAliveCountMax=3 \
  -L "127.0.0.1:56322:${AIMDK}" \
  -J "$JUMP" "$TARGET"
