import {
  CRC_INIT,
  MAX_FILE_BYTES,
  crc32Final,
  crc32Update,
  createPlan,
  type StreamPlan,
} from "./qr-protocol";
import { BlobSource } from "./blob-source";
import { buildColorFrame, buildFrame, QUIET, type BuiltFrame } from "./frame-core";

/** Files up to this size are held in memory for instant random access. */
const IN_MEMORY_LIMIT = 96 * 1024 * 1024;
/** Bytes hashed between UI yields. */
const CRC_BLOCK = 4 * 1024 * 1024;

export interface PreparedFile {
  plan: StreamPlan;
  /** The exact bytes that get framed (the file itself, or its deflated form). */
  blob: Blob;
  /** Bytes saved by compression (0 when sent as-is). */
  savedBytes: number;
  /** Re-plan the same payload at a different chunk size (instant; no re-hash). */
  rechunk(chunk: number): { plan: StreamPlan; blob: Blob };
}

export class PrepareCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
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
  let payloadBlob: Blob = file;

  if (payload) {
    sendSize = payload.length;
    const bytes = payload;
    for (let off = 0; off < bytes.length; off += CRC_BLOCK) {
      crcState = crc32Update(crcState, bytes.subarray(off, Math.min(bytes.length, off + CRC_BLOCK)));
      opts.onProgress?.(Math.min(1, (off + CRC_BLOCK) / bytes.length), "hash");
      await nextTick();
      check();
    }
    payloadBlob = new Blob([bytes as BlobPart]);
  } else if (file.size <= IN_MEMORY_LIMIT) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    check();
    for (let off = 0; off < bytes.length; off += CRC_BLOCK) {
      crcState = crc32Update(crcState, bytes.subarray(off, Math.min(bytes.length, off + CRC_BLOCK)));
      opts.onProgress?.(Math.min(1, (off + CRC_BLOCK) / bytes.length), "hash");
      await nextTick();
      check();
    }
    payloadBlob = file;
  } else {
    for (let off = 0; off < file.size; off += CRC_BLOCK) {
      const block = new Uint8Array(await file.slice(off, Math.min(file.size, off + CRC_BLOCK)).arrayBuffer());
      crcState = crc32Update(crcState, block);
      opts.onProgress?.(Math.min(1, (off + CRC_BLOCK) / file.size), "hash");
      await nextTick();
      check();
    }
    payloadBlob = file;
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
    blob: payloadBlob,
  });
  const first = build(opts.chunk);
  return { ...first, savedBytes: payload ? file.size - payload.length : 0, rechunk: build };
}

// ---------------------------------------------------------------------------
// Frame pipeline
//
// QR encoding is the expensive part of sending. It runs in a small pool of Web
// Workers that build frames a little ahead of the display clock, so the UI thread
// only ever blits a finished bitmap. If workers are unavailable it transparently
// falls back to building on the main thread.
// ---------------------------------------------------------------------------

export type PreparedFrame = BuiltFrame;

export class FramePipeline {
  private ready = new Map<number, PreparedFrame>();
  private inflight = new Set<number>();
  private workers: Worker[] = [];
  private load: number[] = [];
  private inline: BlobSource | null = null;
  private wanted = 0;
  private disposed = false;
  private pumpingInline = false;
  /** Frames consumed per tile: 1 normally, 3 in colour mode. */
  readonly stride: number;
  /** Set when a frame could not be built; the UI shows it and stops playback. */
  error: Error | null = null;
  onChange: (() => void) | null = null;

  constructor(
    private plan: StreamPlan,
    private blob: Blob,
    private ec: "L" | "M" = "M",
    /** EXPERIMENTAL: one tile = 3 frames (R, G, B channels). */
    private color = false,
    private lookahead = 120,
  ) {
    this.stride = color ? 3 : 1;
    this.startWorkers();
  }

