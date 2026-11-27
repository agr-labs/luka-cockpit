#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VENV=${LUKA_FACE_VENV:-"$ROOT/.venv-face-follow"}
BASE_PYTHON=${LUKA_FACE_PYTHON_BASE:-}
MODEL_DIR="$ROOT/models"
MODEL="$MODEL_DIR/face_detection_yunet_2023mar.onnx"
MODEL_URL="https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

if [ -z "$BASE_PYTHON" ]; then
  for candidate in python3.12 python3.11 python3.10 python3.9; do
    if command -v "$candidate" >/dev/null 2>&1; then BASE_PYTHON=$(command -v "$candidate"); break; fi
  done
fi
if [ -z "$BASE_PYTHON" ]; then
  echo "Face follow needs Python 3.9–3.12; set LUKA_FACE_PYTHON_BASE to an installed interpreter." >&2
  exit 1
fi

if [ -x "$VENV/bin/python" ]; then
  VENV_VERSION=$("$VENV/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  BASE_VERSION=$("$BASE_PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  if [ "$VENV_VERSION" != "$BASE_VERSION" ]; then
    echo "The existing face-follow environment uses Python $VENV_VERSION; remove $VENV and rerun setup with Python $BASE_VERSION." >&2
    exit 1
  fi
fi
if [ ! -x "$VENV/bin/python" ]; then
  "$BASE_PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install -r "$ROOT/tools/face-follow-requirements.txt"
mkdir -p "$MODEL_DIR"
if [ ! -s "$MODEL" ]; then
  curl -fL "$MODEL_URL" -o "$MODEL"
fi
printf 'Face follow ready: %s\n' "$MODEL"
