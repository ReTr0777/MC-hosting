/*
 * Generates build/icon.png and build/icon.ico from code.
 *
 * Written by hand rather than checked in as a binary so the icon stays reviewable
 * and there is no opaque blob in the repo. Windows accepts a PNG payload inside an
 * ICO container, so both formats share one encode.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZE = 256;

// Brand colours, matching apps/web/tailwind.config.js.
const BRAND = [16, 185, 129];
const BRAND_DEEP = [4, 120, 87];
const BG = [17, 24, 39];

function roundedAlpha(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const d = Math.hypot(x - cx, y - cy);
  // One-pixel feather so the corners are not jagged.
  return Math.max(0, Math.min(1, radius - d + 0.5));
}

function buildPixels() {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(SIZE * 4 + 1);
    row[0] = 0; // PNG filter: none
    for (let x = 0; x < SIZE; x++) {
      const t = (x + y) / (SIZE * 2);
      const outer = BRAND.map((c, i) => Math.round(c * (1 - t) + BRAND_DEEP[i] * t));

      // Inner cube silhouette: a smaller rounded square knocked out of the tile.
      const inset = SIZE * 0.28;
      const innerSize = SIZE - inset * 2;
      const innerMask =
        x >= inset && y >= inset && x < SIZE - inset && y < SIZE - inset
          ? roundedAlpha(x - inset, y - inset, innerSize, innerSize * 0.2)
          : 0;

      // Blend rather than switch, so the inner corners antialias like the outer ones.
      const colour = outer.map((c, i) => Math.round(c * (1 - innerMask) + BG[i] * innerMask));

      const a = Math.round(255 * roundedAlpha(x, y, SIZE, SIZE * 0.22));
      const o = 1 + x * 4;
      row[o] = colour[0];
      row[o + 1] = colour[1];
      row[o + 2] = colour[2];
      row[o + 3] = a;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(buildPixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0; // 0 means 256
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset to payload

  return Buffer.concat([header, entry, png]);
}

fs.mkdirSync(outDir, { recursive: true });
const png = encodePng();
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png));
console.log(`icon written: ${SIZE}x${SIZE} png (${png.length} bytes) + ico`);
