// OFFDROP QR-stream protocol — splits a file into small QR chunks and reassembles.
// Header format (compact version prefix, pipe-separated metadata, then base64 chunk data):
//   OD3|<id>|<seq36>|<total36>|<bytes36>|<chunkSize36>|<mime64>|<filename64>|<base64>
// The receiver collects unique n values until it has the required count, then concatenates.
//
// IMPORTANT: chunk size is chosen per-transfer (based on file size) and carried
// in every frame's metadata ("c"). The receiver MUST use the chunk size from the
// metadata to compute how many frames are required — never a hardcoded constant —
// because different transfers may use different chunk sizes.

export interface ChunkMeta {
  i: string; // transfer id
  n: number; // sequence
  t: number; // total
  m: string; // mime
  f: string; // filename
  s: number; // total size (bytes)
  c: number; // chunk size (base64 chars) used for THIS transfer
}

export interface Transfer {
  id: string;
  mime: string;
  filename: string;
  size: number;
  total: number;
  chunkSize: number;
  chunks: Map<number, string>;
}

export const PROTOCOL_PREFIX = "OD3";
const LEGACY_PROTOCOL_PREFIX = "OD2";

// MIN_FRAMES keeps very tiny files from cycling too fast to be visually trackable.
export const MIN_FRAMES = 12;

// --- Adaptive chunk sizing -------------------------------------------------
// A fixed tiny chunk size (e.g. 64 base64 chars) makes any real file require
// thousands of QR frames, which makes transfers take many minutes and fail in
// practice (any single missed frame means waiting for the whole loop to come
// back around). Instead we target a roughly constant number of frames per
// transfer, scaling chunk size UP for bigger files, while staying well under
// real QR byte-mode capacity at error-correction level Q (~1,663 bytes max at
// QR version 40). We cap far below that to keep module density low enough for
// phone-to-phone scanning instead of merely generating a technically valid QR.

// Roughly how many frames we're willing to ask the user to scan for a typical
// transfer. Tune this for your own latency/reliability tradeoff.
const TARGET_FRAMES = 360;

// Floor: keeps tiny files (a few KB) from being split into needlessly many
// frames, and guarantees we never choose 0/negative chunk sizes.
const MIN_CHUNK_SIZE = 240;

// Ceiling: keeps payload size safely below dense QR limits at correctionLevel
// "Q", even for long filenames.
const MAX_CHUNK_SIZE = 420;

export function expectedBase64Length(byteSize: number): number {
  if (byteSize <= 0) return 0;
  return Math.ceil(byteSize / 3) * 4;
}

/**
 * Pick a base64-chars-per-QR chunk size for a file of this size, aiming for
 * roughly TARGET_FRAMES total frames, clamped to [MIN_CHUNK_SIZE, MAX_CHUNK_SIZE].
 */
export function chooseChunkSize(byteSize: number): number {
  const base64Len = expectedBase64Length(byteSize);
  if (base64Len <= MIN_CHUNK_SIZE) return Math.max(1, base64Len || 1);
  const ideal = Math.ceil(base64Len / TARGET_FRAMES);
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, ideal));
}

/** Number of *data-bearing* frames required for a transfer, given the chunk size actually used for it. */
export function requiredDataChunks(byteSize: number, chunkSize: number): number {
  if (chunkSize <= 0) return 0;
  return Math.ceil(expectedBase64Length(byteSize) / chunkSize);
}

export function buildChunkPayload(meta: ChunkMeta, data: string): string {
  return [
    PROTOCOL_PREFIX,
    meta.i,
    meta.n.toString(36),
    meta.t.toString(36),
    meta.s.toString(36),
    meta.c.toString(36),
    textToBase64(meta.m),
    textToBase64(meta.f),
    data,
  ].join("|");
}

export function parseChunkPayload(payload: string): { meta: ChunkMeta; data: string } | null {
  if (payload.startsWith(`${PROTOCOL_PREFIX}|`)) {
    const parts = payload.split("|");
    if (parts.length !== 9) return null;
    try {
      const meta: ChunkMeta = {
        i: parts[1],
        n: parseBase36(parts[2]),
        t: parseBase36(parts[3]),
        s: parseBase36(parts[4]),
        c: parseBase36(parts[5]),
        m: base64ToText(parts[6]),
        f: base64ToText(parts[7]),
      };
      if (!validMeta(meta)) return null;
      return { meta, data: parts[8] };
    } catch {
      return null;
    }
  }

  if (!payload.startsWith(`${LEGACY_PROTOCOL_PREFIX}|`)) return null;
  const framed = payload.slice(LEGACY_PROTOCOL_PREFIX.length + 1);
  const idx = framed.lastIndexOf("|");
  if (idx < 0) return null;
  try {
    const meta = JSON.parse(framed.slice(0, idx)) as ChunkMeta;
    if (!validMeta(meta)) return null;
    return { meta, data: framed.slice(idx + 1) };
  } catch {
    return null;
  }
}

function validMeta(meta: ChunkMeta): boolean {
  return (
    typeof meta.i === "string" &&
    meta.i.length > 0 &&
    typeof meta.n === "number" &&
    Number.isSafeInteger(meta.n) &&
    typeof meta.t === "number" &&
    Number.isSafeInteger(meta.t) &&
    typeof meta.m === "string" &&
    meta.m.length > 0 &&
    typeof meta.f === "string" &&
    meta.f.length > 0 &&
    typeof meta.s === "number" &&
    Number.isSafeInteger(meta.s) &&
    typeof meta.c === "number" &&
    Number.isSafeInteger(meta.c) &&
    meta.n >= 0 &&
    meta.t >= 1 &&
    meta.n < meta.t &&
    meta.s >= 0 &&
    meta.c >= 1
  );
}

function parseBase36(value: string): number {
  if (!/^[0-9a-z]+$/i.test(value)) return Number.NaN;
  return parseInt(value, 36);
}

export async function fileToChunks(file: File): Promise<{ id: string; chunks: string[] }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const b64 = bytesToBase64(buf);
  const id = Math.random().toString(36).slice(2, 8);
  const chunkSize = chooseChunkSize(file.size);
  const pieces: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    pieces.push(b64.slice(i, i + chunkSize));
  }
  while (pieces.length < MIN_FRAMES) pieces.push("");
  const total = pieces.length;
  const chunks = pieces.map((data, n) =>
    buildChunkPayload(
      {
        i: id,
        n,
        t: total,
        m: file.type || "application/octet-stream",
        f: file.name,
        s: file.size,
        c: chunkSize,
      },
      data,
    ),
  );
  return { id, chunks };
}

export function transferComplete(t: Transfer): boolean {
  if (t.total < 1 || t.chunkSize < 1) return false;
  const required = requiredDataChunks(t.size, t.chunkSize);
  if (required > t.total) return false;
  for (let i = 0; i < required; i++) {
    if (!t.chunks.has(i)) return false;
  }
  return true;
}

export function assembleTransfer(t: Transfer): Blob {
  const parts: string[] = [];
  const required = requiredDataChunks(t.size, t.chunkSize);
  for (let i = 0; i < required; i++) {
    const chunk = t.chunks.get(i);
    if (chunk === undefined) throw new Error("Transfer is missing QR frames.");
    parts.push(chunk);
  }
  const b64 = parts.join("");
  const bytes = base64ToBytes(b64);
  if (bytes.byteLength !== t.size) throw new Error("Transfer size verification failed.");
  return new Blob([bytes as BlobPart], { type: t.mime });
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function textToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function base64ToText(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}
