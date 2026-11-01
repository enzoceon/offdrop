// OFFDROP QR-stream protocol v2.
//
// Goals: carry as many bytes per QR as possible, support big files without ever
// materialising every frame in memory, and recover from missed frames without
// waiting for the whole file to loop again.
//
// Wire format
// -----------
// Every frame is a small binary record, base45-encoded. Base45 only uses the QR
// "alphanumeric" character set, so QR encoders pack it at 5.5 bits/char
// (~97% efficient) instead of the 75% efficiency of base64-in-byte-mode.
// It is also pure text, so native BarcodeDetector and jsQR both read it safely.
//
//   Header  : [0xD1][ver|0x80 if compressed][id u32][size u32][chunk u16][total u32]
//             [crc u32][nameLen u8][mimeLen u8][name utf8][mime utf8]
//             [origSize u32 — only when compressed]
//             `size`/`crc` always describe the bytes actually transmitted. When the
//             compressed flag is set those bytes are a raw-deflate stream of the file.
//   Data    : [0xD2][id u32][index u32][payload <= chunk bytes]
//   Repair  : [0xD3][id u32][seed u32][payload == chunk bytes]
//
// The file is split into blocks of BLOCK_CHUNKS chunks. A repair frame is the
// XOR of a pseudo-random ~50% subset of ONE block's chunks. The subset and the
// block are derived from (id, seed, total), so describing it costs only 4 bytes.
// A receiver missing m chunks of a block needs only ~m+2 repair frames for that
// block, whichever chunks they were — instead of waiting for the sender to loop
// all the way around to those exact frames again.
//
// Playback stream: every data chunk once, in order (so a clean scan finishes in
// the minimum possible time), then an endless run of repair frames cycling
// through the blocks. A repair frame helps any receiver that is missing
// something in its block, so after the first pass no frame is wasted on chunks
// the receiver already has. A header is interleaved every HEADER_EVERY frames
// so a late joiner can lock on at any moment.

// ---------------------------------------------------------------------------
// CRC32 (incremental, so huge files can be hashed block by block)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export const CRC_INIT = 0xffffffff;

/** Feed bytes into a running CRC state. Start from CRC_INIT, finish with crc32Final. */
export function crc32Update(state: number, bytes: Uint8Array): number {
  let c = state;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  return crc32Final(crc32Update(CRC_INIT, bytes));
}

// ---------------------------------------------------------------------------
// Base45 (RFC 9285)
// ---------------------------------------------------------------------------

const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const B45_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < B45.length; i++) B45_LOOKUP[B45.charCodeAt(i)] = i;

export function bytesToB45(bytes: Uint8Array): string {
  const parts: string[] = [];
  const len = bytes.length;
  let i = 0;
  for (; i + 1 < len; i += 2) {
    const n = bytes[i] * 256 + bytes[i + 1];
    const e = Math.floor(n / 2025);
    const rem = n - e * 2025;
    const d = Math.floor(rem / 45);
    const c = rem - d * 45;
    parts.push(B45[c] + B45[d] + B45[e]);
  }
  if (i < len) {
    const n = bytes[i];
    const d = Math.floor(n / 45);
    parts.push(B45[n - d * 45] + B45[d]);
  }
  return parts.join("");
}

