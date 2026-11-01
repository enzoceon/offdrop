import QRCode from "qrcode";
import {
  CRC_INIT,
  MAX_FILE_BYTES,
  crc32Final,
  crc32Update,
  createPlan,
  frameAt,
  type ChunkSource,
  type SlotInfo,
  type StreamPlan,
} from "./qr-protocol";

/** Files up to this size are held in memory for instant random access. */
const IN_MEMORY_LIMIT = 96 * 1024 * 1024;
/** Bytes hashed between UI yields. */
const CRC_BLOCK = 4 * 1024 * 1024;

export interface PreparedFile {
  plan: StreamPlan;
  source: ChunkSource;
  /** Bytes saved by compression (0 when sent as-is). */
  savedBytes: number;
  /** Re-plan the same payload at a different chunk size (instant; no re-hash). */
  rechunk(chunk: number): { plan: StreamPlan; source: ChunkSource };
}

export class PrepareCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class MemorySource implements ChunkSource {
  constructor(
    private bytes: Uint8Array,
    private chunk: number,
  ) {}
  read(index: number) {
    return this.bytes.subarray(index * this.chunk, Math.min(this.bytes.length, (index + 1) * this.chunk));
  }
  readRange(start: number, count: number) {
    return this.bytes.subarray(
      start * this.chunk,
      Math.min(this.bytes.length, (start + count) * this.chunk),
    );
  }
}

