// End-to-end check of the real QR layer: every sampled frame is rendered to a
// PNG QR code, decoded back with jsQR (the same decoder the app falls back to),
// parsed, and fed to the receiver — with some frames dropped to exercise repair.
//
// Run with a TS runner that supports top-level await, e.g. `bun scripts/qr-roundtrip-harness.ts`.
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import {
  FountainDecoder,
  createPlan,
  crc32,
  cycleLength,
  frameAt,
  parseFrame,
  type ChunkSource,
  type ParsedHeader,
} from "../src/lib/qr-protocol";

async function decodeRendered(text: string) {
  const pngBuffer = await QRCode.toBuffer(text, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 1000,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const png = PNG.sync.read(pngBuffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, {
    inversionAttempts: "dontInvert",
  });
  if (result?.data !== text) throw new Error("Rendered QR did not decode back to the original frame.");
  return result.data;
}

async function run() {
  const size = 120 * 1024 + 137;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 17) & 255;

  const plan = createPlan({ name: "roundtrip.bin", type: "application/octet-stream", size, crc: crc32(bytes) });
  const source: ChunkSource = {
    read: (i) => bytes.subarray(i * plan.chunk, Math.min(size, (i + 1) * plan.chunk)),
    readRange: (s, c) => bytes.subarray(s * plan.chunk, Math.min(size, (s + c) * plan.chunk)),
  };

  let header: ParsedHeader | null = null;
  let decoder: FountainDecoder | null = null;
  let rendered = 0;
  const limit = cycleLength(plan.total) * 3;
  for (let seq = 0; seq < limit && !decoder?.complete; seq++) {
    // Drop every 7th frame to simulate camera misses.
    if (seq % 7 === 3) continue;
    const { text } = await frameAt(plan, source, seq);
    const parsed = parseFrame(await decodeRendered(text));
    rendered++;
    if (!parsed) throw new Error("Parser rejected a decoded frame.");
    if (parsed.kind === "header") {
      if (!header) {
        header = parsed;
        decoder = new FountainDecoder(parsed);
      }
    } else decoder?.add(parsed);
  }

  if (!decoder?.complete) throw new Error(`Transfer did not complete (${decoder?.count}/${plan.total}).`);
  const out = decoder.result();
  if (out.length !== bytes.length) throw new Error("Reassembled byte length mismatch.");
  if (crc32(out) !== plan.crc) throw new Error("CRC mismatch after QR roundtrip.");
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== out[i]) throw new Error(`Byte mismatch at ${i}`);
  console.log(`QR roundtrip OK: ${bytes.length} bytes, ${plan.total} chunks, ${rendered} frames rendered + decoded.`);
}

await run();