  private startWorkers() {
    try {
      const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
      const count = Math.max(1, Math.min(3, cores - 1));
      for (let i = 0; i < count; i++) {
        const worker = new Worker(new URL("./frame-builder.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent) => this.onWorkerMessage(i, event.data);
        worker.onerror = () => this.fallBackToInline();
        worker.postMessage({ type: "init", plan: this.plan, blob: this.blob, ec: this.ec, color: this.color });
        this.workers.push(worker);
        this.load.push(0);
      }
    } catch {
      this.fallBackToInline();
    }
  }

  private fallBackToInline() {
    if (this.inline || this.disposed) return;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.load = [];
    this.inflight.clear();
    this.inline = new BlobSource(this.blob, this.plan.chunk);
    this.pump();
  }

  private onWorkerMessage(index: number, msg: { type: string; frame?: PreparedFrame; message?: string; seq?: number }) {
    if (this.disposed) return;
    this.load[index] = Math.max(0, this.load[index] - 1);
    if (msg.type === "frame" && msg.frame) {
      const frame = msg.frame;
      this.inflight.delete(frame.seq);
      if (frame.seq >= this.wanted) this.ready.set(frame.seq, frame);
      this.onChange?.();
    } else if (msg.type === "error") {
      if (msg.seq !== undefined) this.inflight.delete(msg.seq);
      this.fallBackToInline(); // the main-thread path will surface a real error if one persists
    }
    this.pump();
  }

  /** Declare the frame currently on screen; everything behind it is dropped. */
  want(seq: number) {
    this.wanted = seq;
    for (const key of this.ready.keys()) if (key < seq) this.ready.delete(key);
    this.pump();
  }

  /** Throw away prefetched frames (e.g. after a seek/reset). */
  reset(seq: number) {
    this.ready.clear();
    this.inflight.clear();
    this.want(seq);
  }

  get(seq: number): PreparedFrame | undefined {
    return this.ready.get(seq);
  }

  dispose() {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.ready.clear();
    this.onChange = null;
  }

  private pump() {
    if (this.disposed) return;
    if (this.inline) return void this.pumpInline();
    for (let s = this.wanted; s <= this.wanted + this.lookahead; s += this.stride) {
      if (this.ready.has(s) || this.inflight.has(s)) continue;
      // Least-loaded worker, capped so we don't buffer unboundedly.
      let best = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.load[i] < this.load[best]) best = i;
      if (this.load[best] >= 6) break;
      this.inflight.add(s);
      this.load[best]++;
      this.workers[best].postMessage({ type: "build", seq: s });
    }
  }

  private async pumpInline() {
    if (this.pumpingInline) return;
    this.pumpingInline = true;
    try {
      let built = 0;
      while (!this.disposed && this.inline) {
        let seq = -1;
        for (let s = this.wanted; s <= this.wanted + Math.min(this.lookahead, 12 * this.stride); s += this.stride) {
          if (!this.ready.has(s)) {
            seq = s;
            break;
          }
        }
        if (seq < 0) break;
        const frame = this.color
          ? await buildColorFrame(this.plan, this.inline, seq, this.ec)
          : await buildFrame(this.plan, this.inline, seq, this.ec);
        if (this.disposed) return;
        if (seq >= this.wanted) this.ready.set(seq, frame);
        this.onChange?.();
        if (++built % 2 === 0) await nextTick();
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error("Frame generation failed.");
      this.onChange?.();
    } finally {
      this.pumpingInline = false;
    }
  }
}

// One reusable 1-pixel-per-module scratch bitmap; blitting it up with smoothing off is
// a single GPU-friendly drawImage instead of thousands of canvas path operations.
let scratch: HTMLCanvasElement | null = null;

/** Paint a prepared frame with crisp integer-sized modules (quiet zone is baked in). */
export function paintFrame(canvas: HTMLCanvasElement, frame: PreparedFrame, targetPx = 1000) {
  const { cells } = frame;
  const cell = Math.max(2, Math.floor(targetPx / cells));
  const px = cell * cells;
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("QR canvas is unavailable.");
  scratch ??= document.createElement("canvas");
  if (scratch.width !== cells || scratch.height !== cells) {
    scratch.width = cells;
    scratch.height = cells;
  }
  const sctx = scratch.getContext("2d");
  if (!sctx) throw new Error("QR canvas is unavailable.");
  sctx.putImageData(new ImageData(frame.pixels, cells, cells), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, px, px);
}

export { QUIET };
