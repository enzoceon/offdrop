// Pure-protocol test (no QR rendering). Run: node --experimental-strip-types scripts/protocol-test.ts
import {
  FountainDecoder, createPlan, crc32, frameAt, parseFrame, slotAt, cycleLength,
  b45ToBytes, bytesToB45, type ChunkSource, type FrameMeta, type ParsedHeader,
} from "../src/lib/qr-protocol.ts";

function rnd(seed: number) { let a = seed; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296); }

function makeSource(bytes: Uint8Array, chunk: number): ChunkSource {
  return {
    read: (i) => bytes.subarray(i * chunk, Math.min(bytes.length, (i + 1) * chunk)),
    readRange: (start, count) => bytes.subarray(start * chunk, Math.min(bytes.length, (start + count) * chunk)),
  };
}

async function run(size: number, lossRate: number, startAt: number, label: string, chunk?: number) {
  const r = rnd(size * 7 + startAt);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (r() * 256) | 0;
  const plan = createPlan({ name: "tëst|file.bin", type: "application/octet-stream", size, crc: crc32(bytes), chunk });
  const src = makeSource(bytes, plan.chunk);
  let dec: FountainDecoder | null = null;
  let header: FrameMeta | null = null;
  let frames = 0;
  const limit = plan.total * 8 + 400;
  for (let seq = startAt; seq < startAt + limit; seq++) {
    const { text } = await frameAt(plan, src, seq);
    if (r() < lossRate) continue;
    frames++;
    const p = parseFrame(text);
    if (!p) throw new Error("parse failed at " + seq);
    // Self-describing frames: the decoder can start from ANY frame, header or not.
    if (!dec) { header = p.meta; dec = new FountainDecoder(p.meta); }
    if (p.kind !== "header") { dec.add(p); if (dec.complete) break; }
  }
  if (!dec || !dec.complete) throw new Error(`${label}: did not complete (${dec?.count}/${dec?.total})`);
  const out = dec.result();
  if (out.length !== size || crc32(out) !== plan.crc) throw new Error(`${label}: corrupt output`);
  for (let i = 0; i < size; i++) if (out[i] !== bytes[i]) throw new Error(`${label}: byte mismatch ${i}`);
  console.log(`OK ${label.padEnd(34)} total=${String(plan.total).padStart(6)} received=${String(frames).padStart(6)} overhead=${(((frames) / plan.total - 1) * 100).toFixed(1)}%`);
}

// base45 sanity
for (const n of [0, 1, 2, 3, 4, 5, 100, 901]) {
  const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 255;
  const back = b45ToBytes(bytesToB45(b))!;
  if (back.length !== n || back.some((v, i) => v !== b[i])) throw new Error("b45 roundtrip " + n);
}
console.log("OK base45 roundtrip");
// RFC 9285 vectors
const enc = new TextEncoder();
if (bytesToB45(enc.encode("ietf!")) !== "QED8WEX0") throw new Error("RFC vector 1");
if (bytesToB45(enc.encode("Hello!!")) !== "%69 VD92EX0") throw new Error("RFC vector 2");
console.log("OK RFC 9285 vectors");

// schedule sanity: first pass is every chunk exactly once; afterwards only repairs/headers
for (const total of [1, 2, 5, 6, 7, 57, 300, 1000]) {
  const seen = new Set<number>(); const len = cycleLength(total);
  for (let s = 0; s < len; s++) { const k = slotAt(s, total); if (k.kind === "data") { if (seen.has(k.n)) throw new Error("dup"); seen.add(k.n); } else if (k.kind === "repair") throw new Error("early repair " + total); }
  if (seen.size !== total) throw new Error(`schedule total=${total} size=${seen.size}`);
  for (let s = len; s < len + 80; s++) if (slotAt(s, total).kind === "data") throw new Error("data after pass " + total);
}
console.log("OK schedule");

