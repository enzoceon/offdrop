import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Camera, CameraOff, CheckCircle2, Loader2, ScanLine } from "lucide-react";
import {
  parseChunkPayload,
  transferComplete,
  assembleTransfer,
  requiredDataChunks,
  type Transfer,
} from "@/lib/qr-protocol";
import { saveItem } from "@/lib/history";

type Point = { x: number; y: number };
type QrBox = { w: number; h: number; corners: [Point, Point, Point, Point] };
type ScanResult = { data: string; corners: [Point, Point, Point, Point] };
type ScannerProps = {
  onSaved: () => void;
  stopRequestKey?: number;
  onStopRequestComplete?: () => void;
  onBusyChange?: (busy: boolean) => void;
};

const CAMERA_TRANSITION_MS = 650;
const DECODE_INTERVAL_MS = 72;

function decodeQr(ctx: CanvasRenderingContext2D, w: number, h: number): ScanResult | null {
  const side = Math.min(w, h);
  const attempts: Array<[number, number, number, number]> = [[0, 0, w, h]];
  if (side !== w || side !== h) attempts.push([Math.round((w - side) / 2), Math.round((h - side) / 2), side, side]);
  for (const ratio of [0.82, 0.66]) {
    const crop = Math.max(160, Math.round(side * ratio));
    if (crop < side) attempts.push([Math.round((w - crop) / 2), Math.round((h - crop) / 2), crop, crop]);
  }

  const seen = new Set<string>();
  for (const [sx, sy, sw, sh] of attempts) {
    const key = `${sx}:${sy}:${sw}:${sh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const img = ctx.getImageData(sx, sy, sw, sh);
    const code = jsQR(img.data, sw, sh, { inversionAttempts: "attemptBoth" });
    if (!code?.data) continue;
    const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = code.location;
    const offset = (p: Point): Point => ({ x: p.x + sx, y: p.y + sy });
    return { data: code.data, corners: [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner].map(offset) as [Point, Point, Point, Point] };
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

export function Scanner({ onSaved, stopRequestKey = 0, onStopRequestComplete, onBusyChange }: ScannerProps) {
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

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ have: 0, total: 0 });
  const [scanInfo, setScanInfo] = useState<{ name: string; mime: string; size: number } | null>(null);
  const [qrBox, setQrBox] = useState<QrBox | null>(null);
  const [done, setDone] = useState<{ name: string } | null>(null);

  async function start() {
    if (active || starting || stopping) return;
    const startedAt = performance.now();
    setError(null);
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
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;
      for (const track of stream.getVideoTracks()) {
        const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[] };
        if (capabilities?.focusMode?.includes("continuous")) {
          await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
        }
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
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
      setError(e instanceof Error ? e.message : "Camera unavailable. Grant camera permission and retry.");
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
    setActive(false);
    setStarting(false);
    setQrBox(null);
    boxVisibleRef.current = false;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStopping(false);
  }

  function tick() {
    if (!scanningRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const now = performance.now();
    if (video && canvas && now - lastDecodeRef.current >= DECODE_INTERVAL_MS && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      lastDecodeRef.current = now;
      const scale = Math.min(1, 760 / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, w, h);
        const code = decodeQr(ctx, w, h);
        if (code?.data) {
          handleScan(code.data);
          if (now - lastBoxUpdateRef.current > 80) {
            boxVisibleRef.current = true;
            lastBoxUpdateRef.current = now;
            setQrBox({
              w,
              h,
              corners: code.corners,
            });
          }
        } else if (boxVisibleRef.current && now - lastBoxUpdateRef.current > 180) {
          boxVisibleRef.current = false;
          lastBoxUpdateRef.current = now;
          setQrBox(null);
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function updateProgress(t: Transfer) {
    const required = Math.min(requiredDataChunks(t.size), t.total);
    let have = 0;
    for (let i = 0; i < required; i++) if (t.chunks.has(i)) have++;
    setProgress({ have, total: required });
  }

  function handleScan(payload: string) {
    if (finishingRef.current) return;
    const parsed = parseChunkPayload(payload);
    if (!parsed) return;
    const { meta, data } = parsed;
    const seenKey = `${meta.i}:${meta.n}`;
    const now = performance.now();
    const seenAt = lastSeenRef.current.get(seenKey);
    if (seenAt && now - seenAt < 80) return;
    lastSeenRef.current.set(seenKey, now);
    if (lastSeenRef.current.size > 1000) {
      for (const [key, ts] of lastSeenRef.current) {
        if (now - ts > 45000) lastSeenRef.current.delete(key);
      }
    }

    let t = transferRef.current;
    if (!t || t.id !== meta.i) {
      t = {
        id: meta.i,
        mime: meta.m,
        filename: meta.f,
        size: meta.s,
        total: meta.t,
        chunks: new Map(),
      };
      transferRef.current = t;
    } else {
      t.mime = meta.m;
      t.filename = meta.f;
      t.size = meta.s;
      t.total = meta.t;
    }
    setScanInfo({ name: t.filename, mime: t.mime, size: t.size });
    if (!t.chunks.has(meta.n)) {
      t.chunks.set(meta.n, data);
      updateProgress(t);
      if (navigator.vibrate) navigator.vibrate(8);
    }
    if (transferComplete(t)) void finish();
  }

  async function finish() {
    const t = transferRef.current;
    if (!t || finishingRef.current) return;
    finishingRef.current = true;
    try {
      const blob = assembleTransfer(t);
      await saveItem({
        id: t.id + "-" + Date.now(),
        filename: t.filename,
        mime: t.mime,
        size: t.size,
        receivedAt: Date.now(),
        blob,
      });
      if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
      setDone({ name: t.filename });
      transferRef.current = null;
      lastSeenRef.current.clear();
      setScanInfo(null);
      setProgress({ have: 0, total: 0 });
      await stop(true);
      onSaved();
    } catch (e) {
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
      void stop(true).then(() => onStopRequestComplete?.());
    }
  }, [stopRequestKey]);

  useEffect(() => () => {
    void stop();
  }, []);

  const pct = progress.total ? (progress.have / progress.total) * 100 : 0;
  const label = mediaLabel(scanInfo?.mime);

  return (
    <div className="flex flex-1 flex-col px-5 pb-2 animate-fade-up">
      <div className="glass-strong relative mx-auto flex aspect-square w-full max-w-sm items-center justify-center overflow-hidden rounded-[2rem]">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
          style={{ display: active ? "block" : "none" }}
        />
        <canvas ref={canvasRef} className="hidden" />

        {!active && !done && (
          <div className="absolute inset-0 px-6 text-center">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="relative">
              <span className="absolute inset-0 rounded-full bg-primary/40 animate-pulse-ring" />
              <div className="relative grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40">
                <ScanLine className="h-8 w-8 text-primary-foreground" />
              </div>
              </div>
            </div>
            <p className="absolute inset-x-6 bottom-10 text-sm text-muted-foreground sm:bottom-12">Aim at the OFFDROP stream</p>
          </div>
        )}

        {done && (
          <div className="flex flex-col items-center text-center animate-fade-up">
            <CheckCircle2 className="h-16 w-16 text-primary" strokeWidth={1.8} />
            <p className="mt-3 text-display text-xl">Received</p>
            <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">{done.name}</p>
          </div>
        )}

        {active && (
          <>
            <div className="pointer-events-none absolute inset-6 rounded-[1.5rem] border-2 border-primary/70 shadow-[0_0_0_9999px_oklch(0_0_0/0.22)]" />
            <div className="pointer-events-none absolute inset-x-8 inset-y-8 overflow-hidden rounded-[1.1rem]">
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

      <div className="mt-3 flex justify-center gap-2">
        {!active && !stopping ? (
          <button
            onClick={start}
            disabled={starting}
            className="flex w-full max-w-[17rem] items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 active:scale-[0.97] disabled:opacity-80"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            {starting ? "Starting Camera" : "Start Camera"}
          </button>
        ) : (
          <button
            onClick={() => void stop(true)}
            disabled={stopping}
            className="glass flex w-full max-w-[17rem] items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold active:scale-[0.97] disabled:opacity-80"
          >
            {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <CameraOff className="h-4 w-4" />}
            {stopping ? "Stopping Camera" : "Stop Camera"}
          </button>
        )}
      </div>

      {(active || progress.total > 0) && (
        <div className="mx-auto mt-7 w-full max-w-sm animate-fade-up">
          <div className="flex items-center justify-center gap-2 text-center text-xs">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            <span className="min-w-0 truncate font-semibold">
              {progress.total > 0 ? `Assembling ${label}…` : qrBox ? "OFFDROP stream locked" : "Searching for OFFDROP stream…"}
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
          <div className="mt-1 truncate text-[10px] text-muted-foreground">
            {scanInfo ? scanInfo.name : "Position the camera toward the OFFDROP stream"}
          </div>
        </div>
      )}
    </div>
  );
}
