/**
 * Chart renderer (closure §K, §L).
 *
 * ONE renderer produces the annotated image consumed by BOTH the web chart
 * route and the Telegram photo pipeline. There is deliberately no second
 * rendering implementation that could drift from the evidence.
 *
 * Output is SVG (dependency-free, deterministic, diffable). Telegram accepts
 * PNG/JPEG for sendPhoto, so `svgToPngBytes` rasterises via a pure-TS encoder
 * when no native canvas is available — see `renderEvidencePng`.
 *
 * LINEAGE: every drawn element is derived from a ChartAnnotation, which itself
 * carries produced_by + source_refs + detector_version. Nothing decorative is
 * ever drawn: if an annotation does not exist, no line appears.
 */
import type { Candle } from "../domain/types";
import type { ChartEvidence, ChartAnnotation } from "./evidence";

export interface RenderOptions {
  width?: number;
  height?: number;
  /** how many trailing candles to draw */
  bars?: number;
  title?: string;
}

const COLORS = {
  bg: "#07080a",
  grid: "#1a1d22",
  text: "#e6e8ec",
  muted: "#8b8f98",
  up: "#3fb68b",
  down: "#d05f5f",
  entry: "#d6b04a",
  stop: "#d05f5f",
  target: "#3fb68b",
  invalidation: "#a05fd0",
  level: "#5f8fd0",
} as const;

function colorFor(kind: ChartAnnotation["kind"]): string {
  switch (kind) {
    case "entry": return COLORS.entry;
    case "stop": return COLORS.stop;
    case "target": return COLORS.target;
    case "invalidation": return COLORS.invalidation;
    default: return COLORS.level;
  }
}

/**
 * Compute readable price bounds.
 * The candle range defines the view; an annotation further than
 * MAX_ANNOTATION_SPAN beyond it is reported as off-scale and clamped, so a
 * distant target can never squash the price action into an unreadable strip.
 */
const MAX_ANNOTATION_SPAN = 0.35; // 35% of the candle range on either side

