// OFFDROP QR-stream protocol — chunk + reconstruct files via QR sequences.
//
// Compact pipe-delimited frame format (smaller than JSON, fits more bytes per QR):
//   Header:  H|<id>|<name>|<mime>|<size>|<total>|<crc32>
//   Data:    D|<id>|<index>|<base64payload>
//
// CRC32 over the original file bytes is included in the header so the receiver
// can verify integrity end-to-end after reconstruction.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Hand-rolled base64 (no btoa/atob; works on any byte range without string-size limits).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < 64; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

export function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out +=
      B64[a >> 2] +
      B64[((a & 3) << 4) | (b >> 4)] +
      B64[((b & 15) << 2) | (c >> 6)] +
      B64[c & 63];
  }
  if (i < len) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < len ? B64[(b & 15) << 2] : "=";
    out += "=";
  }
  return out;
}

export function b64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const outLen = Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  const out = new Uint8Array(outLen);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64_LOOKUP[clean.charCodeAt(i)] << 18) |
      (B64_LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      (B64_LOOKUP[clean.charCodeAt(i + 2)] << 6) |
      B64_LOOKUP[clean.charCodeAt(i + 3)];
    if (p < outLen) out[p++] = (n >> 16) & 0xff;
    if (p < outLen) out[p++] = (n >> 8) & 0xff;
    if (p < outLen) out[p++] = n & 0xff;
  }
  return out;
}

export interface ChunkPlan {
  id: string;
  name: string;
  mime: string;
  size: number;
  total: number;
  crc: number;
  headerFrame: string;
  dataFrames: string[];
}

// 300 raw bytes -> 400 base64 chars + small text header = ~414 chars per QR,
// which fits comfortably inside QR @ EC level M and stays decodable on phones.
const RAW_CHUNK_BYTES = 300;

export interface PlanInput {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

export function planFile(input: PlanInput): ChunkPlan;
export function planFile(bytes: Uint8Array, name: string, mime: string, size: number): ChunkPlan;
export function planFile(inputOrBytes: PlanInput | Uint8Array, name?: string, mime?: string, size?: number): ChunkPlan {
  const file: PlanInput = inputOrBytes instanceof Uint8Array
    ? {
        bytes: inputOrBytes,
        name: name || "offdrop-file",
        type: mime || "application/octet-stream",
        size: size ?? inputOrBytes.length,
      }
    : inputOrBytes;
  const id = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const total = Math.max(1, Math.ceil(file.bytes.length / RAW_CHUNK_BYTES));
  const crc = crc32(file.bytes);
  const dataFrames: string[] = new Array(total);
  for (let i = 0; i < total; i++) {
    const slice = file.bytes.subarray(i * RAW_CHUNK_BYTES, (i + 1) * RAW_CHUNK_BYTES);
    dataFrames[i] = `D|${id}|${i}|${bytesToB64(slice)}`;
  }
  const mime = file.type || "application/octet-stream";
  const safeName = file.name.replace(/\|/g, "_");
  const headerFrame = `H|${id}|${safeName}|${mime}|${file.size}|${total}|${crc}`;
  return { id, name: safeName, mime, size: file.size, total, crc, headerFrame, dataFrames };
}

export interface ParsedHeader {
  kind: "header";
  id: string;
  name: string;
  mime: string;
  size: number;
  total: number;
  crc: number;
}
export interface ParsedData {
  kind: "data";
  id: string;
  index: number;
  payload: Uint8Array;
}

export function parseFrame(text: string): ParsedHeader | ParsedData | null {
  if (!text) return null;
  if (text.startsWith("H|")) {
    const parts = text.split("|");
    if (parts.length < 7) return null;
    const size = Number(parts[4]);
    const total = Number(parts[5]);
    const crc = Number(parts[6]);
    if (!Number.isFinite(size) || !Number.isFinite(total) || !Number.isFinite(crc)) return null;
    return {
      kind: "header",
      id: parts[1],
      name: parts[2],
      mime: parts[3],
      size,
      total,
      crc: crc >>> 0,
    };
  }
  if (text.startsWith("D|")) {
    const idPipe = text.indexOf("|", 2);
    const idxPipe = text.indexOf("|", idPipe + 1);
    if (idPipe < 0 || idxPipe < 0) return null;
    const id = text.slice(2, idPipe);
    const index = Number(text.slice(idPipe + 1, idxPipe));
    const b64 = text.slice(idxPipe + 1);
    if (!Number.isFinite(index) || index < 0) return null;
    return { kind: "data", id, index, payload: b64ToBytes(b64) };
  }
  return null;
}

export function reconstruct(chunks: Uint8Array[], expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize);
  let offset = 0;
  for (const c of chunks) {
    if (offset >= expectedSize) break;
    const take = c.subarray(0, Math.min(c.length, expectedSize - offset));
    out.set(take, offset);
    offset += take.length;
  }
  return out.subarray(0, offset);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Practical ceiling — beyond this a QR transfer is impractical (would take many
// minutes to loop through). We surface a warning in the UI rather than silently fail.
export const PRACTICAL_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MB

// How often to interleave a header frame in the playback sequence so a receiver
// joining mid-stream can latch onto the transfer quickly.
export const HEADER_EVERY = 6;

export interface Slot {
  text: string;
  isHeader: boolean;
  /** Underlying data-chunk index (0..total-1), or null if this slot is a header. */
  dataIndex: number | null;
}

export function buildSequence(plan: ChunkPlan): Slot[] {
  const out: Slot[] = [];
  // Always lead with a header so cold scans lock on instantly.
  out.push({ text: plan.headerFrame, isHeader: true, dataIndex: null });
  for (let i = 0; i < plan.total; i++) {
    out.push({ text: plan.dataFrames[i], isHeader: false, dataIndex: i });
    // Sprinkle headers throughout so a late-joining receiver can latch on
    // no matter where in the loop it tunes in.
    if ((i + 1) % HEADER_EVERY === 0 && i < plan.total - 1) {
      out.push({ text: plan.headerFrame, isHeader: true, dataIndex: null });
    }
  }
  return out;
}
