// Minimal, zero-dependency, standards-compliant QR Code (Byte mode, ECC Level M, Versions 1..6) SVG renderer.
// Works completely offline on local venue Wi-Fi stations with zero third-party requests.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data, eccLen) {
  const gen = rsGeneratorPoly(eccLen);
  const rem = new Array(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < eccLen; i++) {
        rem[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return rem;
}

// Version specs for ECC Level M (supports URLs up to 106 UTF-8 bytes cleanly)
const VERSION_M = [
  null,
  { size: 21, totalCodewords: 26, ecPerBlock: 10, blocks: 1, dataCap: 14, align: [] },
  { size: 25, totalCodewords: 44, ecPerBlock: 16, blocks: 1, dataCap: 26, align: [6, 18] },
  { size: 29, totalCodewords: 70, ecPerBlock: 26, blocks: 1, dataCap: 42, align: [6, 22] },
  { size: 33, totalCodewords: 100, ecPerBlock: 18, blocks: 2, dataCap: 62, align: [6, 26] },
  { size: 37, totalCodewords: 134, ecPerBlock: 24, blocks: 2, dataCap: 84, align: [6, 30] },
  { size: 41, totalCodewords: 172, ecPerBlock: 16, blocks: 4, dataCap: 106, align: [6, 34] },
];

// Precomputed 15-bit format info for ECC Level M (00) + mask 0..7 with BCH + XOR 0x5412
const FORMAT_BITS_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

function encodeByteStream(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let ver = 1;
  while (ver < VERSION_M.length && bytes.length > VERSION_M[ver].dataCap) ver += 1;
  if (ver >= VERSION_M.length) throw new Error('QR payload exceeds max length (106 bytes)');
  const spec = VERSION_M[ver];
  const dataCodewords = spec.totalCodewords - spec.ecPerBlock * spec.blocks;

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, dataCodewords * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  while (cw.length < dataCodewords) {
    cw.push(pads[pi % 2]);
    pi += 1;
  }

  // Split into RS blocks & interleave
  const perBlock = Math.floor(dataCodewords / spec.blocks);
  const dataBlocks = [];
  const eccBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const slice = cw.slice(b * perBlock, (b + 1) * perBlock);
    dataBlocks.push(slice);
    eccBlocks.push(rsComputeEcc(slice, spec.ecPerBlock));
  }

  const finalBytes = [];
  for (let i = 0; i < perBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) finalBytes.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) finalBytes.push(eccBlocks[b][i]);
  }

  return { ver, spec, finalBytes };
}

export function generateQrMatrix(text) {
  const { spec, finalBytes } = encodeByteStream(text);
  const n = spec.size;
  const grid = Array.from({ length: n }, () => new Int8Array(n)); // 0 empty, 1 dark, -1 light
  const fixed = Array.from({ length: n }, () => new Uint8Array(n));

  const setFixed = (r, c, dark) => {
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    grid[r][c] = dark ? 1 : -1;
    fixed[r][c] = 1;
  };

  const drawFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFixed(r0 + r, c0 + c, inOuter && (border || core));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  for (const r0 of spec.align) {
    for (const c0 of spec.align) {
      if (fixed[r0][c0]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setFixed(r0 + r, c0 + c, dark);
        }
      }
    }
  }

  // Reserve format info cells & dark module
  for (let i = 0; i < 9; i++) {
    if (!fixed[8][i]) setFixed(8, i, false);
    if (!fixed[i][8]) setFixed(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!fixed[8][n - 1 - i]) setFixed(8, n - 1 - i, false);
    if (!fixed[n - 1 - i][8]) setFixed(n - 1 - i, 8, false);
  }
  setFixed(n - 8, 8, true);

  // Place data bits in zigzag columns
  const bitStream = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) bitStream.push((b >>> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (fixed[r][c]) continue;
        const bit = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0;
        // Use Mask 0: (r + c) % 2 === 0
        const masked = ((r + c) % 2 === 0) ? (bit ^ 1) : bit;
        grid[r][c] = masked ? 1 : -1;
      }
    }
    upward = !upward;
  }

  // Write format info for ECC M + Mask 0
  const fmt = FORMAT_BITS_M[0];
  const fBit = (i) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFixed(i, 8, fBit(i));
  setFixed(7, 8, fBit(6));
  setFixed(8, 8, fBit(7));
  setFixed(8, 7, fBit(8));
  for (let i = 9; i < 15; i++) setFixed(8, 14 - i, fBit(i));
  for (let i = 0; i < 8; i++) setFixed(8, n - 1 - i, fBit(i));
  for (let i = 8; i < 15; i++) setFixed(n - 15 + i, 8, fBit(i));

  return grid.map((row) => Array.from(row, (v) => v === 1));
}

export function renderQrSvg(text, { fg = '#05080f', bg = '#f8fafc', quiet = 3, className = '' } = {}) {
  const matrix = generateQrMatrix(text);
  const n = matrix.length;
  const viewSize = n + quiet * 2;
  const rects = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        rects.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="QR code to join room"${className ? ` class="${className}"` : ''}><rect width="${viewSize}" height="${viewSize}" rx="2" fill="${bg}"/><path d="${rects.join('')}" fill="${fg}"/></svg>`;
}
