import { roiFromQuads, rectContains } from "../src/lib/roi.ts";
import { RateMeter } from "../src/lib/rate-meter.ts";

const W = 1920, H = 1080;
const quad = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
{
  const r = roiFromQuads([quad(800, 400, 200)], W, H)!;
  if (r.w < W * 0.3 || r.h < H * 0.3) throw new Error("minimum window not enforced");
  if (r.sx < 0 || r.sy < 0 || r.sx + r.w > W || r.sy + r.h > H) throw new Error("roi outside frame");
  if (!rectContains(r, [quad(800, 400, 200)])) throw new Error("roi must contain the codes it was built from");
}
{
  const q = [quad(10, 10, 300), quad(330, 10, 300)];
  const r = roiFromQuads(q, W, H)!;
  if (r.sx !== 0 || r.sy !== 0) throw new Error("corner roi should clamp to 0,0");
  if (!rectContains(r, q)) throw new Error("clamped roi lost the codes");
}
{
  const r = roiFromQuads([quad(100, 100, 1500)], W, H)!;
  if (r.w > W || r.h > H) throw new Error("roi larger than frame");
}
if (roiFromQuads([], W, H) !== null) throw new Error("empty input must give null");
console.log("OK roi: min window, clamping, containment, empty input");

{
  const m = new RateMeter();
  let bytes = 0;
  for (let t = 0; t <= 10000; t += 100) {
    bytes += t < 8000 ? 1000 : 10000; // 10 KB/s for 8 s, then 100 KB/s for 2 s
    m.add(t, bytes);
  }
  const r = m.report(bytes, 10000);
  if (Math.abs(r.sustained - bytes / 10) > 1) throw new Error("sustained wrong");
  if (r.peak < 95_000 || r.peak > 110_000) throw new Error("peak should be ~100 KB/s, got " + r.peak);
  if (r.peak < r.sustained) throw new Error("peak must be >= sustained");
  console.log(`OK rate meter: sustained ${(r.sustained / 1000).toFixed(1)} KB/s, peak ${(r.peak / 1000).toFixed(1)} KB/s`);
}
console.log("ALL PASS (receiver helpers)");
