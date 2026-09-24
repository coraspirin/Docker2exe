const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/**
 * Paket ikonu (icon.ico): projede favicon.ico varsa o kullanılır; yoksa uygulama adının baş harfiyle
 * renkli bir ikon üretilir (PNG içeren ICO, Windows Vista+). Harici bağımlılık yoktur.
 */

const FAVICON_CANDIDATES = [
  'favicon.ico', 'public/favicon.ico', 'static/favicon.ico', 'assets/favicon.ico',
  'client/public/favicon.ico', 'frontend/public/favicon.ico', 'ui/public/favicon.ico', 'web/public/favicon.ico',
  'client/static/favicon.ico', 'src/favicon.ico'
];

// 5x7 bitmap font (her satır 5 bit, soldan sağa)
const GLYPHS = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c]
};
const TR_MAP = { Ç: 'C', Ğ: 'G', İ: 'I', I: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };

function initialOf(name) {
  for (const ch of String(name).toLocaleUpperCase('tr-TR')) {
    const c = TR_MAP[ch] || ch;
    if (GLYPHS[c]) return c;
  }
  return 'A';
}

function colorOf(name) {
  const h = crypto.createHash('sha1').update(String(name)).digest();
  const hue = (h[0] / 255) * 360;
  // HSL(hue, 55%, 42%) → RGB: beyaz harfle yeterli kontrast
  const s = 0.55;
  const l = 0.42;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}

/** size×size RGBA: yuvarlatılmış kare + ortada beyaz harf. */
function renderPixels(size, letter, [r, g, b]) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.2;
  const glyph = GLYPHS[letter];
  const scale = Math.max(1, Math.floor((size * 0.62) / 7));
  const gw = 5 * scale;
  const gh = 7 * scale;
  const gx = Math.floor((size - gw) / 2);
  const gy = Math.floor((size - gh) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // köşe yuvarlama (kenar yumuşatma olmadan)
      const cx = x < radius ? radius : x > size - 1 - radius ? size - 1 - radius : x;
      const cy = y < radius ? radius : y > size - 1 - radius ? size - 1 - radius : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
      let on = false;
      const lx = x - gx;
      const ly = y - gy;
      if (lx >= 0 && ly >= 0 && lx < gw && ly < gh) {
        const row = glyph[Math.floor(ly / scale)];
        on = Boolean(row & (1 << (4 - Math.floor(lx / scale))));
      }
      px[i] = on ? 255 : r;
      px[i + 1] = on ? 255 : g;
      px[i + 2] = on ? 255 : b;
      px[i + 3] = 255;
    }
  }
  return px;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0, 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtre yok
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** PNG girdili ICO dosyası. */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.png)]);
}

function generateIcon(appName) {
  const letter = initialOf(appName);
  const color = colorOf(appName);
  return encodeIco([16, 32, 48, 256].map(size => ({ size, png: encodePng(size, renderPixels(size, letter, color)) })));
}

/**
 * @returns {{ source: 'project'|'generated', from?: string }}
 */
function writeIcon(outFile, appName, searchDirs) {
  for (const dir of searchDirs) {
    for (const rel of FAVICON_CANDIDATES) {
      const file = path.join(dir, rel);
      if (fs.existsSync(file)) {
        const head = fs.readFileSync(file).subarray(0, 4);
        if (head.readUInt32LE(0) === 0x00010000) {
          fs.copyFileSync(file, outFile);
          return { source: 'project', from: file };
        }
      }
    }
  }
  fs.writeFileSync(outFile, generateIcon(appName));
  return { source: 'generated' };
}

module.exports = { writeIcon, generateIcon, initialOf, encodePng };
