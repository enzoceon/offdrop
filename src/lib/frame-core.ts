import QRCode from "qrcode";
import { frameAt, type ChunkSource, type SlotInfo, type StreamPlan } from "./qr-protocol";

/** Quiet zone, in modules, drawn around every code. */
export const QUIET = 4;

export interface BuiltFrame {
  seq: number;
  slot: SlotInfo;
  /** Pixels per side of the pre-rendered bitmap (modules + 2 * QUIET). */
  cells: number;
  /** RGBA, 1 pixel per module (scaled up crisply at paint time). */
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Build one playback frame as a ready-to-blit bitmap.
 * This is the expensive part of sending (base45 + Reed-Solomon + layout), so it runs
 * in Web Workers; a fixed mask pattern skips the 8-way mask scoring pass (~4x faster).
 */
export async function buildFrame(
  plan: StreamPlan,
  source: ChunkSource,
  seq: number,
  ec: "L" | "M",
): Promise<BuiltFrame> {
  const { text, slot } = await frameAt(plan, source, seq);
  const qr = QRCode.create(text, { errorCorrectionLevel: ec, maskPattern: 3 });
  const size = qr.modules.size;
  const cells = size + QUIET * 2;
  const pixels = new Uint8ClampedArray(new ArrayBuffer(cells * cells * 4));
  const px = new Uint32Array(pixels.buffer);
  px.fill(0xffffffff); // opaque white
  const dark = 0xff000000; // opaque black (little-endian ABGR)
  for (let r = 0; r < size; r++) {
    const row = (r + QUIET) * cells + QUIET;
    for (let c = 0; c < size; c++) if (qr.modules.get(r, c)) px[row + c] = dark;
  }
  return { seq, slot, cells, pixels };
}

/**
 * EXPERIMENTAL "color" tile: three INDEPENDENT QR codes (seq, seq+1, seq+2) share one image,
 * one in each of the red, green and blue channels. Where a channel's module is dark that
 * channel is 0, otherwise 255. A colour-aware receiver splits the camera image into its three
 * channels and decodes each separately: 3x the data in the same screen area. All three codes
 * have identical size (every frame has the same length), so they line up exactly.
 */
export async function buildColorFrame(
  plan: StreamPlan,
  source: ChunkSource,
  seq: number,
  ec: "L" | "M",
): Promise<BuiltFrame> {
  const [a, b, c] = await Promise.all([
    buildFrame(plan, source, seq, ec),
    buildFrame(plan, source, seq + 1, ec),
    buildFrame(plan, source, seq + 2, ec),
  ]);
  if (a.cells !== b.cells || a.cells !== c.cells) throw new Error("Colour frame channels differ in size.");
  const n = a.cells * a.cells;
  const pa = new Uint32Array(a.pixels.buffer);
  const pb = new Uint32Array(b.pixels.buffer);
  const pc = new Uint32Array(c.pixels.buffer);
  const out = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[o] = (pa[i] & 0xff) === 0 ? 0 : 255; // R from channel A (little-endian ABGR: low byte = R)
    out[o + 1] = (pb[i] & 0xff) === 0 ? 0 : 255; // G from channel B
    out[o + 2] = (pc[i] & 0xff) === 0 ? 0 : 255; // B from channel C
    out[o + 3] = 255;
  }
  return { seq, slot: a.slot, cells: a.cells, pixels: out };
}
