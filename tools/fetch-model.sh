#!/bin/sh
# Restore the vendored AgiBot A2 model payloads that .gitignore excludes.
# Source: https://github.com/MDeanH/luka-a2-ultra-model (Mulan PSL v2)
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "cloning MDeanH/luka-a2-ultra-model (shallow)…"
git clone --depth 1 https://github.com/MDeanH/luka-a2-ultra-model.git "$TMP/repo"

mkdir -p "$HERE/model/urdf" "$HERE/model/meshes" "$HERE/model/mjcf" "$HERE/model/recordings"
cp "$TMP/repo/vendor/agibot_a2/urdf/agibot_a2_dof12.urdf" "$HERE/model/urdf/"
cp "$TMP/repo/vendor/agibot_a2/mjcf/agibot_a2_dof12.mjcf" "$HERE/model/mjcf/"
cp "$TMP/repo/vendor/agibot_a2/meshes/public/"*.stl "$HERE/model/meshes/"
cp "$TMP/repo/data/ipad-playback/recordings/"*.a2rec "$HERE/model/recordings/"
cp "$TMP/repo/vendor/agibot_a2/PROVENANCE.md" "$HERE/model/PROVENANCE.md"
cp "$TMP/repo/build/luka_as_is.report.md" "$HERE/model/BUILD_REPORT.md"
cp "$TMP/repo/model/measurements.csv" "$HERE/model/measurements.csv"
[ -f "$TMP/repo/LICENSE-MulanPSL2" ] && cp "$TMP/repo/LICENSE-MulanPSL2" "$HERE/model/"

echo "building generated model…"
node "$HERE/tools/build-model.mjs"
