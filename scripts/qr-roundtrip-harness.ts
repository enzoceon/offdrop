import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { buildSequence, crc32, parseFrame, planFile, reconstruct, type ParsedHeader } from "../src/lib/qr-protocol";

type Transfer = { header: ParsedHeader; chunks: Map<number, Uint8Array> };

async function decodeRendered(text: string) {
  const pngBuffer = await QRCode.toBuffer(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 720,
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
  const size = 192 * 1024 + 137;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 17) & 255;

  const plan = planFile(bytes, "roundtrip.bin", "application/octet-stream", bytes.length);
  const slots = buildSequence(plan);
  let transfer: Transfer | null = null;

  for (let pass = 0; pass < 2 && (!transfer || transfer.chunks.size < transfer.header.total); pass++) {
    for (const slot of slots.slice(Math.floor(slots.length / 3)).concat(slots.slice(0, Math.floor(slots.length / 3)))) {
      const parsed = parseFrame(await decodeRendered(slot.text));
      if (!parsed) throw new Error("Parser rejected a decoded frame.");
      if (parsed.kind === "header") {
        if (!transfer || transfer.header.id !== parsed.id) transfer = { header: parsed, chunks: new Map() };
      } else if (transfer && parsed.id === transfer.header.id && parsed.index < transfer.header.total) {
        transfer.chunks.set(parsed.index, parsed.payload);
      }
    }
  }

  if (!transfer) throw new Error("No header decoded.");
  if (transfer.chunks.size !== transfer.header.total) throw new Error(`Missing chunks: ${transfer.chunks.size}/${transfer.header.total}`);
  const ordered = Array.from({ length: transfer.header.total }, (_, i) => transfer!.chunks.get(i)!);
  const out = reconstruct(ordered, transfer.header.size);
  if (out.length !== bytes.length) throw new Error("Reassembled byte length mismatch.");
  if (crc32(out) !== plan.crc) throw new Error("CRC mismatch after QR roundtrip.");
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== out[i]) throw new Error(`Byte mismatch at ${i}`);
  console.log(`QR roundtrip OK: ${bytes.length} bytes, ${plan.total} chunks, ${slots.length} rendered/decode-verified slots.`);
}

await run();