// Minimal RFC 6455 WebSocket server: text frames, ping/pong, close, fragmented
// messages. No extensions, no compression, no binary payloads.
//
// Dependency-free on purpose — the rest of the repository has no npm tree, and
// a telemetry socket does not justify introducing one. Limits are explicit:
// 1 MiB per message, clients must mask, control frames must not fragment.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;
const PING_MS = 25_000;
const IDLE_MS = 70_000;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// Upgraded sockets leave the HTTP server's connection accounting, so
// server.closeAllConnections() does not reach them. Track them here instead.
const OPEN = new Set();

export function closeAllWebSockets() {
  for (const conn of [...OPEN]) conn.terminate();
}

export function attachWebSocket(server, handler) {
  server.on('upgrade', (req, socket) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return reject(socket, 400, 'bad request');
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key || version !== '13') {
      return reject(socket, 400, 'websocket handshake required');
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = new Connection(socket);
    OPEN.add(conn);
    try {
      handler(conn, req, url);
    } catch (err) {
      conn.close(1011, 'internal error');
      server.emit('clientError', err, socket);
    }
  });
}

function reject(socket, code, reason) {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragment = null;
    this.closed = false;
    this.lastSeen = Date.now();
    this.messageHandlers = [];
    this.closeHandlers = [];

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._finish());
    socket.on('close', () => this._finish());

    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > IDLE_MS) return this.close(1001, 'idle');
      this._frame(OP.PING, Buffer.alloc(0));
    }, PING_MS);
    this.pinger.unref?.();
  }

  onMessage(fn) { this.messageHandlers.push(fn); return this; }
  onClose(fn) { this.closeHandlers.push(fn); return this; }

  send(value) {
    if (this.closed) return false;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return this._frame(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  /** Binary frames carry lidar point clouds; the header is JSON, the rest is xyz. */
  sendBinary(buffer) {
    if (this.closed) return false;
    return this._frame(OP.BINARY, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._frame(OP.CLOSE, payload);
    this.socket.end();
    this.socket.destroySoon?.();
    this._finish();
  }

  terminate() {
    this.socket.destroy();
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    OPEN.delete(this);
    clearInterval(this.pinger);
    for (const fn of this.closeHandlers) { try { fn(); } catch { /* handler errors do not leak */ } }
    this.messageHandlers.length = 0;
  }

  _frame(opcode, payload) {
    if (this.closed && opcode !== OP.CLOSE) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      this._finish();
      return false;
    }
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'message too large');
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009, 'message too large');
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (this.buffer.length < offset + 4 + len) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + len);

      if (opcode === OP.PING) { this._frame(OP.PONG, payload); continue; }
      if (opcode === OP.PONG) continue;
      if (opcode === OP.CLOSE) { this.close(1000, ''); return; }
      if (opcode === OP.BINARY) { this.close(1003, 'binary frames unsupported'); return; }
      if (opcode === OP.TEXT || opcode === OP.CONT) {
        if (opcode === OP.CONT && !this.fragment) return this.close(1002, 'unexpected continuation');
        if (opcode === OP.TEXT && this.fragment) return this.close(1002, 'interleaved message');
        if (opcode === OP.TEXT) this.fragment = { chunks: [payload], size: payload.length };
        else {
          this.fragment.chunks.push(payload);
          this.fragment.size += payload.length;
        }
        if (this.fragment.size > MAX_MESSAGE) return this.close(1009, 'message too large');
        if (!fin) continue;
        const text = Buffer.concat(this.fragment.chunks).toString('utf8');
        this.fragment = null;
        for (const fn of this.messageHandlers) {
          try { fn(text); } catch { /* a bad handler must not kill the socket */ }
        }
        continue;
      }
      this.close(1002, `unknown opcode ${opcode}`);
      return;
    }
  }
}
