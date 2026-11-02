import { CRC_INIT, crc32Final, crc32Update } from "./qr-protocol";

/**
 * Bundle many files into one transferable .zip (method 0 = "stored").
 *
 * Only the headers are materialised; the file contents are referenced as Blob
 * parts, so bundling hundreds of files or several hundred MB costs almost no
 * memory. The sender's outer pipeline still deflate-compresses the whole
 * bundle when that pays off. The receiver gets an ordinary .zip that every OS
 * can open.
 */

const ZIP32_MAX = 0xffffffff;
const CRC_BLOCK = 4 * 1024 * 1024;

const encoder = new TextEncoder();

function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) && ms > 315532800000 ? ms : Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function uniqueNames(files: File[]): string[] {
  const seen = new Map<string, number>();
  return files.map((f) => {
    const clean = (f.name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    const n = seen.get(clean.toLowerCase()) ?? 0;
    seen.set(clean.toLowerCase(), n + 1);
    if (n === 0) return clean;
    const dot = clean.lastIndexOf(".");
    return dot > 0 ? `${clean.slice(0, dot)} (${n + 1})${clean.slice(dot)}` : `${clean} (${n + 1})`;
  });
}

async function fileCrc(file: File, onBytes: (n: number) => void, check: () => void): Promise<number> {
  let state = CRC_INIT;
  for (let off = 0; off < file.size; off += CRC_BLOCK) {
    const block = new Uint8Array(await file.slice(off, Math.min(file.size, off + CRC_BLOCK)).arrayBuffer());
    state = crc32Update(state, block);
    onBytes(block.length);
    await nextTick();
    check();
  }
  return crc32Final(state);
}

export class BundleCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export async function buildZip(
  files: File[],
  opts: { onProgress?: (fraction: number) => void; isCancelled?: () => boolean } = {},
): Promise<File> {
  const check = () => {
    if (opts.isCancelled?.()) throw new BundleCancelled();
  };
  if (files.length === 0) throw new Error("No files to bundle.");
  if (files.length > 65535) throw new Error("Too many files for one bundle (limit 65,535).");
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (totalBytes > ZIP32_MAX - files.length * 1024) throw new Error("Bundle would exceed 4 GB.");

  const names = uniqueNames(files);
  let done = 0;
  const crcs: number[] = [];
  for (const file of files) {
    check();
    crcs.push(
      await fileCrc(
        file,
        (n) => {
          done += n;
          opts.onProgress?.(totalBytes ? done / totalBytes : 1);
        },
        check,
      ),
    );
    if (file.size === 0) opts.onProgress?.(done / Math.max(1, totalBytes));
  }

  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  files.forEach((file, i) => {
    const name = encoder.encode(names[i]);
    const { time, date } = dosDateTime(file.lastModified);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crcs[i], true);
    local.setUint32(18, file.size, true);
    local.setUint32(22, file.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const localHeader = new Uint8Array(30 + name.length);
    localHeader.set(new Uint8Array(local.buffer), 0);
    localHeader.set(name, 30);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crcs[i], true);
    cd.setUint32(20, file.size, true);
    cd.setUint32(24, file.size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    const cdEntry = new Uint8Array(46 + name.length);
    cdEntry.set(new Uint8Array(cd.buffer), 0);
    cdEntry.set(name, 46);
    central.push(cdEntry);

    parts.push(localHeader, file);
    offset += localHeader.length + file.size;
  });

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  parts.push(...(central as BlobPart[]), new Uint8Array(eocd.buffer) as BlobPart);

  opts.onProgress?.(1);
  const stamp = new Date().toISOString().slice(0, 10);
  return new File(parts, `offdrop-${files.length}-files-${stamp}.zip`, { type: "application/zip" });
}
