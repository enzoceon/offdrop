import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import {
  Camera,
  CameraOff,
  CheckCircle2,
  Download,
  Loader2,
  ScanLine,
  Share2,
  SwitchCamera,
  Music2,
  FileText,
} from "lucide-react";
import {
  parseFrame,
  reconstruct,
  crc32,
  type ParsedHeader,
} from "@/lib/qr-protocol";
import { saveItem } from "@/lib/history";
import { sfx } from "@/lib/feedback";

interface Transfer {
  header: ParsedHeader;
  chunks: Map<number, Uint8Array>;
  startedAt: number;
}

type Point = { x: number; y: number };
type QrBox = { w: number; h: number; corners: [Point, Point, Point, Point] };
type ScanResult = { data: string; corners: [Point, Point, Point, Point] };
type DonePreview = {
  name: string;
  mime: string;
  size: number;
  blob: Blob;
  url?: string;
  aspectRatio: number;
};
type ScannerProps = {
  onSaved: () => void;
  onCompleteAction?: () => void;
  stopRequestKey?: number;
  onStopRequestComplete?: () => void;
  onBusyChange?: (busy: boolean) => void;
};

const CAMERA_TRANSITION_MS = 320;
const DECODE_INTERVAL_MS = 34;

function waitForVideoMetadata(video: HTMLVideoElement) {
  if (video.readyState >= video.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Camera metadata did not load."));
    }, 5000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
    };
    const onMetadata = () => {
      cleanup();
      resolve();
    };
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
  });
}

function waitForUsableVideo(video: HTMLVideoElement) {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
    };
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
        return;
      }
      if (performance.now() - started > 5000) {
        cleanup();
        reject(new Error("Camera started, but no video frame was received."));
        return;
      }
      window.setTimeout(check, 40);
    };
    video.addEventListener("loadedmetadata", check);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    check();
  });
}

function decodeQr(ctx: CanvasRenderingContext2D, w: number, h: number): ScanResult | null {
  const side = Math.min(w, h);
  const attempts: Array<[number, number, number, number]> = [[0, 0, w, h]];
  if (side !== w || side !== h) {
    attempts.push([Math.round((w - side) / 2), Math.round((h - side) / 2), side, side]);
  }
  const medium = Math.max(220, Math.round(side * 0.82));
  const tight = Math.max(192, Math.round(side * 0.62));
  for (const crop of [medium, tight]) {
    if (crop < side) attempts.push([Math.round((w - crop) / 2), Math.round((h - crop) / 2), crop, crop]);
  }

  let firstAttempt = true;
  for (const [sx, sy, sw, sh] of attempts) {
    const img = ctx.getImageData(sx, sy, sw, sh);
    const code = jsQR(img.data, sw, sh, {
      inversionAttempts: firstAttempt ? "dontInvert" : "attemptBoth",
    });
    firstAttempt = false;
    if (!code?.data) continue;
    const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = code.location;
    const offset = (p: Point): Point => ({ x: p.x + sx, y: p.y + sy });
    return {
      data: code.data,
      corners: [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner].map(offset) as [
        Point,
        Point,
        Point,
        Point,
      ],
    };
  }
  return null;
}

function mediaLabel(mime?: string) {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

async function detectAspectRatio(blob: Blob, mime: string, url: string): Promise<number> {
  if (mime.startsWith("image/")) {
    return new Promise<number>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 4 / 3);
      img.onerror = () => resolve(4 / 3);
      img.src = url;
    });
  }
  if (mime.startsWith("video/")) {
    return new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve(v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9);
      v.onerror = () => resolve(16 / 9);
      v.src = url;
    });
  }
  // Audio / generic
  return mime.startsWith("audio/") ? 16 / 9 : 4 / 3;
}

function AnimatedPercent({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    const start = performance.now();
    const duration = 420;
    let frame = 0;
    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (to - from) * eased;
      setDisplay(next);
      if (t < 1) frame = requestAnimationFrame(animate);
      else fromRef.current = to;
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <div className="mt-3 text-center text-5xl font-medium leading-none tabular-nums text-foreground sm:text-6xl">
      {Math.round(display)}%
    </div>
  );
}

