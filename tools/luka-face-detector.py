#!/usr/bin/env python3
"""Detect the largest visible face in length-framed JPEGs; never save images or identities."""
import json
import struct
import sys

import cv2
import numpy as np

INPUT_SIZE = 320
MIN_FRAME_BYTES = 256
MAX_FRAME_BYTES = 4 * 1024 * 1024
CONFIDENCE = 0.78


def read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            if not data:
                return None
            raise EOFError("partial JPEG frame")
        data.extend(chunk)
    return bytes(data)


def emit_frame(detector, frame, sequence):
    height, width = frame.shape[:2]
    scale = min(INPUT_SIZE / width, INPUT_SIZE / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    resized = cv2.resize(frame, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    pad_x = (INPUT_SIZE - resized_width) // 2
    pad_y = (INPUT_SIZE - resized_height) // 2
    canvas = cv2.copyMakeBorder(
        resized,
        pad_y,
        INPUT_SIZE - resized_height - pad_y,
        pad_x,
        INPUT_SIZE - resized_width - pad_x,
        cv2.BORDER_CONSTANT,
        value=(0, 0, 0),
    )
    _, faces = detector.detect(canvas)
    face = None
    if faces is not None and len(faces):
        candidates = [row for row in faces if float(row[14]) >= CONFIDENCE]
        if candidates:
            face = max(candidates, key=lambda row: float(row[2] * row[3]))
    if face is None:
        message = {"sequence": sequence, "present": False}
    else:
        x = (float(face[0]) + float(face[2]) / 2 - pad_x) / resized_width
        y = (float(face[1]) + float(face[3]) / 2 - pad_y) / resized_height
        message = {
            "sequence": sequence,
            "present": True,
            "x": max(0.0, min(1.0, x)),
            "y": max(0.0, min(1.0, y)),
            "confidence": float(face[14]),
            "area": max(0.0, float(face[2] * face[3]) / (INPUT_SIZE * INPUT_SIZE)),
        }
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: luka-face-detector.py MODEL.onnx")
    cv2.setNumThreads(1)
    detector = cv2.FaceDetectorYN.create(
        sys.argv[1],
        "",
        (INPUT_SIZE, INPUT_SIZE),
        CONFIDENCE,
        0.30,
        5000,
    )
    stream = sys.stdin.buffer
    sequence = 0
    while True:
        header = read_exact(stream, 4)
        if header is None:
            return
        size = struct.unpack("!I", header)[0]
        if not MIN_FRAME_BYTES <= size <= MAX_FRAME_BYTES:
            raise ValueError("decoded camera frame size is outside limits")
        encoded = read_exact(stream, size)
        if encoded is None:
            return
        frame = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
        sequence += 1
        if frame is None:
            sys.stdout.write(json.dumps({"sequence": sequence, "present": False}) + "\n")
            sys.stdout.flush()
            continue
        emit_frame(detector, frame, sequence)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"face detector: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
