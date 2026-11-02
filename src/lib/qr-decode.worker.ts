/// <reference lib="webworker" />
// jsQR runs here so heavy decodes never block the UI thread. The receiver only
// uses this on browsers without a native BarcodeDetector (notably iOS Safari).
import jsQR from "jsqr";

type Pt = { x: number; y: number };
type In = { id: number; data: ArrayBuffer; w: number; h: number; deep: boolean };

function crop(src: Uint8ClampedArray, w: number, sx: number, sy: number, sw: number, sh: number) {
  if (sx === 0 && sy === 0 && sw === w) return src.subarray(0, sw * sh * 4);
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let row = 0; row < sh; row++) {
    const from = ((sy + row) * w + sx) * 4;
    out.set(src.subarray(from, from + sw * 4), row * sw * 4);
  }
  return out;
}

function decode(buf: Uint8ClampedArray, w: number, h: number, deep: boolean) {
  const side = Math.min(w, h);
  const cx = Math.round((w - side) / 2);
  const cy = Math.round((h - side) / 2);
  // Centre square first (fast, usually where the user aims), then the whole frame, then inverted.
  const attempts: Array<[number, number, number, number, boolean]> = [[cx, cy, side, side, false]];
  if (deep && (side !== w || side !== h)) attempts.push([0, 0, w, h, false]);
  if (deep) attempts.push([cx, cy, side, side, true]);
  for (const [sx, sy, sw, sh, invert] of attempts) {
    const code = jsQR(crop(buf, w, sx, sy, sw, sh), sw, sh, {
      inversionAttempts: invert ? "attemptBoth" : "dontInvert",
    });
    if (!code?.data) continue;
    const l = code.location;
    const off = (p: Pt): Pt => ({ x: p.x + sx, y: p.y + sy });
    return {
      data: code.data,
      corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map(off),
    };
  }
  return null;
}

type Found = NonNullable<ReturnType<typeof decode>>;

/** Find up to two codes: decode one, white-out its footprint, then look again (dual-QR streams). */
function decodeAll(buf: Uint8ClampedArray, w: number, h: number, deep: boolean): Found[] {
  const first = decode(buf, w, h, deep);
  if (!first) return [];
  const results: Found[] = [first];
  const xs = first.corners.map((p) => p.x);
  const ys = first.corners.map((p) => p.y);
  const pad = 6;
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
  const x1 = Math.min(w, Math.ceil(Math.max(...xs)) + pad);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const y1 = Math.min(h, Math.ceil(Math.max(...ys)) + pad);
  // Only worth a second pass if there is meaningful room left beside/below the first code.
  if ((x1 - x0) * (y1 - y0) < w * h * 0.7) {
    const copy = new Uint8ClampedArray(buf); // keep the caller's buffer untouched
    for (let y = y0; y < y1; y++) copy.fill(255, (y * w + x0) * 4, (y * w + x1) * 4);
    const second = decode(copy, w, h, false);
    if (second && second.data !== first.data) results.push(second);
  }
  return results;
}

self.onmessage = (event: MessageEvent<In>) => {
  const { id, data, w, h, deep } = event.data;
  let results: Found[] = [];
  try {
    results = decodeAll(new Uint8ClampedArray(data), w, h, deep);
  } catch {
    results = [];
  }
  (self as unknown as Worker).postMessage({ id, results });
};
