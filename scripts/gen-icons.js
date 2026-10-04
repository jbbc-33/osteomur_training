'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function makePng(size) {
  const px = Buffer.alloc(size * size * 3);
  const bg = [6, 61, 168];     // #063DA8 blue
  const fg = [0, 174, 234];   // #00AEEA accent
  const white = [255, 255, 255];

  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
  };

  const inRoundRect = (x, y, rx, ry, w, h, r) => {
    const cx = Math.max(rx + r, Math.min(rx + w - r, x));
    const cy = Math.max(ry + r, Math.min(ry + h - r, y));
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  const m = Math.round(size * 0.04);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      set(x, y, bg);
      // círculo de acento
      const cx = size / 2, cy = size / 2;
      const d = Math.hypot(x - cx, y - cy);
      const R = size * 0.46;
      if (d <= R) {
        const grad = 0.82 + 0.18 * (d / R);
        set(x, y, [fg[0] * grad, fg[1] * grad, fg[2] * grad]);
      }
      // dos barras blancas ("PP" estilizado)
      const bw = size * 0.11;
      const bx1 = size * 0.26, bx2 = size * 0.58;
      const by = size * 0.30, bh = size * 0.40;
      if (inRoundRect(x, y, bx1, by, bw, bh, bw / 2)) set(x, y, white);
      if (inRoundRect(x, y, bx2, by, bw, bh, bw / 2)) set(x, y, white);
    }
  }

  // scanlines con filtro 0
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };

  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return out;
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const dir = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(dir, 'icon-192.png'), makePng(192));
fs.writeFileSync(path.join(dir, 'icon-512.png'), makePng(512));
console.log('Iconos generados: public/icon-192.png y public/icon-512.png');