await run(1, 0, 0, "1 byte");
await run(900, 0, 0, "exactly 1 chunk");
await run(901, 0.3, 0, "2 chunks, 30% loss");
await run(5000, 0, 0, "5 KB lossless");
await run(50_000, 0.1, 0, "50 KB 10% loss");
await run(50_000, 0.25, 13, "50 KB 25% loss, late join");
await run(500_000, 0.1, 0, "500 KB 10% loss");
await run(500_000, 0.4, 777, "500 KB 40% loss, late join");
await run(5_000_000, 0.15, 123, "5 MB 15% loss, late join");
await run(5_000_000, 0.3, 0, "5 MB 30% loss");
await run(20_000_000, 0.05, 0, "20 MB 5% loss");
await run(100_000, 0.5, 40, "100 KB 50% loss, late join");
await run(300_000, 0.2, 5, "300 KB chunk=600, 20% loss", 600);
await run(300_000, 0.2, 5, "300 KB chunk=1400, 20% loss", 1400);
await run(300_000, 0.2, 5, "300 KB chunk=2000, 20% loss", 2000);
await run(300_001, 0.1, 0, "300 KB chunk=1001 (odd), 10% loss", 1001);
{
  const plan = createPlan({ name: "doc.pdf", type: "application/pdf", size: 1234, crc: 99, origSize: 99999 });
  const h = parseFrame(plan.headerFrame) as ParsedHeader;
  if (h.kind !== "header" || !h.meta.compressed || h.meta.origSize !== 99999 || h.meta.size !== 1234 || h.name !== "doc.pdf" || h.mime !== "application/pdf") throw new Error("compressed header roundtrip");
  const plain = parseFrame(createPlan({ name: "a", type: "", size: 10, crc: 1 }).headerFrame) as ParsedHeader;
  if (plain.meta.compressed || plain.meta.origSize !== 10) throw new Error("plain header");
  console.log("OK compressed header flag");
}
console.log("ALL PASS");

// Every frame in the stream must be the same length => the same QR version/grid.
{
  const size = 100_003; const bytes = new Uint8Array(size).map((_, i) => (i * 13) & 255);
  for (const chunk of [600, 900, 1400, 2000]) {
    const plan = createPlan({ name: "same-size.bin", type: "application/octet-stream", size, crc: crc32(bytes), chunk, origSize: size + 50 });
    const src = makeSource(bytes, chunk);
    const lens = new Set<number>();
    for (let seq = 0; seq < plan.total + 120; seq++) lens.add((await frameAt(plan, src, seq)).text.length);
    if (lens.size !== 1) throw new Error(`frame length varies at chunk=${chunk}: ${[...lens].join(",")}`);
  }
  console.log("OK every frame (header, data, last chunk, repair) has identical length");
}
// Instant start: the very first frame seen (a repair frame, mid-stream) is enough to create the decoder.
{
  const size = 60_000; const bytes = new Uint8Array(size).map((_, i) => (i * 29) & 255);
  const plan = createPlan({ name: "instant.bin", type: "", size, crc: crc32(bytes), chunk: 1100 });
  const src = makeSource(bytes, plan.chunk);
  const first = parseFrame((await frameAt(plan, src, plan.total + 40)).text)!;
  if (first.kind !== "repair") throw new Error("expected a repair frame");
  const dec = new FountainDecoder(first.meta);
  if (dec.total !== plan.total || dec.size !== size || dec.chunk !== plan.chunk) throw new Error("meta mismatch");
  // Foreign / corrupted QR payloads must be rejected, not crash.
  for (const junk of ["HTTPS://EXAMPLE.COM/SOME/PATH?Q=1".repeat(3), "0".repeat(80), plan.headerFrame.slice(0, -3), plan.headerFrame + "AB"]) {
    if (parseFrame(junk) !== null) throw new Error("junk accepted: " + junk.slice(0, 20));
  }
  console.log("OK instant start from a mid-stream repair frame; junk payloads rejected");
}
console.log("ALL PASS 2");

{
  const bytes = new Uint8Array(101).map((_, index) => index);
  const plan = createPlan({
    name: "direct.bin",
    type: "application/octet-stream",
    size: bytes.length,
    crc: crc32(bytes),
    chunk: 100,
  });
  const meta = (parseFrame(plan.headerFrame) as ParsedHeader).meta;
  const dec = new FountainDecoder(meta);
  if (dec.addDirectChunk(-1, bytes.subarray(0, 100))) throw new Error("negative direct chunk index accepted");
  if (dec.addDirectChunk(meta.total, bytes.subarray(0, 1))) throw new Error("out-of-range direct chunk accepted");
  if (dec.addDirectChunk(0, bytes.subarray(0, 99))) throw new Error("short direct chunk accepted");
  if (!dec.addDirectChunk(1, bytes.subarray(100))) throw new Error("valid final direct chunk rejected");
  if (!dec.addDirectChunk(0, bytes.subarray(0, 100))) throw new Error("valid direct chunk rejected");
  if (crc32(dec.result()) !== plan.crc) throw new Error("direct chunks did not reconstruct payload");
  console.log("OK direct chunks: index and payload validation");
}
