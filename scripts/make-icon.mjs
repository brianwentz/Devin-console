// Generates build/icon.ico (256/128/64/48/32/16 px) with no external deps.
// The artwork is drawn procedurally: a rounded navy square with a white
// periodic-table "Ag" tile (silver's symbol — Agent Workspace) and an accent
// "47" atomic number — good enough as a placeholder until design assets
// exist.
// 16–128 px entries are stored as 32-bpp DIBs (maximum compatibility with
// NSIS/rcedit/Explorer); the 256 px entry is PNG-compressed as Windows expects.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'build', 'icon.ico');
const outputPng = resolve(root, 'build', 'icon.png');
const sizes = [256, 128, 64, 48, 32, 16];

const BG = [0x11, 0x18, 0x27]; // #111827 (matches the shell background)
const FG = [0xf9, 0xfa, 0xfb]; // #f9fafb
const ACCENT = [0x60, 0xa5, 0xfa]; // #60a5fa

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crc32Table();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --- glyph: signed-distance stroke renderer -------------------------------
// Primitives in unit coordinates (fraction of size). A sample belongs to a
// stroke when its distance to the nearest primitive ≤ strokeWidth/2.
const seg = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const arc = (cx, cy, r, a0, a1) => ({ cx, cy, r, a0, a1 });

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function primDist(p, px, py) {
  if (p.r === undefined) return segDist(px, py, p.x1, p.y1, p.x2, p.y2);
  const d = Math.hypot(px - p.cx, py - p.cy);
  let ang = Math.atan2(py - p.cy, px - p.cx);
  while (ang < p.a0) ang += Math.PI * 2;
  if (ang <= p.a1) return Math.abs(d - p.r);
  return Math.min(
    Math.hypot(px - (p.cx + p.r * Math.cos(p.a0)), py - (p.cy + p.r * Math.sin(p.a0))),
    Math.hypot(px - (p.cx + p.r * Math.cos(p.a1)), py - (p.cy + p.r * Math.sin(p.a1))),
  );
}

function dist(prims, px, py) {
  let m = Infinity;
  for (const p of prims) m = Math.min(m, primDist(p, px, py));
  return m;
}

// "A" — cap height 0.40, baseline 0.68.
const A_LEGS = [seg(0.36, 0.28, 0.2, 0.68), seg(0.36, 0.28, 0.52, 0.68)];
const A_T = (0.555 - 0.28) / 0.4;
const AG = [
  ...A_LEGS,
  seg(0.36 - 0.16 * A_T, 0.555, 0.36 + 0.16 * A_T, 0.555), // crossbar
  // "g" — x-height top 0.42, baseline 0.68, descender to 0.845.
  arc(0.695, 0.55, 0.125, 0, Math.PI * 2), // bowl
  seg(0.82, 0.42, 0.82, 0.765), // stem
  arc(0.715, 0.765, 0.105, 0, Math.PI * 1.0), // hook: 0.82,0.765 → under the bowl, ends at 0.61,0.765
];
const AG_SW = 0.082;

// Atomic number "47", top-left — only on 48 px and up. 0.10 tall, stroke 0.022.
const NUM47 = [
  seg(0.185, 0.12, 0.13, 0.185),
  seg(0.13, 0.185, 0.205, 0.185),
  seg(0.185, 0.12, 0.185, 0.22),
  seg(0.235, 0.12, 0.31, 0.12),
  seg(0.31, 0.12, 0.26, 0.22),
];
const NUM47_SW = 0.022;

// Returns RGBA pixels (top-down) for a size.
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;
  const ss = 4; // supersampling per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss;
          const fy = y + (sy + 0.5) / ss;
          // rounded-rect coverage
          const dx = Math.max(Math.abs(fx - cx) - (size / 2 - radius), 0);
          const dy = Math.max(Math.abs(fy - cy) - (size / 2 - radius), 0);
          const inside = dx * dx + dy * dy <= radius * radius;
          if (!inside) continue;
          const u = fx / size;
          const v = fy / size;
          let c = BG;
          if (size >= 48 && dist(NUM47, u, v) <= NUM47_SW / 2) c = ACCENT;
          else if (dist(AG, u, v) <= AG_SW / 2) c = FG;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      if (a > 0) {
        const covered = a / 255;
        px[i] = Math.round(r / covered);
        px[i + 1] = Math.round(g / covered);
        px[i + 2] = Math.round(b / covered);
        px[i + 3] = Math.round(a / n);
      }
    }
  }
  return px;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  const andStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andStride * size); // all zero: alpha channel rules
  return Buffer.concat([header, xor, and]);
}

const images = sizes.map((size) => {
  const rgba = render(size);
  return { size, data: size >= 256 ? encodePng(size, rgba) : encodeDib(size, rgba) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // ICO
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = [];
for (const image of images) {
  const entry = Buffer.alloc(16);
  entry[0] = image.size >= 256 ? 0 : image.size;
  entry[1] = image.size >= 256 ? 0 : image.size;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.data.length;
  entries.push(entry);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, ...entries, ...images.map((image) => image.data)]));
console.log(`wrote ${output} (${offset} bytes, sizes ${sizes.join('/')})`);

// build/icon.png — 1024x1024 source for the macOS icon (electron-builder
// derives the .icns); same render()/PNG encoder as the 256 px ICO entry.
const png = encodePng(1024, render(1024));
writeFileSync(outputPng, png);
console.log(`wrote ${outputPng} (${png.length} bytes, 1024x1024)`);

export { render, encodePng };
