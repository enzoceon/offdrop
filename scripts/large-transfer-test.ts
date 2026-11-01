import {
  FountainDecoder,
  createPlan,
  crc32,
  cycleLength,
  frameAt,
  parseFrame,
  type ChunkSource,
  type ParsedHeader,
} from "../src/lib/qr-protocol.ts";

async function run() {
  const size = 100 * 1024 * 1024;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 17) & 255;

  const plan = createPlan({
    name: "large-transfer.bin",
    type: "application/octet-stream",
    size,
    crc: crc32(bytes),
    chunk: 2600,
  });
  const source: ChunkSource = {
    read: (index) => bytes.subarray(index * plan.chunk, Math.min(size, (index + 1) * plan.chunk)),
    readRange: (start, count) =>
      bytes.subarray(start * plan.chunk, Math.min(size, (start + count) * plan.chunk)),
  };

  let decoder: FountainDecoder | null = null;
  let header: ParsedHeader | null = null;
  let frames = 0;
  const startedAt = performance.now();

  for (let seq = 0; seq < cycleLength(plan.total) && !decoder?.complete; seq++) {
    const { text } = await frameAt(plan, source, seq);
    const parsed = parseFrame(text);
    if (!parsed) throw new Error(`Frame ${seq} could not be parsed.`);
    frames++;
    if (parsed.kind === "header") {
      if (!header) {
        header = parsed;
        decoder = new FountainDecoder(parsed);
      }
    } else {
      decoder?.add(parsed);
    }
  }

  if (!decoder?.complete)
    throw new Error(`Transfer stalled at ${decoder?.count}/${plan.total} chunks.`);
  const output = decoder.result();
  if (output.length !== size || crc32(output) !== plan.crc) {
    throw new Error("100 MB transfer failed its length or checksum check.");
  }

  const elapsed = (performance.now() - startedAt) / 1000;
  console.log(
    `100 MB transfer OK: ${plan.total} chunks, ${frames} frames, ${elapsed.toFixed(1)}s encode/decode, checksum verified.`,
  );
}

await run();
