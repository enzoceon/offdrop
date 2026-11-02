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
