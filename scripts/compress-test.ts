// Compression path: deflate-raw -> plan(origSize) -> lossy fountain transfer -> inflate. Node >= 20.
import { FountainDecoder, createPlan, crc32, frameAt, parseFrame, type ChunkSource, type FrameMeta } from "../src/lib/qr-protocol.ts";

async function deflate(b: Uint8Array) { return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()); }
async function inflate(b: Uint8Array) { return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()); }

const text = "OFFDROP sends files through animated QR codes. ".repeat(40000) + JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ i, v: (i * 7919) % 1000 })));
const original = new TextEncoder().encode(text);
const packed = await deflate(original);
const plan = createPlan({ name: "big.txt", type: "text/plain", size: packed.length, crc: crc32(packed), origSize: original.length, chunk: 1400 });
const src: ChunkSource = { read: (i) => packed.subarray(i * 1400, Math.min(packed.length, (i + 1) * 1400)), readRange: (s, c) => packed.subarray(s * 1400, Math.min(packed.length, (s + c) * 1400)) };
let seed = 7; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
let dec: FountainDecoder | null = null; let hdr: FrameMeta | null = null; let got = 0;
for (let seq = 3; seq < plan.total * 5 + 100 && !dec?.complete; seq++) {
  const { text: f } = await frameAt(plan, src, seq);
  if (rnd() < 0.15) continue; got++;
  const p = parseFrame(f)!;
  if (!dec) { hdr = p.meta; dec = new FountainDecoder(p.meta); }
  if (p.kind !== "header") dec.add(p);
}
if (!dec?.complete || !hdr) throw new Error("incomplete");
const bytes = dec.result();
if (crc32(bytes) !== hdr.crc) throw new Error("crc");
const out = await inflate(bytes);
if (!hdr.compressed || out.length !== hdr.origSize || out.some((v, i) => v !== original[i])) throw new Error("inflate mismatch");
const plainFrames = Math.ceil(original.length / 1400);
console.log(`OK compression: ${original.length} B -> ${packed.length} B (${(100 - (packed.length / original.length) * 100).toFixed(0)}% smaller); ${plan.total} frames instead of ${plainFrames} (${(plainFrames / plan.total).toFixed(1)}x faster), 15% loss survived`);
