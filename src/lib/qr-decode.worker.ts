/// <reference lib="webworker" />
// jsQR runs here so heavy decodes never block the UI thread. The receiver only
// uses this on browsers without a native BarcodeDetector (notably iOS Safari).
import jsQR from "jsqr";

type Pt = { x: number; y: number };
type In = { id: number; data: ArrayBuffer; w: number; h: number; deep: boolean; channels?: boolean };

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

/** Find up to MAX_CODES codes: decode one, white-out its footprint, then look again (multi-QR streams). */
const MAX_CODES = 12;
function decodeAll(buf: Uint8ClampedArray, w: number, h: number, deep: boolean): Found[] {
  const results: Found[] = [];
  let work = buf;
  let copied = false;
  for (let pass = 0; pass < MAX_CODES; pass++) {
    const found = decode(work, w, h, deep && pass === 0);
    if (!found || results.some((r) => r.data === found.data)) break;
    results.push(found);
    const xs = found.corners.map((p) => p.x);
    const ys = found.corners.map((p) => p.y);
    const pad = 8;
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
    const x1 = Math.min(w, Math.ceil(Math.max(...xs)) + pad);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const y1 = Math.min(h, Math.ceil(Math.max(...ys)) + pad);
    if ((x1 - x0) * (y1 - y0) > w * h * 0.7) break; // one code fills the frame: nothing else to find
    if (!copied) {
      work = new Uint8ClampedArray(buf); // keep the caller's buffer untouched
      copied = true;
    }
    for (let y = y0; y < y1; y++) work.fill(255, (y * w + x0) * 4, (y * w + x1) * 4);
  }
  return results;
}

/** Colour (RGB) streams: decode each channel separately as a contrast-stretched greyscale image. */
function decodeChannels(buf: Uint8ClampedArray, w: number, h: number): Found[] {
  const all: Found[] = [];
  const gray = new Uint8ClampedArray(buf.length);
  for (let k = 0; k < 3; k++) {
    let mn = 255;
    let mx = 0;
    for (let i = k; i < buf.length; i += 4 * 37) {
      const v = buf[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const gain = 255 / Math.max(32, mx - mn);
    for (let i = 0; i < buf.length; i += 4) {
      const v = Math.max(0, Math.min(255, (buf[i + k] - mn) * gain));
      gray[i] = gray[i + 1] = gray[i + 2] = v;
      gray[i + 3] = 255;
    }
    for (const f of decodeAll(gray, w, h, true)) if (!all.some((a) => a.data === f.data)) all.push(f);
  }
  return all;
}

self.onmessage = (event: MessageEvent<In>) => {
  const { id, data, w, h, deep, channels } = event.data;
  let results: Found[] = [];
  try {
    const buf = new Uint8ClampedArray(data);
    results = channels ? decodeChannels(buf, w, h) : decodeAll(buf, w, h, deep);
  } catch {
    results = [];
  }
  (self as unknown as Worker).postMessage({ id, results });
};