export function b45ToBytes(text: string): Uint8Array | null {
  const len = text.length;
  const rem = len % 3;
  if (rem === 1) return null;
  const outLen = Math.floor(len / 3) * 2 + (rem === 2 ? 1 : 0);
  const out = new Uint8Array(outLen);
  let p = 0;
  let i = 0;
  const v = (idx: number) => {
    const code = text.charCodeAt(idx);
    return code < 128 ? B45_LOOKUP[code] : -1;
  };
  for (; i + 2 < len; i += 3) {
    const c = v(i);
    const d = v(i + 1);
    const e = v(i + 2);
    if (c < 0 || d < 0 || e < 0) return null;
    const n = c + d * 45 + e * 2025;
    if (n > 0xffff) return null;
    out[p++] = n >> 8;
    out[p++] = n & 0xff;
  }
  if (rem === 2) {
    const c = v(i);
    const d = v(i + 1);
    if (c < 0 || d < 0) return null;
    const n = c + d * 45;
    if (n > 0xff) return null;
    out[p++] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Payload bytes per frame. ~1.35k alphanumeric chars per QR at EC level M. */
export const DEFAULT_CHUNK_BYTES = 900;

/** A header frame is interleaved after this many data/repair frames. */
export const HEADER_EVERY = 24;

/** Largest file the protocol can describe (u32 sizes). */
export const MAX_FILE_BYTES = 0xffffffff;

/** Above this, warn that the transfer will take a very long time. */
export const LONG_TRANSFER_BYTES = 25 * 1024 * 1024;

/** Chunks per repair block (Gaussian elimination runs per block, so keep it small). */
export const BLOCK_CHUNKS = 256;

const MAGIC_HEADER = 0xd1;
const MAGIC_DATA = 0xd2;
const MAGIC_REPAIR = 0xd3;
const VERSION = 2;
const FLAG_COMPRESSED = 0x80;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface StreamPlan {
  /** True when the transmitted bytes are a deflate-raw stream of the file. */
  compressed: boolean;
  /** Size of the original file (equals `size` when not compressed). */
  origSize: number;
  id: number;
  idHex: string;
  name: string;
  mime: string;
  size: number;
  chunk: number;
  total: number;
  crc: number;
  headerFrame: string;
}

function truncateUtf8(text: string, maxBytes: number): Uint8Array {
  let bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return bytes;
  // Shrink by code points so we never cut a multi-byte character in half.
  const points = Array.from(text);
  while (points.length > 0 && bytes.length > maxBytes) {
    points.pop();
    bytes = encoder.encode(points.join(""));
  }
  return bytes;
}

function putU32(buf: Uint8Array, at: number, v: number) {
  buf[at] = (v >>> 24) & 0xff;
  buf[at + 1] = (v >>> 16) & 0xff;
  buf[at + 2] = (v >>> 8) & 0xff;
  buf[at + 3] = v & 0xff;
}

function getU32(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

export function randomId(): number {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  }
  return (Math.random() * 0x100000000) >>> 0;
}

export function createPlan(input: {
  name: string;
  type: string;
  size: number;
  crc: number;
  chunk?: number;
  id?: number;
  /** Set when `size`/`crc` describe a compressed stream of a file of `origSize` bytes. */
  origSize?: number;
}): StreamPlan {
  if (input.size > MAX_FILE_BYTES) {
    throw new Error("This file is larger than 4 GB, which OFFDROP cannot describe.");
  }
  const chunk = input.chunk ?? DEFAULT_CHUNK_BYTES;
  const id = (input.id ?? randomId()) >>> 0;
  const total = Math.max(1, Math.ceil(input.size / chunk));
  const nameBytes = truncateUtf8(input.name || "offdrop-file", 120);
  const mime = input.type || "application/octet-stream";
  const mimeBytes = truncateUtf8(mime, 80);
  const compressed = input.origSize !== undefined && input.origSize !== input.size;
  const origSize = compressed ? (input.origSize as number) : input.size;
  const buf = new Uint8Array(22 + nameBytes.length + mimeBytes.length + (compressed ? 4 : 0));
  buf[0] = MAGIC_HEADER;
  buf[1] = VERSION | (compressed ? FLAG_COMPRESSED : 0);
  putU32(buf, 2, id);
  putU32(buf, 6, input.size);
  buf[10] = (chunk >> 8) & 0xff;
  buf[11] = chunk & 0xff;
  putU32(buf, 12, total);
  putU32(buf, 16, input.crc >>> 0);
  buf[20] = nameBytes.length;
  buf[21] = mimeBytes.length;
  buf.set(nameBytes, 22);
  buf.set(mimeBytes, 22 + nameBytes.length);
  if (compressed) putU32(buf, 22 + nameBytes.length + mimeBytes.length, origSize);
  return {
    compressed,
    origSize,
    id,
    idHex: id.toString(16).padStart(8, "0"),
    name: decoder.decode(nameBytes),
    mime: decoder.decode(mimeBytes),
    size: input.size,
    chunk,
    total,
    crc: input.crc >>> 0,
    headerFrame: bytesToB45(buf),
  };
}

// ---------------------------------------------------------------------------
// Repair frames: dense random XORs inside a block
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blockCount(total: number): number {
  return Math.ceil(total / BLOCK_CHUNKS);
}

export interface RepairSpec {
  block: number;
  /** First chunk index of the block. */
  start: number;
  /** Number of chunks in the block. */
  count: number;
  /** Bit j set => chunk (start + j) is part of the XOR. */
  bits: Uint32Array;
}

/** Which block and which members does repair frame (id, seed) combine? */
export function repairSpec(id: number, seed: number, total: number): RepairSpec {
  const blocks = blockCount(total);
  const block = seed % blocks;
  const start = block * BLOCK_CHUNKS;
  const count = Math.min(BLOCK_CHUNKS, total - start);
  const rng = mulberry32((id ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0);
  const bits = new Uint32Array(Math.ceil(count / 32));
  let any = false;
  for (let j = 0; j < count; j++) {
    if (rng() < 0.5) {
      bits[j >> 5] |= 1 << (j & 31);
      any = true;
    }
  }
  if (!any) bits[0] |= 1; // never emit an empty combination
  return { block, start, count, bits };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Random-access view over the file being sent. */
export interface ChunkSource {
  /** Bytes of chunk `index` (the last chunk may be shorter than `chunk`). */
  read(index: number): Uint8Array | Promise<Uint8Array>;
  /** Concatenated bytes of `count` consecutive chunks starting at `start`. */
  readRange(start: number, count: number): Uint8Array | Promise<Uint8Array>;
}

export function dataFrame(plan: StreamPlan, index: number, payload: Uint8Array): string {
  const buf = new Uint8Array(9 + payload.length);
  buf[0] = MAGIC_DATA;
  putU32(buf, 1, plan.id);
  putU32(buf, 5, index);
  buf.set(payload, 9);
  return bytesToB45(buf);
}

export async function repairFrame(plan: StreamPlan, seed: number, source: ChunkSource): Promise<string> {
  const spec = repairSpec(plan.id, seed, plan.total);
  const range = await source.readRange(spec.start, spec.count);
  const buf = new Uint8Array(9 + plan.chunk);
  buf[0] = MAGIC_REPAIR;
  putU32(buf, 1, plan.id);
  putU32(buf, 5, seed);
  const out = buf.subarray(9);
  for (let j = 0; j < spec.count; j++) {
    if (!(spec.bits[j >> 5] & (1 << (j & 31)))) continue;
    const from = j * plan.chunk;
    const piece = range.subarray(from, Math.min(range.length, from + plan.chunk));
    for (let i = 0; i < piece.length; i++) out[i] ^= piece[i];
  }
  return bytesToB45(buf);
}

export type SlotKind = "header" | "data" | "repair";

export interface SlotInfo {
  kind: SlotKind;
  /** Data chunk index for "data", repair seed for "repair". */
  n: number;
}

/**
 * Map a position in the endless playback stream to what should be on screen.
 * Headers sit at every (HEADER_EVERY+1)th position; the remaining "body"
 * positions are data chunks 0..total-1, then repair frames forever.
 */
export function slotAt(seq: number, total: number): SlotInfo {
  const hp = HEADER_EVERY + 1;
  if (seq % hp === 0) return { kind: "header", n: 0 };
  const t = seq - Math.floor(seq / hp) - 1; // body position
  if (t < total) return { kind: "data", n: t };
  return { kind: "repair", n: t - total };
}

/** Playback positions (headers included) in the first, data-only pass. */
export function cycleLength(total: number): number {
  const last = total - 1;
  return last + Math.floor(last / HEADER_EVERY) + 2;
}

export async function frameAt(
  plan: StreamPlan,
  source: ChunkSource,
  seq: number,
): Promise<{ text: string; slot: SlotInfo }> {
  const slot = slotAt(seq, plan.total);
  if (slot.kind === "header") return { text: plan.headerFrame, slot };
  if (slot.kind === "data") {
    const payload = await source.read(slot.n);
    return { text: dataFrame(plan, slot.n, payload), slot };
  }
  return { text: await repairFrame(plan, slot.n, source), slot };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export interface ParsedHeader {
  kind: "header";
  compressed: boolean;
  origSize: number;
  id: number;
  name: string;
  mime: string;
  size: number;
  chunk: number;
  total: number;
  crc: number;
}
export interface ParsedData {
  kind: "data";
  id: number;
  index: number;
  payload: Uint8Array;
}
export interface ParsedRepair {
  kind: "repair";
  id: number;
  seed: number;
  payload: Uint8Array;
}
export type ParsedFrame = ParsedHeader | ParsedData | ParsedRepair;

export function parseFrame(text: string): ParsedFrame | null {
  if (!text || text.length < 8 || text.length > 4000) return null;
  const buf = b45ToBytes(text);
  if (!buf || buf.length < 9) return null;
  switch (buf[0]) {
    case MAGIC_HEADER: {
      if (buf.length < 22 || (buf[1] & 0x7f) !== VERSION) return null;
      const compressed = (buf[1] & FLAG_COMPRESSED) !== 0;
      const nameLen = buf[20];
      const mimeLen = buf[21];
      if (buf.length < 22 + nameLen + mimeLen + (compressed ? 4 : 0)) return null;
      const chunk = (buf[10] << 8) | buf[11];
      const size = getU32(buf, 6);
      const total = getU32(buf, 12);
      if (chunk < 16 || total < 1) return null;
      // total must agree with size/chunk, otherwise this is not one of our headers.
      if (total !== Math.max(1, Math.ceil(size / chunk))) return null;
      return {
        kind: "header",
        compressed,
        origSize: compressed ? getU32(buf, 22 + nameLen + mimeLen) : size,
        id: getU32(buf, 2),
        size,
        chunk,
        total,
        crc: getU32(buf, 16),
        name: decoder.decode(buf.subarray(22, 22 + nameLen)),
        mime: decoder.decode(buf.subarray(22 + nameLen, 22 + nameLen + mimeLen)),
      };
    }
    case MAGIC_DATA:
      return { kind: "data", id: getU32(buf, 1), index: getU32(buf, 5), payload: buf.subarray(9) };
    case MAGIC_REPAIR:
      return { kind: "repair", id: getU32(buf, 1), seed: getU32(buf, 5), payload: buf.subarray(9) };
    default:
      return null;
  }
}

interface Equation {
  /** Bit j set => chunk (blockStart + j) is part of the XOR. */
  bits: Uint32Array;
  payload: Uint8Array;
}

function xorInto(dst: Uint8Array, src: Uint8Array) {
  const len = Math.min(dst.length, src.length);
  if (((dst.byteOffset | src.byteOffset | len) & 3) === 0) {
    const d = new Uint32Array(dst.buffer, dst.byteOffset, len >> 2);
    const s = new Uint32Array(src.buffer, src.byteOffset, len >> 2);
    for (let i = 0; i < d.length; i++) d[i] ^= s[i];
  } else {
    for (let i = 0; i < len; i++) dst[i] ^= src[i];
  }
}

const MAX_EQ_PER_BLOCK = BLOCK_CHUNKS + 24;

/**
 * Collects data + repair frames into the original file.
 * Data frames land directly; repair frames are banked per block and a small
 * Gaussian elimination recovers the missing chunks once enough have arrived.
 */
export class FountainDecoder {
  readonly total: number;
  readonly chunk: number;
  readonly size: number;
  readonly id: number;
  private buffer: Uint8Array;
  private have: Uint8Array;
  private unknownInBlock: Uint16Array;
  private eqs: Equation[][];
  private seenSeeds = new Set<number>();
  count = 0;

  constructor(header: ParsedHeader) {
    this.total = header.total;
    this.chunk = header.chunk;
    this.size = header.size;
    this.id = header.id;
    // Throws RangeError if the device can't allocate this much; callers catch it.
    this.buffer = new Uint8Array(header.total * header.chunk);
    this.have = new Uint8Array(header.total);
    const blocks = blockCount(header.total);
    this.unknownInBlock = new Uint16Array(blocks);
    for (let b = 0; b < blocks; b++) {
      this.unknownInBlock[b] = Math.min(BLOCK_CHUNKS, header.total - b * BLOCK_CHUNKS);
    }
    this.eqs = Array.from({ length: blocks }, () => []);
  }

  get complete() {
    return this.count === this.total;
  }

  has(index: number) {
    return this.have[index] === 1;
  }

  /** 0..1, counting banked repair frames that will soon resolve missing chunks. */
  get progress() {
    let banked = 0;
    for (let b = 0; b < this.eqs.length; b++) {
      banked += Math.min(this.eqs[b].length, this.unknownInBlock[b]);
    }
    return Math.min(1, (this.count + banked) / this.total);
  }

  /** Returns true if this frame taught the decoder something new. */
  add(frame: ParsedData | ParsedRepair): boolean {
    if (frame.id !== this.id || this.complete) return false;
    if (frame.kind === "data") {
      if (frame.index >= this.total || this.have[frame.index]) return false;
      const expected =
        frame.index === this.total - 1 ? this.size - frame.index * this.chunk : this.chunk;
      if (frame.payload.length !== expected) return false;
      this.setChunk(frame.index, frame.payload);
      return true;
    }
    if (frame.payload.length !== this.chunk || this.seenSeeds.has(frame.seed)) return false;
    this.seenSeeds.add(frame.seed);
    const spec = repairSpec(frame.id, frame.seed, this.total);
    if (this.unknownInBlock[spec.block] === 0) return false;
    const list = this.eqs[spec.block];
    if (list.length >= MAX_EQ_PER_BLOCK) return false;
    list.push({ bits: spec.bits, payload: frame.payload.slice() });
    if (list.length >= this.unknownInBlock[spec.block]) this.solveBlock(spec.block);
    return true;
  }

  private setChunk(index: number, payload: Uint8Array) {
    const at = index * this.chunk;
    this.buffer.set(payload, at);
    if (payload.length < this.chunk) this.buffer.fill(0, at + payload.length, at + this.chunk);
    this.have[index] = 1;
    this.count++;
    this.unknownInBlock[Math.floor(index / BLOCK_CHUNKS)]--;
  }

  private chunkView(index: number) {
    return this.buffer.subarray(index * this.chunk, (index + 1) * this.chunk);
  }

  /** Gauss-Jordan over GF(2) on the still-missing chunks of one block. */
  private solveBlock(block: number) {
    const start = block * BLOCK_CHUNKS;
    const count = Math.min(BLOCK_CHUNKS, this.total - start);
    const words = Math.ceil(count / 32);
    const unknownCols: number[] = [];
    for (let j = 0; j < count; j++) if (!this.have[start + j]) unknownCols.push(j);
    if (unknownCols.length === 0 || this.eqs[block].length < unknownCols.length) return;

    // Reduce every stored equation by the chunks we already know.
    const rows = this.eqs[block].map((eq) => {
      const bits = eq.bits.slice();
      const payload = eq.payload.slice();
      for (let j = 0; j < count; j++) {
        if (bits[j >> 5] & (1 << (j & 31)) && this.have[start + j]) {
          bits[j >> 5] &= ~(1 << (j & 31));
          xorInto(payload, this.chunkView(start + j));
        }
      }
      return { bits, payload };
    });

    let rank = 0;
    const pivotRowForCol = new Map<number, number>();
    for (const col of unknownCols) {
      const w = col >> 5;
      const m = 1 << (col & 31);
      let pivot = -1;
      for (let r = rank; r < rows.length; r++) {
        if (rows[r].bits[w] & m) {
          pivot = r;
          break;
        }
      }
      if (pivot < 0) return; // not enough independent equations yet
      const tmp = rows[rank];
      rows[rank] = rows[pivot];
      rows[pivot] = tmp;
      const pr = rows[rank];
      for (let r = 0; r < rows.length; r++) {
        if (r === rank || !(rows[r].bits[w] & m)) continue;
        for (let k = 0; k < words; k++) rows[r].bits[k] ^= pr.bits[k];
        xorInto(rows[r].payload, pr.payload);
      }
      pivotRowForCol.set(col, rank);
      rank++;
    }
    for (const col of unknownCols) {
      const row = rows[pivotRowForCol.get(col)!];
      const index = start + col;
      const len = index === this.total - 1 ? this.size - index * this.chunk : this.chunk;
      this.setChunk(index, row.payload.subarray(0, len));
    }
    this.eqs[block] = [];
  }

  /** Final file bytes once complete. */
  result(): Uint8Array {
    return this.buffer.subarray(0, this.size);
  }
}

/** Biggest file a phone can realistically hold in memory while assembling. */
export const RECEIVE_LIMIT_BYTES = 768 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Density presets
// ---------------------------------------------------------------------------

export type DensityKey = "reliable" | "balanced" | "dense" | "max";

export interface DensityPreset {
  key: DensityKey;
  label: string;
  /** Payload bytes per QR. */
  chunk: number;
  /** QR error-correction level. Lower EC = fewer modules = bigger modules on screen. */
  ec: "L" | "M";
  hint: string;
}

export const DENSITY_PRESETS: DensityPreset[] = [
  { key: "reliable", label: "Reliable", chunk: 600, ec: "M", hint: "Any camera, any distance" },
  { key: "balanced", label: "Balanced", chunk: 900, ec: "M", hint: "Good on most phones" },
  { key: "dense", label: "Dense", chunk: 1400, ec: "L", hint: "~1.5× faster, needs a sharp camera" },
  { key: "max", label: "Max", chunk: 2600, ec: "L", hint: "Fastest, needs a sharp display and steady camera" },
];

export function presetFor(key: DensityKey): DensityPreset {
  return DENSITY_PRESETS.find((p) => p.key === key) ?? DENSITY_PRESETS[2];
}