/** Reads straight from the File so huge files never have to fit in memory. */
class BlobSource implements ChunkSource {
  private cache = new Map<string, Uint8Array>();
  constructor(
    private file: Blob,
    private chunk: number,
  ) {}
  private async slice(start: number, count: number): Promise<Uint8Array> {
    const key = `${start}:${count}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const from = start * this.chunk;
    const to = Math.min(this.file.size, (start + count) * this.chunk);
    const bytes = new Uint8Array(await this.file.slice(from, to).arrayBuffer());
    this.cache.set(key, bytes);
    // Keep roughly <= 24 MB cached.
    let budget = 24 * 1024 * 1024;
    for (const v of this.cache.values()) budget -= v.length;
    while (budget < 0 && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as string;
      budget += this.cache.get(oldest)!.length;
      this.cache.delete(oldest);
    }
    return bytes;
  }
  read(index: number) {
    return this.slice(index, 1);
  }
  readRange(start: number, count: number) {
    return this.slice(start, count);
  }
}

/** Formats that are already compressed: deflating them again only wastes time. */
const INCOMPRESSIBLE = /^(image\/(jpeg|png|webp|avif|heic|heif|gif)|video\/|audio\/(mpeg|mp4|aac|ogg|opus|webm|flac)|application\/(zip|gzip|x-7z|x-rar|vnd\.rar|x-bzip2|x-xz|zstd|pdf-encrypted|vnd\.openxmlformats|vnd\.android\.package|java-archive|x-apple-diskimage))/i;
const INCOMPRESSIBLE_EXT = /\.(jpe?g|png|webp|avif|heic|heif|gif|mp4|m4v|mov|mkv|webm|avi|mp3|m4a|aac|ogg|opus|flac|zip|gz|7z|rar|bz2|xz|zst|docx|xlsx|pptx|apk|jar|dmg|ipa)$/i;

async function collect(stream: ReadableStream<Uint8Array>, onBytes?: (n: number) => void, check?: () => void) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    onBytes?.(total);
    check?.();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function deflate(blob: Blob) {
  // Chromium/Safari/Firefox all ship CompressionStream; cast keeps older lib.dom happy.
  const CS = (globalThis as unknown as { CompressionStream?: new (f: string) => GenericTransformStream }).CompressionStream;
  if (!CS) return null;
  return (blob.stream() as ReadableStream<Uint8Array>).pipeThrough(new CS("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** Returns compressed bytes if deflate meaningfully shrinks the file, else null. */
async function tryCompress(file: File, onProgress: (f: number) => void, check: () => void): Promise<Uint8Array | null> {
  if (file.size < 2048 || file.size > IN_MEMORY_LIMIT) return null;
  if (INCOMPRESSIBLE.test(file.type) || INCOMPRESSIBLE_EXT.test(file.name)) return null;
  if (!deflate(new Blob([]))) return null;
  // Cheap probe: deflate the first 256 KB. If it barely shrinks, don't bother with the rest.
  const probeBlob = file.slice(0, Math.min(file.size, 256 * 1024));
  const probe = await collect(deflate(probeBlob)!);
  check();
  if (probe.length > probeBlob.size * 0.93) return null;
  const out = await collect(
    deflate(file)!,
    (n) => onProgress(Math.min(0.98, n / Math.max(1, file.size * (probe.length / probeBlob.size)))),
    check,
  );
  check();
  return out.length < file.size * 0.93 ? out : null;
}

/**
 * Hash the payload in blocks (yielding to the UI between blocks) and build the
 * transfer plan. Compressible files are deflated first, which can cut the number
 * of frames to send dramatically (documents, text, code, uncompressed media).
 */
export async function prepareFile(
  file: File,
  opts: {
    chunk: number;
    onProgress?: (fraction: number, phase: "compress" | "hash") => void;
    isCancelled?: () => boolean;
    compress?: boolean;
  },
): Promise<PreparedFile> {
  if (file.size === 0) throw new Error("This file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("Files over 4 GB are not supported.");
  const check = () => {
    if (opts.isCancelled?.()) throw new PrepareCancelled();
  };

  let payload: Uint8Array | null = null;
  if (opts.compress !== false) {
    try {
      payload = await tryCompress(file, (f) => opts.onProgress?.(f, "compress"), check);
    } catch (error) {
      if (error instanceof PrepareCancelled) throw error;
      payload = null; // compression is an optimisation; never fail the send over it
    }
  }
  check();

  let crcState = CRC_INIT;
  let sendSize = file.size;
  let makeSource: (chunk: number) => ChunkSource;

  if (payload) {
    sendSize = payload.length;
    const bytes = payload;
    for (let off = 0; off < bytes.length; off += CRC_BLOCK) {
      crcState = crc32Update(crcState, bytes.subarray(off, Math.min(bytes.length, off + CRC_BLOCK)));
      opts.onProgress?.(Math.min(1, (off + CRC_BLOCK) / bytes.length), "hash");
      await nextTick();
      check();
    }
    makeSource = (chunk) => new MemorySource(bytes, chunk);
  } else if (file.size <= IN_MEMORY_LIMIT) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    check();
    for (let off = 0; off < bytes.length; off += CRC_BLOCK) {
      crcState = crc32Update(crcState, bytes.subarray(off, Math.min(bytes.length, off + CRC_BLOCK)));
      opts.onProgress?.(Math.min(1, (off + CRC_BLOCK) / bytes.length), "hash");
      await nextTick();
      check();
    }
    makeSource = (chunk) => new MemorySource(bytes, chunk);
  } else {
    for (let off = 0; off < file.size; off += CRC_BLOCK) {
      const block = new Uint8Array(await file.slice(off, Math.min(file.size, off + CRC_BLOCK)).arrayBuffer());
      crcState = crc32Update(crcState, block);
      opts.onProgress?.(Math.min(1, (off + CRC_BLOCK) / file.size), "hash");
      await nextTick();
      check();
    }
    makeSource = (chunk) => new BlobSource(file, chunk);
  }

  const crc = crc32Final(crcState);
  const build = (chunk: number) => ({
    plan: createPlan({
      name: file.name,
      type: file.type,
      size: sendSize,
      crc,
      chunk,
      origSize: payload ? file.size : undefined,
    }),
    source: makeSource(chunk),
  });
  const first = build(opts.chunk);
  return { ...first, savedBytes: payload ? file.size - payload.length : 0, rechunk: build };
}

// ---------------------------------------------------------------------------
// Frame pipeline: builds QR matrices a little ahead of the display clock so the
// render loop only has to paint pixels. QR encoding is the expensive part of
// sending, and doing it ahead is what lets playback hold a steady frame rate.
// ---------------------------------------------------------------------------

export interface PreparedFrame {
  seq: number;
  slot: SlotInfo;
  /** QR modules per side. */
  size: number;
  /** size*size bytes, 1 = dark module. */
  modules: Uint8Array;
}

export class FramePipeline {
  private ready = new Map<number, PreparedFrame>();
  private worker: Worker | null | undefined;
  private workerSeq = 0;
  private workerPending = new Map<
    number,
    { resolve: (frame: PreparedFrame) => void; reject: (error: Error) => void }
  >();
  private wanted = 0;
  private pumping = false;
  private disposed = false;
  private readonly qrVersion: number;
  /** Set when a frame could not be built; the UI shows it and stops playback. */
  error: Error | null = null;
  onChange: (() => void) | null = null;

  constructor(
    private plan: StreamPlan,
    private source: ChunkSource,
    private ec: "L" | "M" = "M",
    private lookahead = 24,
  ) {
    const maxFrameChars = Math.ceil(((plan.chunk + 9) * 3) / 2);
    this.qrVersion = QRCode.create("A".repeat(maxFrameChars), {
      errorCorrectionLevel: ec,
    }).version;
  }

  /** Declare the frame currently on screen; everything behind it is dropped. */
  want(seq: number) {
    this.wanted = seq;
    for (const key of this.ready.keys()) if (key < seq) this.ready.delete(key);
    void this.pump();
  }

  /** Throw away prefetched frames (e.g. after a seek/reset). */
  reset(seq: number) {
    this.ready.clear();
    this.want(seq);
  }

  get(seq: number): PreparedFrame | undefined {
    return this.ready.get(seq);
  }

  dispose() {
    this.disposed = true;
    this.ready.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.workerPending.values()) {
      pending.reject(new Error("Frame generation was cancelled."));
    }
    this.workerPending.clear();
    this.onChange = null;
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let built = 0;
      while (!this.disposed) {
        let seq = -1;
        for (let s = this.wanted; s <= this.wanted + this.lookahead; s++) {
          if (!this.ready.has(s)) {
            seq = s;
            break;
          }
        }
        if (seq < 0) break;
        const frame = await this.build(seq);
        if (this.disposed) return;
        // The display may have moved on while we were awaiting.
        if (seq >= this.wanted) this.ready.set(seq, frame);
        this.onChange?.();
        // Yield regularly so touch/paint stay responsive.
        if (++built % 2 === 0) await nextTick();
      }
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error : new Error("Frame generation failed.");
      this.onChange?.();
    } finally {
      this.pumping = false;
    }
  }

  private async build(seq: number): Promise<PreparedFrame> {
    const { text, slot } = await frameAt(this.plan, this.source, seq);
    try {
      const { size, modules } = await this.encode(text);
      return { seq, slot, size, modules };
    } catch {
      if (this.disposed) throw new Error("Frame generation was cancelled.");
      const qr = QRCode.create(text, {
        errorCorrectionLevel: this.ec,
        version: this.qrVersion,
      });
      const size = qr.modules.size;
      const modules = new Uint8Array(size * size);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) modules[r * size + c] = qr.modules.get(r, c) ? 1 : 0;
      }
      return { seq, slot, size, modules };
    }
  }

  private encode(text: string): Promise<{ size: number; modules: Uint8Array }> {
    if (this.worker === undefined) {
      try {
        this.worker =
          typeof Worker === "undefined"
            ? null
            : new Worker(new URL("./qr-encode.worker.ts", import.meta.url), {
                type: "module",
              });
      } catch {
        this.worker = null;
      }
      if (this.worker) {
        this.worker.onmessage = (
          event: MessageEvent<{ id: number; size: number; modules: ArrayBuffer; error?: string }>,
        ) => {
          const pending = this.workerPending.get(event.data.id);
          if (!pending) return;
          this.workerPending.delete(event.data.id);
          if (event.data.error) {
            pending.reject(new Error(event.data.error));
            return;
          }
          pending.resolve({
            size: event.data.size,
            modules: new Uint8Array(event.data.modules),
          });
        };
        this.worker.onerror = () => {
          this.worker?.terminate();
          this.worker = null;
          for (const pending of this.workerPending.values()) {
            pending.reject(new Error("QR worker failed."));
          }
          this.workerPending.clear();
        };
      }
    }
    if (!this.worker) {
      const qr = QRCode.create(text, {
        errorCorrectionLevel: this.ec,
        version: this.qrVersion,
      });
      const size = qr.modules.size;
      const modules = new Uint8Array(size * size);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) modules[r * size + c] = qr.modules.get(r, c) ? 1 : 0;
      }
      return Promise.resolve({ size, modules });
    }

    const id = ++this.workerSeq;
    return new Promise((resolve, reject) => {
      this.workerPending.set(id, { resolve, reject });
      this.worker?.postMessage({
        id,
        text,
        errorCorrectionLevel: this.ec,
        version: this.qrVersion,
      });
    });
  }
}

/** Paint a prepared frame, with crisp integer-sized modules and a 4-module quiet zone. */
export function paintFrame(canvas: HTMLCanvasElement, frame: PreparedFrame, targetPx = 1000) {
  const quiet = 4;
  const cells = frame.size + quiet * 2;
  const cell = Math.max(2, Math.floor(targetPx / cells));
  const px = cell * cells;
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("QR canvas is unavailable.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  const { modules, size } = frame;
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r * size + c]) {
        c++;
        continue;
      }
      // Merge horizontal runs into a single rect: far fewer draw ops.
      let end = c + 1;
      while (end < size && modules[r * size + end]) end++;
      ctx.rect((c + quiet) * cell, (r + quiet) * cell, (end - c) * cell, cell);
      c = end;
    }
  }
  ctx.fill();
}