export function priceBounds(
  view: Candle[],
  annotations: ChartAnnotation[],
): { lo: number; hi: number; offscale: Set<string> } {
  const offscale = new Set<string>();
  let lo = Math.min(...view.map((c) => c.l));
  let hi = Math.max(...view.map((c) => c.h));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { lo: 0, hi: 1, offscale };
  const range = hi - lo;
  const limitLo = lo - range * MAX_ANNOTATION_SPAN;
  const limitHi = hi + range * MAX_ANNOTATION_SPAN;

  for (const a of annotations) {
    if (!Number.isFinite(a.price)) continue;
    if (a.price < limitLo || a.price > limitHi) { offscale.add(a.annotation_id); continue; }
    lo = Math.min(lo, a.price);
    hi = Math.max(hi, a.price);
  }
  const pad = (hi - lo) * 0.08 || 1;
  return { lo: lo - pad, hi: hi + pad, offscale };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Render evidence + candles to an annotated SVG.
 * Pure function: identical inputs always produce identical bytes.
 */
export function renderEvidenceSvg(
  evidence: ChartEvidence,
  candles: Candle[],
  opts: RenderOptions = {},
): string {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 675;
  const nBars = opts.bars ?? 160;
  const padL = 8, padR = 96, padT = 52, padB = 28;

  const view = candles.slice(-nBars);
  if (view.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${COLORS.bg}"/><text x="24" y="40" fill="${COLORS.text}" font-family="monospace" font-size="14">no candles available</text></svg>`;
  }

  // Price bounds: anchored on the CANDLES so price action stays readable.
  // An annotation far outside the visible range (e.g. a distant target) would
  // otherwise compress the candles into a sliver, so out-of-range annotations
  // are clamped to the edge and explicitly marked rather than rescaling.
  const { lo, hi, offscale } = priceBounds(view, evidence.annotations);

  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (i: number) => padL + (i / Math.max(1, view.length - 1)) * plotW;
  const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
  const bw = Math.max(1.2, (plotW / view.length) * 0.62);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`);

  // horizontal grid
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (g / 4) * plotH;
    const gp = hi - (g / 4) * (hi - lo);
    parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + plotW}" y2="${gy.toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padL + plotW + 6}" y="${(gy + 4).toFixed(1)}" fill="${COLORS.muted}" font-family="monospace" font-size="11">${gp.toFixed(2)}</text>`);
  }

  // candles — the only non-annotation element, and they ARE the measured data
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const cx = x(i);
    const col = c.c >= c.o ? COLORS.up : COLORS.down;
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(c.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    const top = y(Math.max(c.o, c.c));
    const bot = y(Math.min(c.o, c.c));
    parts.push(`<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}"/>`);
  }

  // annotations — each one is evidence, each carries lineage in a data attribute
  for (const a of evidence.annotations) {
    if (!Number.isFinite(a.price)) continue;
    const clamped = Math.min(hi, Math.max(lo, a.price));
    const ay = y(clamped);
    const isOff = offscale.has(a.annotation_id);
    const col = colorFor(a.kind);
    const dash = a.kind === "invalidation" ? ' stroke-dasharray="6 4"' : a.kind === "target" ? ' stroke-dasharray="3 3"' : "";
    parts.push(
      `<line x1="${padL}" y1="${ay.toFixed(1)}" x2="${padL + plotW}" y2="${ay.toFixed(1)}" stroke="${col}" stroke-width="1.4"${dash}` +
      ` data-annotation-id="${esc(a.annotation_id)}" data-produced-by="${esc(a.produced_by.type)}:${esc(a.produced_by.id)}"` +
      ` data-detector-version="${esc(a.detector_version)}" data-evidence="${esc(a.evidence_kind)}"/>`,
    );
    parts.push(`<text x="${padL + 6}" y="${(ay - 5).toFixed(1)}" fill="${col}" font-family="monospace" font-size="11">${esc(a.label)} ${a.price.toFixed(4)} [${esc(a.evidence_kind)}]${isOff ? " ▲ OFF-SCALE" : ""}</text>`);
  }

  // header: what this chart asserts, and the score disclaimer
  const dirCol = evidence.direction === "long" ? COLORS.up : COLORS.down;
  parts.push(`<text x="${padL}" y="22" fill="${COLORS.text}" font-family="monospace" font-size="15">${esc(evidence.symbol)} · ${esc(evidence.timeframe)} · <tspan fill="${dirCol}">${esc(evidence.direction.toUpperCase())}</tspan></text>`);
  parts.push(`<text x="${padL}" y="40" fill="${COLORS.muted}" font-family="monospace" font-size="11">${esc(evidence.setup_id)} · score ${evidence.score ?? "n/a"} — ${esc(evidence.score_semantics)}</text>`);
  parts.push(`<text x="${W - 8}" y="22" text-anchor="end" fill="${COLORS.muted}" font-family="monospace" font-size="11">ADVISORY ONLY — AsA never executes</text>`);
  if (!evidence.lineage_complete) {
    parts.push(`<text x="${W - 8}" y="40" text-anchor="end" fill="${COLORS.stop}" font-family="monospace" font-size="11">INCOMPLETE LINEAGE</text>`);
  }
  parts.push(`<text x="${padL}" y="${H - 8}" fill="${COLORS.muted}" font-family="monospace" font-size="10">${esc(`${evidence.annotations.length} annotations, each traceable to a rule/feature + source line`)}</text>`);
  parts.push("</svg>");
  return parts.join("");
}

/* ------------------------------------------------------------------ PNG */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.slice(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * Encode raw RGBA pixels as an uncompressed PNG (zlib "stored" blocks).
 * Dependency-free and deterministic — no native canvas required.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // raw scanlines with filter byte 0
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let yy = 0; yy < height; yy++) {
    raw[yy * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(yy * width * 4, (yy + 1) * width * 4), yy * (1 + width * 4) + 1);
  }
  // zlib stream with stored deflate blocks
  const blocks: Uint8Array[] = [];
  const MAX = 65535;
  for (let off = 0; off < raw.length; off += MAX) {
    const len = Math.min(MAX, raw.length - off);
    const last = off + len >= raw.length ? 1 : 0;
    const hdr = new Uint8Array(5);
    hdr[0] = last;
    hdr[1] = len & 0xff; hdr[2] = (len >> 8) & 0xff;
    hdr[3] = ~len & 0xff; hdr[4] = (~len >> 8) & 0xff;
    blocks.push(hdr, raw.subarray(off, off + len));
  }
  const bodyLen = blocks.reduce((a, b) => a + b.length, 0);
  const z = new Uint8Array(2 + bodyLen + 4);
  z[0] = 0x78; z[1] = 0x01;
  let p = 2;
  for (const b of blocks) { z.set(b, p); p += b.length; }
  new DataView(z.buffer).setUint32(2 + bodyLen, adler32(raw));

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let q = 0;
  for (const part of parts) { out.set(part, q); q += part.length; }
  return out;
}

