#!/usr/bin/env python3
"""Read the robot's existing interactive-camera MQTT feed and frame it for SSH."""
import socket
import struct
import sys
import time

BROKER = ("127.0.0.1", 1883)
TOPIC = b"a2remote/camera/interactive/h264"
MAX_PACKET = 8 * 1024 * 1024


def remaining_length(value):
    output = bytearray()
    while True:
        digit = value % 128
        value //= 128
        if value:
            digit |= 0x80
        output.append(digit)
        if not value:
            return bytes(output)


def send_packet(sock, header, body=b""):
    sock.sendall(bytes((header,)) + remaining_length(len(body)) + body)


def read_exact(sock, size):
    result = bytearray()
    while len(result) < size:
        part = sock.recv(size - len(result))
        if not part:
            raise EOFError("MQTT broker closed the camera connection")
        result.extend(part)
    return bytes(result)


def read_packet(sock):
    header = read_exact(sock, 1)[0]
    multiplier = 1
    size = 0
    for _ in range(4):
        digit = read_exact(sock, 1)[0]
        size += (digit & 0x7F) * multiplier
        if not digit & 0x80:
            break
        multiplier *= 128
    else:
        raise ValueError("invalid MQTT remaining length")
    if size > MAX_PACKET:
        raise ValueError("MQTT camera packet is too large")
    return header, read_exact(sock, size)


def main():
    sock = socket.create_connection(BROKER, timeout=8)
    sock.settimeout(45)
    client_id = b"lukachat-face-follow"
    connect = b"\x00\x04MQTT\x04\x02\x00\x3c" + struct.pack("!H", len(client_id)) + client_id
    send_packet(sock, 0x10, connect)
    header, payload = read_packet(sock)
    if header >> 4 != 2 or len(payload) < 2 or payload[1] != 0:
        raise ConnectionError("MQTT camera subscription was refused")

    subscribe = struct.pack("!H", 17) + struct.pack("!H", len(TOPIC)) + TOPIC + b"\x00"
    send_packet(sock, 0x82, subscribe)
    header, _ = read_packet(sock)
    if header >> 4 != 9:
        raise ConnectionError("MQTT camera subscription was not acknowledged")

    last_ping = time.monotonic()
    output = sys.stdout.buffer
    while True:
        header, packet = read_packet(sock)
        packet_type = header >> 4
        if packet_type == 13:  # PINGRESP
            continue
        if packet_type != 3:  # PUBLISH
            continue
        if len(packet) < 2:
            continue
        topic_size = struct.unpack("!H", packet[:2])[0]
        cursor = 2 + topic_size
        if len(packet) < cursor:
            continue
        topic = packet[2:cursor]
        qos = (header >> 1) & 0x03
        if qos:
            if len(packet) < cursor + 2:
                continue
            packet_id = packet[cursor:cursor + 2]
            cursor += 2
            if qos == 1:
                send_packet(sock, 0x40, packet_id)
        if topic != TOPIC:
            continue
        frame = packet[cursor:]
        if not frame:
            continue
        output.write(struct.pack("!I", len(frame)))
        output.write(frame)
        output.flush()
        if time.monotonic() - last_ping >= 20:
            send_packet(sock, 0xC0)
            last_ping = time.monotonic()


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, EOFError, OSError):
        pass
    except Exception as error:
        print(f"camera MQTT worker: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
