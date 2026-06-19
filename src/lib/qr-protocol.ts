// OFFDROP QR-stream protocol — splits a file into small QR chunks and reassembles.
// Header format (version prefix, JSON, then "|", then base64 chunk data):
//   OD1|{"i":"<id>","n":<seq>,"t":<total>,"m":"<mime>","f":"<filename>","s":<bytes>}|<base64>
// The receiver collects unique n values until it has t, then concatenates.

export interface ChunkMeta {
  i: string; // transfer id
  n: number; // sequence
  t: number; // total
  m: string; // mime
  f: string; // filename
  s: number; // total size (bytes)
}

export interface Transfer {
  id: string;
  mime: string;
  filename: string;
  size: number;
  total: number;
  chunks: Map<number, string>;
}

export const PROTOCOL_PREFIX = "OD1";

// Small chunks deliberately scan better on real mobile cameras than dense QR blocks.
export const CHUNK_SIZE = 120;
export const MIN_FRAMES = 60;

export function buildChunkPayload(meta: ChunkMeta, data: string): string {
  return `${PROTOCOL_PREFIX}|${JSON.stringify(meta)}|${data}`;
}

export function parseChunkPayload(payload: string): { meta: ChunkMeta; data: string } | null {
  const framed = payload.startsWith(`${PROTOCOL_PREFIX}|`)
    ? payload.slice(PROTOCOL_PREFIX.length + 1)
    : payload;
  const idx = framed.indexOf("|");
  if (idx < 0) return null;
  try {
    const meta = JSON.parse(framed.slice(0, idx)) as ChunkMeta;
    if (
      typeof meta.i !== "string" ||
      typeof meta.n !== "number" ||
      typeof meta.t !== "number" ||
      typeof meta.m !== "string" ||
      typeof meta.f !== "string" ||
      typeof meta.s !== "number"
    )
      return null;
    if (meta.n < 0 || meta.t < 1 || meta.n >= meta.t) return null;
    return { meta, data: framed.slice(idx + 1) };
  } catch {
    return null;
  }
}

export async function fileToChunks(file: File): Promise<{ id: string; chunks: string[] }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const b64 = bytesToBase64(buf);
  const id = Math.random().toString(36).slice(2, 8);
  const pieces: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
    pieces.push(b64.slice(i, i + CHUNK_SIZE));
  }
  while (pieces.length < MIN_FRAMES) pieces.push("");
  const total = pieces.length;
  const chunks = pieces.map((data, n) =>
    buildChunkPayload(
      { i: id, n, t: total, m: file.type || "application/octet-stream", f: file.name, s: file.size },
      data,
    ),
  );
  return { id, chunks };
}

export function transferComplete(t: Transfer): boolean {
  return t.total > 0 && t.chunks.size === t.total;
}

export function assembleTransfer(t: Transfer): Blob {
  const parts: string[] = [];
  for (let i = 0; i < t.total; i++) parts.push(t.chunks.get(i) || "");
  const b64 = parts.join("");
  const bytes = base64ToBytes(b64);
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

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
