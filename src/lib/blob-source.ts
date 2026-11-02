import type { ChunkSource } from "./qr-protocol";

/** Reads chunks straight from a Blob/File (works for any size; keeps a small LRU of recent slices). */
export class BlobSource implements ChunkSource {
  private cache = new Map<string, Uint8Array>();
  constructor(
    private blob: Blob,
    private chunk: number,
  ) {}

  private async slice(start: number, count: number): Promise<Uint8Array> {
    const key = `${start}:${count}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const from = start * this.chunk;
    const to = Math.min(this.blob.size, (start + count) * this.chunk);
    const bytes = new Uint8Array(await this.blob.slice(from, to).arrayBuffer());
    this.cache.set(key, bytes);
    // Keep roughly <= 24 MB cached (repair blocks are re-read round-robin).
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
