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

self.onmessage = (event: MessageEvent<In>) => {
  const { id, data, w, h, deep } = event.data;
  let result: ReturnType<typeof decode> = null;
  try {
    result = decode(new Uint8ClampedArray(data), w, h, deep);
  } catch {
    result = null;
  }
  (self as unknown as Worker).postMessage({ id, result });
};
