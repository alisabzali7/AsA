#!/usr/bin/env node
/**
 * Generates the PWA icons (public/icons/) — zero dependencies.
 *
 * Design: obsidian background (#07080a), gold "A" wordmark stroke (#d4b874),
 * green "live" dot (#3fb68b) — the same identity tokens as globals.css.
 *
 * PNGs are encoded by hand (RGBA8, filter 0 per scanline, zlib-compressed
 * IDAT, CRC32). Re-run any time: `node scripts/gen-pwa-icons.mjs`.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "public", "icons");

const BG = [7, 8, 10]; // --color-obsidian
const GOLD = [212, 184, 116]; // --color-gold
const GREEN = [63, 182, 139]; // --color-up

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const t = c1 / c2;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Render the icon at a given size (normalized-coordinate design). */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  // The "A": two legs + crossbar, centered.
  const segs = [
    [[0.315, 0.775], [0.5, 0.225]], // left leg
    [[0.685, 0.775], [0.5, 0.225]], // right leg
    [[0.375, 0.565], [0.625, 0.565]], // crossbar
  ];
  const half = 0.042 * size; // half stroke thickness
  const dotC = [0.78 * size, 0.24 * size]; // "live" dot, top-right
  const dotR = 0.052 * size;
  const feather = 0.75; // ~1px distance-based antialiasing
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let best = Infinity;
      for (const [a, bb] of segs) {
        best = Math.min(best, distToSegment(x + 0.5, y + 0.5, a[0] * size, a[1] * size, bb[0] * size, bb[1] * size));
      }
      const aGold = clamp(half - best + feather, 0, 1);
      if (aGold > 0) {
        r = r * (1 - aGold) + GOLD[0] * aGold;
        g = g * (1 - aGold) + GOLD[1] * aGold;
        b = b * (1 - aGold) + GOLD[2] * aGold;
      }
      const dDot = Math.hypot(x + 0.5 - dotC[0], y + 0.5 - dotC[1]);
      const aGreen = clamp(dotR - dDot + feather, 0, 1);
      if (aGreen > 0) {
        r = r * (1 - aGreen) + GREEN[0] * aGreen;
        g = g * (1 - aGreen) + GREEN[1] * aGreen;
        b = b * (1 - aGreen) + GREEN[2] * aGreen;
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(clamp(r, 0, 255));
      px[i + 1] = Math.round(clamp(g, 0, 255));
      px[i + 2] = Math.round(clamp(b, 0, 255));
      px[i + 3] = 255;
    }
  }
  return px;
}

/* ── minimal PNG encoder (RGBA8) ─────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression / filter / interlace = 0
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ── write the assets the manifest references ────────────────────────────── */

mkdirSync(OUT, { recursive: true });
const targets = [
  ["icon-512.png", 512],
  ["icon-192.png", 192],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of targets) {
  const file = path.join(OUT, name);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${path.relative(path.join(HERE, ".."), file)} (${size}x${size})`);
}
