'use strict';

/*
  Genera los assets fuente (RGBA PNG) para @capacitor/assets:
  mobile/assets/
    icon.png              1024x1024  (icono iOS / legado) - fondo opaco
    icon-foreground.png   1024x1024  (adaptativo Android) - símbolo sobre transparente
    icon-background.png   1024x1024  (adaptativo Android) - color de fondo sólido
    splash.png            2732x2732  (splash iOS/Android)  - fondo opaco

  Después ejecuta (desde mobile/):
    npx cap-assets generate --ios --android
*/

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'mobile', 'assets');
const BG = [6, 61, 168];   // #063DA8
const FG = [0, 174, 234];  // #00AEEA
const WHITE = [255, 255, 255];

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

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

// pixelFn(x, y) -> [r,g,b] | null (null = transparente)
function makePng(size, pixelFn) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = pixelFn(x, y);
      if (!c) continue;
      const i = (y * size + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, rx, ry, w, h, r) => {
  const cx = Math.max(rx + r, Math.min(rx + w - r, x));
  const cy = Math.max(ry + r, Math.min(ry + h - r, y));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};

// Escala del color de acento (degradado radial simple)
function shade(c, k) {
  return c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
}

// --- Círculo de acento + dos barras blancas ("OM" estilizado) ---
function circleAt(pixelFn, size, cx, cy, R) {
  return (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= R) return shade(FG, 0.82 + 0.18 * (d / R));
    return pixelFn(x, y);
  };
}
function barsAt(pixelFn, size, widths) {
  // widths: { bw, bx1, bx2, by, bh, radius }
  const { bw, bx1, bx2, by, bh, radius } = widths;
  return (x, y) => {
    if (inRoundRect(x, y, bx1, by, bw, bh, radius)) return WHITE;
    if (inRoundRect(x, y, bx2, by, bw, bh, radius)) return WHITE;
    return pixelFn(x, y);
  };
}

// icon.png — fondo azul opaco, apto para iOS (no debe tener transparencias)
function iconPx(size) {
  let fn = (x, y) => BG;
  fn = circleAt(fn, size, size / 2, size / 2, size * 0.46);
  fn = barsAt(fn, size, {
    bw: size * 0.11, bx1: size * 0.26, bx2: size * 0.58,
    by: size * 0.30, bh: size * 0.40, radius: size * 0.055,
  });
  return fn;
}

// icon-foreground.png — solo el símbolo, transparente, dentro de la zona segura (66%)
function fgPx(size) {
  return barsAt((x, y) => null, size, {
    bw: size * 0.11, bx1: size * 0.42 - size * 0.063, bx2: size * 0.58 - size * 0.047,
    by: size * 0.30, bh: size * 0.40, radius: size * 0.055,
  });
}

// icon-background.png — color sólido
function bgPx() { return (x, y) => BG; }

// splash.png — fondo azul con el símbolo centrado y más pequeño
function splashPx(size) {
  const s = size / 1024; // escala respecto al icono de 1024
  let fn = (x, y) => BG;
  fn = circleAt(fn, size, size / 2, size / 2, 220 * s);
  fn = barsAt(fn, size, {
    bw: 50 * s, bx1: size / 2 - 140 * s, bx2: size / 2 - 10 * s,
    by: size / 2 - 110 * s, bh: 220 * s, radius: 30 * s,
  });
  return fn;
}

fs.mkdirSync(OUT, { recursive: true });
const targets = {
  'icon.png': { size: 1024, fn: iconPx },
  'icon-foreground.png': { size: 1024, fn: fgPx },
  'icon-background.png': { size: 1024, fn: bgPx },
  'splash.png': { size: 2732, fn: splashPx },
};

for (const [name, t] of Object.entries(targets)) {
  fs.writeFileSync(path.join(OUT, name), makePng(t.size, t.fn(t.size)));
  console.log('Generado:', path.join('mobile', 'assets', name));
}
console.log('\nSiguiente paso: desde mobile/ ejecuta npx cap-assets generate --ios --android');