export function Scanner({
  onSaved,
  onCompleteAction,
  stopRequestKey = 0,
  onStopRequestComplete,
  onBusyChange,
}: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const transferRef = useRef<Transfer | null>(null);
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const lastDecodeRef = useRef(0);
  const finishingRef = useRef(false);
  const scanningRef = useRef(false);
  const boxVisibleRef = useRef(false);
  const lastBoxUpdateRef = useRef(0);
  const frameErrorCountRef = useRef(0);
  const stopRef = useRef<(showStopping?: boolean, reason?: "manual" | "internal") => Promise<void>>(
    async () => {},
  );
  const facingRef = useRef<"environment" | "user">("environment");
  const doneUrlRef = useRef<string | null>(null);

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ have: 0, total: 0 });
  const [scanInfo, setScanInfo] = useState<{ name: string; mime: string; size: number } | null>(
    null,
  );
  const [qrBox, setQrBox] = useState<QrBox | null>(null);
  const [done, setDone] = useState<DonePreview | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  async function start(facingMode: "environment" | "user" = facingRef.current, force = false) {
    if (!force && (active || starting || stopping)) return;
    facingRef.current = facingMode;
    setFacing(facingMode);
    const startedAt = performance.now();
    setError(null);
    if (doneUrlRef.current) {
      URL.revokeObjectURL(doneUrlRef.current);
      doneUrlRef.current = null;
    }
    setDone(null);
    setStarting(true);
    finishingRef.current = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera permission is unavailable in this browser.");
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 60 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
      }
      streamRef.current = stream;
      for (const track of stream.getVideoTracks()) {
        const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
          focusMode?: string[];
        };
        if (capabilities?.focusMode?.includes("continuous")) {
          await track
            .applyConstraints({
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            })
            .catch(() => {});
        }
      }
      if (videoRef.current) {
        const video = videoRef.current;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("playsinline", "true");
        video.srcObject = stream;
        await waitForVideoMetadata(video);
        await video.play();
        await waitForUsableVideo(video);
      }
      const remaining = CAMERA_TRANSITION_MS - (performance.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      scanningRef.current = true;
      setActive(true);
      setStarting(false);
      cancelAnimationFrame(rafRef.current);
      tick();
    } catch (e) {
      setStarting(false);
      setStopping(false);
      setActive(false);
      setError(
        e instanceof Error ? e.message : "Camera unavailable. Grant camera permission and retry.",
      );
    }
  }

  async function stop(showStopping = false) {
    const shouldShowStopping = showStopping && (active || starting || Boolean(streamRef.current));
    if (shouldShowStopping) {
      setStopping(true);
      setStarting(false);
      await new Promise((resolve) => setTimeout(resolve, CAMERA_TRANSITION_MS));
    }
    scanningRef.current = false;
    finishingRef.current = false;
    transferRef.current = null;
    lastSeenRef.current.clear();
    setActive(false);
    setStarting(false);
    setQrBox(null);
    setScanInfo(null);
    setProgress({ have: 0, total: 0 });
    boxVisibleRef.current = false;
    cancelAnimationFrame(rafRef.current);
    // Release camera + decoder fully — fixes mobile lag on repeated start/stop
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    }
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    streamRef.current = null;
    setStopping(false);
  }
  stopRef.current = stop;

  async function flipCamera() {
    if (!active || stopping || starting) return;
    const next = facingRef.current === "environment" ? "user" : "environment";
    await stop(false);
    await start(next, true);
  }

  function clearDonePreview() {
    if (doneUrlRef.current) {
      URL.revokeObjectURL(doneUrlRef.current);
      doneUrlRef.current = null;
    }
    setDone(null);
  }

  function downloadDone() {
    if (!done?.blob || !done.url) return;
    const a = document.createElement("a");
    a.href = done.url;
    a.download = done.name || "offdrop-file";
    a.click();
    clearDonePreview();
    onCompleteAction?.();
  }

  async function shareDone() {
    if (!done?.blob) return;
    try {
      const file = new File([done.blob], done.name || "offdrop-file", { type: done.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: done.name });
      } else {
        downloadDone();
        return;
      }
      clearDonePreview();
      onCompleteAction?.();
    } catch {
      /* user cancelled */
    }
  }

  function tick() {
    if (!scanningRef.current) return;
    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const now = performance.now();
      if (
        video &&
        canvas &&
        now - lastDecodeRef.current >= DECODE_INTERVAL_MS &&
        video.readyState >= video.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        lastDecodeRef.current = now;
        const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
        const w = Math.max(1, Math.round(video.videoWidth * scale));
        const h = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          const code = decodeQr(ctx, w, h);
          frameErrorCountRef.current = 0;
          if (code?.data) {
            handleScan(code.data);
            const box: QrBox = { w, h, corners: code.corners };
            if (now - lastBoxUpdateRef.current > 60) {
              boxVisibleRef.current = true;
              lastBoxUpdateRef.current = now;
              setQrBox(box);
            }
          } else if (boxVisibleRef.current && now - lastBoxUpdateRef.current > 180) {
            boxVisibleRef.current = false;
            lastBoxUpdateRef.current = now;
            setQrBox(null);
          }
        }
      }
    } catch (err) {
      frameErrorCountRef.current += 1;
      console.error("Scan frame error:", err);
      if (frameErrorCountRef.current === 6) {
        setError(
          "Camera scanning hit repeated frame errors. Keep the camera steady and retry if it continues.",
        );
      }
    } finally {
      if (scanningRef.current) rafRef.current = requestAnimationFrame(tick);
    }
  }

  function updateProgress(t: Transfer) {
    setProgress({ have: t.chunks.size, total: t.header.total });
  }

  function handleScan(payload: string) {
    if (finishingRef.current) return;
    const parsed = parseFrame(payload);
    if (!parsed) return;
    const seenKey = `${parsed.kind}:${parsed.id}:${parsed.kind === "data" ? parsed.index : "h"}`;
    const now = performance.now();
    const seenAt = lastSeenRef.current.get(seenKey);
    if (seenAt && now - seenAt < 80) return;
    lastSeenRef.current.set(seenKey, now);
    if (lastSeenRef.current.size > 2000) {
      for (const [key, ts] of lastSeenRef.current) {
        if (now - ts > 45000) lastSeenRef.current.delete(key);
      }
    }

    if (parsed.kind === "header") {
      let t = transferRef.current;
      if (!t || t.header.id !== parsed.id) {
        t = { header: parsed, chunks: new Map<number, Uint8Array>(), startedAt: Date.now() };
        transferRef.current = t;
        sfx.fileFound();
      }
      setScanInfo({ name: t.header.name, mime: t.header.mime, size: t.header.size });
      updateProgress(t);
      return;
    }

    let t = transferRef.current;
    if (!t || t.header.id !== parsed.id) return;
    if (parsed.index >= t.header.total) return;
    if (!t.chunks.has(parsed.index)) {
      t.chunks.set(parsed.index, parsed.payload);
      updateProgress(t);
      sfx.scan();
    }
    if (t.chunks.size === t.header.total) void finish();
  }

  async function finish() {
    const t = transferRef.current;
    if (!t || finishingRef.current) return;
    finishingRef.current = true;
    try {
      const ordered: Uint8Array[] = new Array(t.header.total);
      for (let i = 0; i < t.header.total; i++) {
        const c = t.chunks.get(i);
        if (!c) throw new Error("Transfer is missing QR frames.");
        ordered[i] = c;
      }
      const bytes = reconstruct(ordered, t.header.size);
      const computed = crc32(bytes);
      const valid = computed === t.header.crc;
      const mime = t.header.mime || "application/octet-stream";
      const blob = new Blob([bytes as BlobPart], { type: mime });
      if (valid) sfx.success();
      else sfx.error();
      if (!valid) throw new Error("Received with errors — scan it again for a clean file.");

      await saveItem({
        id: t.header.id + "-" + Date.now(),
        filename: t.header.name,
        mime: t.header.mime,
        size: t.header.size,
        receivedAt: Date.now(),
        direction: "received",
        durationMs: Date.now() - t.startedAt,
        valid,
        blob,
      });

      const previewUrl = URL.createObjectURL(blob);
      doneUrlRef.current = previewUrl;
      const aspectRatio = await detectAspectRatio(blob, mime, previewUrl);
      setDone({
        name: t.header.name,
        mime,
        size: t.header.size,
        blob,
        url: previewUrl,
        aspectRatio,
      });
      transferRef.current = null;
      lastSeenRef.current.clear();
      setScanInfo(null);
      setProgress({ have: 0, total: 0 });
      await stop(true);
      onSaved();
    } catch (e) {
      transferRef.current = null;
      lastSeenRef.current.clear();
      setScanInfo(null);
      setProgress({ have: 0, total: 0 });
      setError(e instanceof Error ? e.message : "The scanned file could not be reconstructed yet.");
    } finally {
      finishingRef.current = false;
    }
  }

  useEffect(() => {
    onBusyChange?.(active || starting || stopping);
  }, [active, starting, stopping, onBusyChange]);

  useEffect(() => {
    if (stopRequestKey > 0) {
      void stopRef.current(true).then(() => onStopRequestComplete?.());
    }
  }, [stopRequestKey, onStopRequestComplete]);

  useEffect(
    () => () => {
      void stopRef.current();
      if (doneUrlRef.current) URL.revokeObjectURL(doneUrlRef.current);
    },
    [],
  );

  const pct = progress.total ? (progress.have / progress.total) * 100 : 0;
  const label = mediaLabel(scanInfo?.mime);
  const containerAspect = done ? Math.min(2.2, Math.max(0.55, done.aspectRatio)) : 1;

  return (
    <div className="flex flex-1 flex-col px-5 pb-2 animate-fade-up">
      <div
        className={`glass-strong relative mx-auto flex w-full max-w-sm items-center justify-center overflow-hidden rounded-2xl ${done ? "order-2 mt-3" : ""}`}
        style={{
          aspectRatio: `${containerAspect} / 1`,
          transition: "aspect-ratio 0.55s cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
          style={{ display: active || starting ? "block" : "none" }}
        />
        <canvas ref={canvasRef} className="hidden" />

        {!active && !starting && !done && (
          <div className="absolute inset-0 px-6 text-center">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="relative">
                <span className="absolute inset-0 rounded-full bg-primary/40 animate-pulse-ring" />
                <div className="relative grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40">
                  <ScanLine className="h-8 w-8 text-primary-foreground" />
                </div>
              </div>
            </div>
            <p className="absolute inset-x-6 bottom-10 text-sm text-muted-foreground sm:bottom-12">
              Aim at the OFFDROP qr
            </p>
          </div>
        )}

        {starting && !active && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {done && (
          <div className="absolute inset-0 flex flex-col bg-secondary/40 animate-fade-up">
            <div className="relative flex-1 overflow-hidden">
              {done.mime.startsWith("image/") && done.url ? (
                <img src={done.url} alt={done.name} className="h-full w-full object-contain" />
              ) : done.mime.startsWith("video/") && done.url ? (
                <video
                  src={done.url}
                  className="h-full w-full object-contain"
                  controls
                  playsInline
                />
              ) : done.mime.startsWith("audio/") && done.url ? (
                <div className="audio-tile flex h-full w-full flex-col items-center justify-center gap-3 px-4">
                  <Music2 className="h-10 w-10 text-primary" strokeWidth={1.8} />
                  <audio src={done.url} controls className="w-full max-w-xs" />
                </div>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <FileText className="h-12 w-12" strokeWidth={1.6} />
                  <span className="text-xs">Preview not available</span>
                </div>
              )}
              <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-background/70 px-2.5 py-1 text-[10px] font-semibold backdrop-blur">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                Received
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-glass-border bg-background/50 p-2 backdrop-blur">
              <button
                type="button"
                onClick={() => void shareDone()}
                className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-primary to-accent py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 active:scale-[0.97]"
              >
                <Share2 className="h-4 w-4" />
                Share
              </button>
              <button
                type="button"
                onClick={downloadDone}
                className="glass flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold active:scale-[0.97]"
              >
                <Download className="h-4 w-4" />
                Download
              </button>
            </div>
          </div>
        )}

        {active && (
          <>
            <div className="scanner-corners-in pointer-events-none absolute inset-3 rounded-xl">
              <span className="absolute left-0 top-0 h-10 w-10 rounded-tl-xl border-l-[3px] border-t-[3px] border-white" />
              <span className="absolute right-0 top-0 h-10 w-10 rounded-tr-xl border-r-[3px] border-t-[3px] border-white" />
              <span className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-xl border-b-[3px] border-l-[3px] border-white" />
              <span className="absolute bottom-0 right-0 h-10 w-10 rounded-br-xl border-b-[3px] border-r-[3px] border-white" />
            </div>
            <div className="pointer-events-none absolute inset-3 overflow-hidden rounded-xl">
              <div className="scan-sweep absolute left-0 right-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent" />
            </div>
            {qrBox && (
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full scanner-corners"
                viewBox={`0 0 ${qrBox.w} ${qrBox.h}`}
                preserveAspectRatio="xMidYMid slice"
              >
                <polygon points={qrBox.corners.map((p) => `${p.x},${p.y}`).join(" ")} />
                {qrBox.corners.map((p, i) => (
                  <circle key={`${p.x}-${p.y}-${i}`} cx={p.x} cy={p.y} r="10" />
                ))}
              </svg>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="glass mt-3 rounded-2xl border border-destructive/40 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className={`${done ? "order-1 mt-0" : "mt-3"} flex items-center justify-center gap-2`}>
        {!active && !stopping ? (
          <button
            onClick={() => void start()}
            disabled={starting}
            className="flex w-full max-w-[17rem] items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 active:scale-[0.97] disabled:opacity-80"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            {starting ? "Starting Camera" : "Start Camera"}
          </button>
        ) : (
          <>
            <button
              onClick={() => void flipCamera()}
              disabled={stopping || starting}
              aria-label={`Flip camera (current: ${facing === "environment" ? "back" : "front"})`}
              className="glass flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold active:scale-95 disabled:opacity-60 sm:h-14 sm:px-5 sm:text-base"
            >
              <SwitchCamera className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={2.2} />
              <span className="pr-0.5">Flip</span>
            </button>
            <button
              onClick={() => void stop(true)}
              disabled={stopping}
              className="glass flex max-w-[14rem] flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold active:scale-[0.97] disabled:opacity-80 sm:py-4 sm:text-base"
            >
              {stopping ? (
                <Loader2 className="h-4 w-4 animate-spin sm:h-5 sm:w-5" />
              ) : (
                <CameraOff className="h-4 w-4 sm:h-5 sm:w-5" />
              )}
              {stopping ? "Stopping" : "Stop Camera"}
            </button>
          </>
        )}
      </div>

      {(active || progress.total > 0) && (
        <div className="order-3 mx-auto mt-10 w-full max-w-sm animate-fade-up">
          <div className="flex items-center justify-center gap-2 text-center text-xs">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            <span className="min-w-0 truncate text-center font-semibold">
              {progress.total > 0
                ? `Assembling ${label}…`
                : qrBox
                  ? "OFFDROP qr locked"
                  : "Searching for OFFDROP qr …"}
            </span>
            {progress.total > 0 && (
              <span className="shrink-0 tabular-nums text-[10px] font-bold text-muted-foreground">
                {progress.have} / {progress.total}
              </span>
            )}
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-secondary p-[1px]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 truncate text-center text-[10px] text-muted-foreground">
            {scanInfo ? scanInfo.name : "Position the camera toward the qr code accurately"}
          </div>
          <AnimatedPercent value={pct} />
        </div>
      )}
    </div>
  );
}
