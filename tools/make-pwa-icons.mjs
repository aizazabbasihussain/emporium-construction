// Writes the PWA icons (solid brand colour with a white "E") as PNG files, with no dependencies.
// Usage: node tools/make-pwa-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BRAND = [0x1f, 0x3a, 0x5f];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Is the pixel part of the letter E, drawn on a 5 x 7 grid scaled to the middle of the icon? */
function inLetter(x, y, size) {
  const cell = Math.floor(size / 10);
  const left = Math.floor((size - 5 * cell) / 2);
  const top = Math.floor((size - 7 * cell) / 2);
  const gx = Math.floor((x - left) / cell);
  const gy = Math.floor((y - top) / cell);
  if (gx < 0 || gx > 4 || gy < 0 || gy > 6) return false;
  return gx === 0 || gy === 0 || gy === 3 || gy === 6;
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const colour = inLetter(x, y, size) ? WHITE : BRAND;
      row.set(colour, 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('apps/web/public/icons', { recursive: true });
for (const size of [192, 512]) writeFileSync(`apps/web/public/icons/icon-${size}.png`, png(size));