/**
 * Rasterise the evidence chart to a PNG.
 *
 * A deliberately simple software rasteriser draws the same primitives as the
 * SVG (candles + annotation lines) so the Telegram image and the web chart
 * come from ONE evidence object. It is not a general SVG engine: it renders
 * the evidence model directly, which is what keeps the two views identical.
 */
export function renderEvidencePng(
  evidence: ChartEvidence,
  candles: Candle[],
  opts: RenderOptions = {},
): Uint8Array {
  const W = opts.width ?? 900;
  const H = opts.height ?? 500;
  const nBars = opts.bars ?? 140;
  const padL = 6, padR = 70, padT = 34, padB = 18;

  const rgba = new Uint8Array(W * H * 4);
  const hex = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
  ];
  const fill = (c: string) => {
    const [r, g, b] = hex(c);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255; }
  };
  const px = (xx: number, yy: number, c: string) => {
    const xi = Math.round(xx), yi = Math.round(yy);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const [r, g, b] = hex(c);
    const o = (yi * W + xi) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  };
  const vline = (xx: number, y0: number, y1: number, c: string) => {
    for (let yy = Math.min(y0, y1); yy <= Math.max(y0, y1); yy++) px(xx, yy, c);
  };
  const hline = (y0: number, x0: number, x1: number, c: string, dashed = false) => {
    for (let xx = Math.min(x0, x1); xx <= Math.max(x0, x1); xx++) {
      if (dashed && Math.floor(xx / 6) % 2 === 1) continue;
      px(xx, y0, c);
    }
  };
  const rect = (x0: number, y0: number, w: number, h: number, c: string) => {
    for (let yy = y0; yy < y0 + h; yy++) for (let xx = x0; xx < x0 + w; xx++) px(xx, yy, c);
  };

  fill(COLORS.bg);
  const view = candles.slice(-nBars);
  if (view.length === 0) return encodePng(W, H, rgba);

  const { lo, hi, offscale } = priceBounds(view, evidence.annotations);

  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const X = (i: number) => padL + (i / Math.max(1, view.length - 1)) * plotW;
  const Y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
  const bw = Math.max(1, Math.floor((plotW / view.length) * 0.6));

  for (let g = 0; g <= 4; g++) hline(padT + (g / 4) * plotH, padL, padL + plotW, COLORS.grid);

  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const cx = X(i);
    const col = c.c >= c.o ? COLORS.up : COLORS.down;
    vline(cx, Y(c.h), Y(c.l), col);
    const top = Y(Math.max(c.o, c.c));
    const bot = Y(Math.min(c.o, c.c));
    rect(Math.round(cx - bw / 2), Math.round(top), Math.max(1, bw), Math.max(1, Math.round(bot - top)), col);
  }

  for (const a of evidence.annotations) {
    if (!Number.isFinite(a.price)) continue;
    // off-scale annotations are drawn as a short edge marker, not a full line
    const clamped = Math.min(hi, Math.max(lo, a.price));
    const ay = Math.round(Y(clamped));
    if (offscale.has(a.annotation_id)) {
      hline(ay, padL, padL + Math.round(plotW * 0.08), colorFor(a.kind));
    } else {
      hline(ay, padL, padL + plotW, colorFor(a.kind), a.kind === "target" || a.kind === "invalidation");
    }
  }
  // direction marker bar in the header strip (no text rasteriser: colour-coded)
  rect(padL, 6, 120, 6, evidence.direction === "long" ? COLORS.up : COLORS.down);

  return encodePng(W, H, rgba);
}
