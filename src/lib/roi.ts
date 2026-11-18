// Region-of-interest tracking for the receiver.
//
// Finding QR codes in a whole camera frame is the expensive part; reading codes whose position is
// already known is cheap. Once codes have been located, the next frames are decoded from a crop
// around them (taken from the full-resolution video frame, so the codes also get MORE pixels per
// module than a downscaled full-frame pass would give). The full frame is still re-scanned every
// few frames so newly appearing codes (or a moved sender screen) are noticed.

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  sx: number;
  sy: number;
  w: number;
  h: number;
}

/** Union bounding box of quads (video pixel space), grown by `pad` on every side and clamped to the frame. */
export function roiFromQuads(quads: Pt[][], W: number, H: number, pad = 0.35, minFrac = 0.3): Rect | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const q of quads) {
    for (const p of q) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  let w = (maxX - minX) * (1 + 2 * pad);
  let h = (maxY - minY) * (1 + 2 * pad);
  // Never track a tiny window: a little hand movement would lose the codes.
  w = Math.min(W, Math.max(w, W * minFrac));
  h = Math.min(H, Math.max(h, H * minFrac));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = Math.min(W - w, Math.max(0, cx - w / 2));
  const sy = Math.min(H - h, Math.max(0, cy - h / 2));
  return { sx, sy, w, h };
}

/** Are all the codes fully inside the tracked window (with `margin` px to spare)? */
export function rectContains(outer: Rect, quads: Pt[][], margin = 0): boolean {
  for (const q of quads) {
    for (const p of q) {
      if (p.x < outer.sx + margin || p.x > outer.sx + outer.w - margin) return false;
      if (p.y < outer.sy + margin || p.y > outer.sy + outer.h - margin) return false;
    }
  }
  return true;
}
