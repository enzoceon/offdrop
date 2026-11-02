import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  Maximize2,
  Play,
  ShieldCheck,
  RotateCcw,
  X,
  Focus,
  Sparkles,
} from "lucide-react";
import {
  FountainDecoder,
  RECEIVE_LIMIT_BYTES,
  crc32,
  formatBytes,
  parseFrame,
  type ParsedHeader,
} from "@/lib/qr-protocol";
import { saveItem } from "@/lib/history";
import { MediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { sfx } from "@/lib/feedback";
import { useWakeLock } from "@/lib/wake-lock";

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

interface Transfer {
  header: ParsedHeader;
  decoder: FountainDecoder;
  startedAt: number;
}

type ProgressState = { have: number; total: number; frac: number; eta: number | null; rate: number };
const EMPTY_PROGRESS: ProgressState = { have: 0, total: 0, frac: 0, eta: null, rate: 0 };

type NativeDetection = { rawValue: string; cornerPoints?: Array<{ x: number; y: number }> };
type NativeDetector = { detect: (source: CanvasImageSource) => Promise<NativeDetection[]> };

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
/** Corners in *video pixel* space, used to draw the lock-on outline. */
type QrBox = { w: number; h: number; corners: Quad };
type ScanResult = { data: string; corners: Quad };
/** Auto-framing view: centre in normalised video coordinates plus a digital zoom factor. */
type View = { cx: number; cy: number; z: number };
type DonePreview = { name: string; mime: string; size: number; blob: Blob; url?: string };
type PausedTransfer = { name: string; size: number; frac: number };

type ScannerProps = {
  onSaved: () => void;
  onCompleteAction?: () => void;
  stopRequestKey?: number;
  onStopRequestComplete?: () => void;
  onBusyChange?: (busy: boolean) => void;
  visible?: boolean;
};

type FocusMode = "single-shot" | "continuous" | "manual";
type CameraControlCapabilities = MediaTrackCapabilities & { focusMode?: FocusMode[] };
type CameraControlTrack = MediaStreamTrack & { getCapabilities?: () => CameraControlCapabilities };

/* ----------------------------------------------------------------------------
 * Constants + small helpers
 * -------------------------------------------------------------------------- */

const CAMERA_TRANSITION_MS = 180;
const DECODE_INTERVAL_MS = 30; // jsQR pacing (the native detector runs flat out)
const DECODE_MAX_EDGE = 960; // jsQR decode resolution
const NATIVE_MAX_EDGE = 1600; // crop size cap when the native detector reads a zoomed crop
const PROGRESS_COMMIT_MS = 250;
const SCAN_SOUND_MS = 220;

// Auto-framing
const FRAME_TARGET_FILL = 0.62; // QR should fill ~62% of the shorter view side
const FRAME_MAX_ZOOM = 3;
const FRAME_STEP_MS = 90;
const FRAME_LOST_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 1) return "";
  const whole = Math.ceil(seconds);
  const hours = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours) return `${hours}h ${mins.toString().padStart(2, "0")}m left`;
  return mins ? `${mins}m ${secs.toString().padStart(2, "0")}s left` : `${secs}s left`;
}

function mediaLabel(mime?: string) {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  if (video.readyState >= video.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      video.removeEventListener("loadedmetadata", onMetadata);
      reject(new Error("Camera metadata did not load."));
    }, 5000);
    const onMetadata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
  });
}

function waitForUsableVideo(video: HTMLVideoElement) {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) return resolve();
      if (performance.now() - started > 5000) return reject(new Error("Camera started, but no video frame was received."));
      window.setTimeout(check, 40);
    };
    check();
  });
}

async function openCameraStream(facingMode: "environment" | "user") {
  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        facingMode: { exact: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, max: 60 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    },
    { video: true, audio: false },
  ];
  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Camera permission is unavailable in this browser.");
}

/** Continuous autofocus, optionally steered at a point of interest (the QR code). */
async function applyCameraFocus(stream: MediaStream | null, point?: Point) {
  const track = stream?.getVideoTracks()[0] as CameraControlTrack | undefined;
  if (!track || track.readyState !== "live") return false;
  const available = (track.getCapabilities?.() as CameraControlCapabilities | undefined)?.focusMode ?? [];
  const modes: FocusMode[] = (["continuous", "single-shot"] as FocusMode[]).filter(
    (m) => !available.length || available.includes(m),
  );
  for (const mode of modes) {
    try {
      await track.applyConstraints({
        advanced: [
          {
            focusMode: mode,
            ...(point ? { pointsOfInterest: [{ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) }] } : {}),
          } as MediaTrackConstraintSet,
        ],
      });
      return true;
    } catch {
      /* try the next supported mode */
    }
  }
  return false;
}

/** Region of the camera frame that the current auto-framing view looks at. */
function cropOf(W: number, H: number, v: View) {
  const cropW = W / v.z;
  const cropH = H / v.z;
  return {
    sx: clamp(v.cx * W - cropW / 2, 0, W - cropW),
    sy: clamp(v.cy * H - cropH / 2, 0, H - cropH),
    cropW,
    cropH,
  };
}

/** Main-thread jsQR (only used if Web Workers are unavailable). */
function decodeQrMainThread(ctx: CanvasRenderingContext2D, w: number, h: number, deep: boolean): ScanResult[] {
  const side = Math.min(w, h);
  const cx = Math.round((w - side) / 2);
  const cy = Math.round((h - side) / 2);
  const attempts: Array<[number, number, number, number, boolean]> = [[cx, cy, side, side, false]];
  if (deep && (side !== w || side !== h)) attempts.push([0, 0, w, h, false]);
  if (deep) attempts.push([cx, cy, side, side, true]);
  for (const [sx, sy, sw, sh, invert] of attempts) {
    const img = ctx.getImageData(sx, sy, sw, sh);
    const code = jsQR(img.data, sw, sh, { inversionAttempts: invert ? "attemptBoth" : "dontInvert" });
    if (!code?.data) continue;
    const l = code.location;
    const off = (p: Point): Point => ({ x: p.x + sx, y: p.y + sy });
    return [
      {
        data: code.data,
        corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map(off) as Quad,
      },
    ];
  }
  return [];
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => GenericTransformStream })
    .DecompressionStream;
  if (!DS) throw new Error("This browser can't unpack compressed transfers. Update the browser or use Chrome/Safari.");
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DS("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ----------------------------------------------------------------------------
 * Component
 * -------------------------------------------------------------------------- */

export function Scanner({
  onSaved,
  onCompleteAction,
  stopRequestKey = 0,
  onStopRequestComplete,
  onBusyChange,
  visible = true,
}: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const vfcRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const transferRef = useRef<Transfer | null>(null);
  const detectorRef = useRef<NativeDetector | null | undefined>(undefined);
  const workerRef = useRef<Worker | null | undefined>(undefined);
  const workerPending = useRef(new Map<number, (r: ScanResult[]) => void>());
  const workerSeq = useRef(0);
  const decodeBusyRef = useRef(false);
  const lastPayloadRef = useRef("");
  const lastScanSoundRef = useRef(0);
  const lastDecodeRef = useRef(0);
  const finishingRef = useRef(false);
  const scanningRef = useRef(false);
  const boxVisibleRef = useRef(false);
  const lastBoxUpdateRef = useRef(0);
  const lastSeenQrRef = useRef(0);
  const lastFrameStepRef = useRef(0);
  const lastFocusRef = useRef(0);
  const frameErrorCountRef = useRef(0);
  const decodeFrameRef = useRef(0);
  const facingRef = useRef<"environment" | "user">("environment");
  const doneUrlRef = useRef<string | null>(null);
  const progressCommitRef = useRef(0);
  const viewRef = useRef<View>({ cx: 0.5, cy: 0.5, z: 1 });
  const stopRef = useRef<(showStopping?: boolean) => Promise<void>>(async () => {});

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [scanInfo, setScanInfo] = useState<{ name: string; mime: string; size: number } | null>(null);
  const [qrBox, setQrBox] = useState<QrBox | null>(null);
  const [done, setDone] = useState<DonePreview | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [flipping, setFlipping] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [view, setView] = useState<View>({ cx: 0.5, cy: 0.5, z: 1 });
  const [videoSize, setVideoSize] = useState({ w: 16, h: 9 });
  const [fastDecoder, setFastDecoder] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  const [paused, setPaused] = useState<PausedTransfer | null>(null);
  const [autoAssist, setAutoAssist] = useState(true);
  const autoAssistRef = useRef(true);

  useWakeLock(active);

  /* ---------------------------------------------------------------- detection backends */

  function getDetector(): NativeDetector | null {
    if (detectorRef.current !== undefined) return detectorRef.current;
    try {
      const Ctor = (window as unknown as {
        BarcodeDetector?: new (opts: { formats: string[] }) => NativeDetector;
      }).BarcodeDetector;
      detectorRef.current = Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
    } catch {
      detectorRef.current = null;
    }
    return detectorRef.current;
  }

  /** jsQR in a Web Worker; falls back to the main thread if workers are unavailable. */
  function decodeAsync(ctx: CanvasRenderingContext2D, w: number, h: number, deep: boolean): Promise<ScanResult[]> {
    if (workerRef.current === undefined) {
      try {
        const worker = new Worker(new URL("../lib/qr-decode.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ id: number; results: ScanResult[] }>) => {
          const resolve = workerPending.current.get(event.data.id);
          workerPending.current.delete(event.data.id);
          resolve?.(event.data.results ?? []);
        };
        worker.onerror = () => {
          workerRef.current = null;
          for (const resolve of workerPending.current.values()) resolve([]);
          workerPending.current.clear();
        };
        workerRef.current = worker;
      } catch {
        workerRef.current = null;
      }
    }
    const worker = workerRef.current;
    if (!worker) return Promise.resolve(decodeQrMainThread(ctx, w, h, deep));
    const img = ctx.getImageData(0, 0, w, h);
    const id = ++workerSeq.current;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        workerPending.current.delete(id);
        resolve([]);
      }, 1500);
      workerPending.current.set(id, (r) => {
        window.clearTimeout(timer);
        resolve(r);
      });
      worker.postMessage({ id, data: img.data.buffer, w, h, deep }, [img.data.buffer]);
    });
  }

  /** Decode exactly when the camera delivers a new frame (not on a blind 60 Hz timer). */
  function scheduleTick() {
    const video = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }) | null;
    if (video?.requestVideoFrameCallback) vfcRef.current = video.requestVideoFrameCallback(() => tick());
    else rafRef.current = requestAnimationFrame(tick);
  }

  function cancelTick() {
    cancelAnimationFrame(rafRef.current);
    const video = videoRef.current as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | null;
    if (video?.cancelVideoFrameCallback && vfcRef.current) video.cancelVideoFrameCallback(vfcRef.current);
    vfcRef.current = 0;
  }

  function tick() {
    if (!scanningRef.current) return;
    scheduleTick();
    if (decodeBusyRef.current) return; // never queue decodes; always work on the freshest frame
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const now = performance.now();
    const detector = getDetector();
    if (
      !video ||
      !canvas ||
      now - lastDecodeRef.current < (detector ? 0 : DECODE_INTERVAL_MS) ||
      video.readyState < video.HAVE_CURRENT_DATA ||
      video.videoWidth <= 0 ||
      video.videoHeight <= 0
    ) {
      return;
    }
    lastDecodeRef.current = now;
    decodeBusyRef.current = true;
    void processFrame(video, canvas, now).finally(() => {
      decodeBusyRef.current = false;
    });
  }

  async function processFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, now: number) {
    try {
      const detector = getDetector();
      decodeFrameRef.current += 1;
      const W = video.videoWidth;
      const H = video.videoHeight;
      const v = viewRef.current;
      const zoomed = v.z > 1.02;
      const { sx, sy, cropW, cropH } = cropOf(W, H, v);
      let corners: Quad | null = null; // video pixel space

      if (detector) {
        try {
          let source: CanvasImageSource = video;
          let cw = W;
          let ch = H;
          if (zoomed) {
            const scale = Math.min(1, NATIVE_MAX_EDGE / Math.max(cropW, cropH));
            cw = Math.max(1, Math.round(cropW * scale));
            ch = Math.max(1, Math.round(cropH * scale));
            if (canvas.width !== cw) canvas.width = cw;
            if (canvas.height !== ch) canvas.height = ch;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
            source = canvas;
          }
          const found = await detector.detect(source);
          if (!scanningRef.current) return;
          for (const item of found) {
            if (!item.rawValue || !handleScan(item.rawValue)) continue;
            const pts = item.cornerPoints;
            if (!corners && pts && pts.length >= 4) {
              corners = [pts[0], pts[1], pts[2], pts[3]].map((p) =>
                zoomed ? { x: sx + (p.x * cropW) / cw, y: sy + (p.y * cropH) / ch } : { x: p.x, y: p.y },
              ) as Quad;
            }
          }
        } catch (err) {
          console.warn("Native QR detector failed, falling back to jsQR:", err);
          detectorRef.current = null;
          setFastDecoder(false);
        }
      } else {
        const scale = Math.min(1, DECODE_MAX_EDGE / Math.max(cropW, cropH));
        const cw = Math.max(1, Math.round(cropW * scale));
        const ch = Math.max(1, Math.round(cropH * scale));
        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
        const deep = !boxVisibleRef.current ? decodeFrameRef.current % 3 === 0 : decodeFrameRef.current % 14 === 0;
        const codes = await decodeAsync(ctx, cw, ch, deep);
        if (!scanningRef.current) return;
        for (const code of codes) {
          if (!code.data || !handleScan(code.data)) continue;
          if (!corners) {
            corners = code.corners.map((p) => ({ x: sx + (p.x * cropW) / cw, y: sy + (p.y * cropH) / ch })) as Quad;
          }
        }
      }
      frameErrorCountRef.current = 0;

      if (corners) {
        lastSeenQrRef.current = now;
        if (now - lastBoxUpdateRef.current > 120) {
          boxVisibleRef.current = true;
          lastBoxUpdateRef.current = now;
          setQrBox({ w: W, h: H, corners });
          stepAutoFrame(corners, W, H, now);
        }
      } else {
        if (boxVisibleRef.current && now - lastBoxUpdateRef.current > 180) {
          boxVisibleRef.current = false;
          lastBoxUpdateRef.current = now;
          setQrBox(null);
        }
        // Lost the code for a while: ease back out so it can be re-acquired.
        if (autoAssistRef.current && now - lastSeenQrRef.current > FRAME_LOST_MS && viewRef.current.z > 1.01) relaxAutoFrame(now);
      }
    } catch (err) {
      frameErrorCountRef.current += 1;
      console.error("Scan frame error:", err);
      if (frameErrorCountRef.current === 6) {
        setError("Camera scanning hit repeated frame errors. Keep the camera steady and retry if it continues.");
      }
    }
  }

  /* ---------------------------------------------------------------- automatic framing */

  function commitView(next: View) {
    viewRef.current = next;
    setView(next);
  }

  /**
   * Gently zoom + re-centre so the code fills ~62% of the view, as centred as possible.
   * If it is already big enough nothing moves; the view only ever eases (never jumps).
   */
  function stepAutoFrame(c: Quad, W: number, H: number, now: number) {
    if (!autoAssistRef.current) return; // plain camera: no zoom, no steering
    if (now - lastFrameStepRef.current < FRAME_STEP_MS || flipping) return;
    lastFrameStepRef.current = now;
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const minX = Math.min(...xs) / W;
    const maxX = Math.max(...xs) / W;
    const minY = Math.min(...ys) / H;
    const maxY = Math.max(...ys) / H;
    const v = viewRef.current;
    const qrSide = Math.max((maxX - minX) * W, (maxY - minY) * H);
    const fill = qrSide / (Math.min(W, H) / v.z);

    let z = v.z;
    if (fill < FRAME_TARGET_FILL * 0.82 || fill > FRAME_TARGET_FILL * 1.4) {
      z = clamp(v.z * clamp(FRAME_TARGET_FILL / Math.max(0.02, fill), 0.94, 1.09), 1, FRAME_MAX_ZOOM);
    }
    // Pull the view centre toward the code; only matters once zoomed in.
    const tx = (minX + maxX) / 2;
    const ty = (minY + maxY) / 2;
    const pull = z > 1.02 ? 0.28 : 0;
    const half = 0.5 / z;
    const next: View = {
      z,
      cx: clamp(v.cx + (tx - v.cx) * pull, half, 1 - half),
      cy: clamp(v.cy + (ty - v.cy) * pull, half, 1 - half),
    };
    if (Math.abs(next.z - v.z) > 0.004 || Math.abs(next.cx - v.cx) > 0.003 || Math.abs(next.cy - v.cy) > 0.003) {
      commitView(next);
    }
    // Real autofocus: aim the lens at the code itself.
    if (now - lastFocusRef.current > 900) {
      lastFocusRef.current = now;
      void applyCameraFocus(streamRef.current, { x: tx, y: ty });
    }
  }

  function relaxAutoFrame(now: number) {
    if (now - lastFrameStepRef.current < FRAME_STEP_MS * 1.5) return;
    lastFrameStepRef.current = now;
    const v = viewRef.current;
    const z = Math.max(1, v.z * 0.94);
    const half = 0.5 / z;
    commitView({ z, cx: clamp(v.cx + (0.5 - v.cx) * 0.2, half, 1 - half), cy: clamp(v.cy + (0.5 - v.cy) * 0.2, half, 1 - half) });
  }

  /** CSS transform that makes the (cover-fitted) video show the same region the decoder crops. */
  function viewTransform(v: View): CSSProperties {
    const stage = stageRef.current;
    const ea = stage && stage.clientHeight ? stage.clientWidth / stage.clientHeight : videoSize.w / videoSize.h;
    const va = videoSize.w / videoSize.h;
    let ex = v.cx;
    let ey = v.cy;
    if (va > ea) ex = (v.cx - 0.5) / (ea / va) + 0.5;
    else ey = (v.cy - 0.5) / (va / ea) + 0.5;
    const half = 0.5 / v.z;
    ex = clamp(ex, half, 1 - half);
    ey = clamp(ey, half, 1 - half);
    return {
      transform: `translate3d(${(-(ex - 0.5) * v.z * 100).toFixed(3)}%, ${(-(ey - 0.5) * v.z * 100).toFixed(3)}%, 0) scale(${v.z.toFixed(4)})`,
      transition: flipping ? "opacity 0.16s ease" : "transform 0.18s linear",
    };
  }

  /* ---------------------------------------------------------------- progress + frames */

  function updateProgress(t: Transfer, force = false) {
    const now = performance.now();
    if (!force && now - progressCommitRef.current < PROGRESS_COMMIT_MS) return;
    progressCommitRef.current = now;
    const frac = t.decoder.progress;
    const elapsed = (Date.now() - t.startedAt) / 1000;
    const eta = frac > 0.03 && elapsed > 3 ? (elapsed * (1 - frac)) / frac : null;
    const rate = elapsed > 1 ? (frac * t.header.size) / elapsed : 0;
    setProgress({ have: t.decoder.count, total: t.header.total, frac, eta, rate });
  }

  /** Returns true when the payload was one of ours (used to pick among several QR codes). */
  function handleScan(payload: string): boolean {
    if (finishingRef.current) return true;
    if (payload === lastPayloadRef.current) return true; // same frame still on screen
    const parsed = parseFrame(payload);
    if (!parsed) return false;
    lastPayloadRef.current = payload;

    if (parsed.kind === "header") {
      let t = transferRef.current;
      if (!t || t.header.id !== parsed.id) {
        if (parsed.size > RECEIVE_LIMIT_BYTES) {
          setError(
            `This file (${formatBytes(parsed.size)}) is too large to receive on this device. The limit is ${formatBytes(RECEIVE_LIMIT_BYTES)}.`,
          );
          return true;
        }
        let decoder: FountainDecoder;
        try {
          decoder = new FountainDecoder(parsed);
        } catch {
          setError("Not enough free memory on this device to receive this file.");
          return true;
        }
        t = { header: parsed, decoder, startedAt: Date.now() };
        transferRef.current = t;
        setError(null);
        setPaused(null);
        sfx.fileFound();
      }
      setScanInfo((prev) =>
        prev && prev.name === parsed.name && prev.size === parsed.origSize
          ? prev
          : { name: parsed.name, mime: parsed.mime, size: parsed.origSize },
      );
      updateProgress(t, !progressCommitRef.current);
      return true;
    }

    const t = transferRef.current;
    if (!t || t.header.id !== parsed.id) return true;
    if (t.decoder.add(parsed)) {
      updateProgress(t);
      const now = performance.now();
      if (now - lastScanSoundRef.current > SCAN_SOUND_MS) {
        lastScanSoundRef.current = now;
        sfx.scan(t.decoder.progress);
      }
    }
    if (t.decoder.complete) void finish();
    return true;
  }

  async function finish() {
    const t = transferRef.current;
    if (!t || finishingRef.current) return;
    finishingRef.current = true;
    try {
      updateProgress(t, true);
      const received = t.decoder.result();
      let bytes: Uint8Array = received;
      let valid = crc32(received) === t.header.crc;
      if (valid && t.header.compressed) {
        bytes = await inflateRaw(received);
        valid = bytes.length === t.header.origSize;
      }
      if (!valid) {
        // Never hand over a corrupt file: drop it and start over cleanly.
        sfx.error();
        transferRef.current = null;
        lastPayloadRef.current = "";
        setScanInfo(null);
        setProgress(EMPTY_PROGRESS);
        setError("Checksum mismatch — the file was discarded. Keep scanning and it will restart automatically.");
        return;
      }
      const mime = t.header.mime || "application/octet-stream";
      const blob = new Blob([bytes as BlobPart], { type: mime });
      sfx.success();

      // History is best-effort: a full disk must never cost the user the file they just received.
      try {
        await saveItem({
          id: t.header.id.toString(16).padStart(8, "0") + "-" + Date.now(),
          filename: t.header.name,
          mime: t.header.mime,
          size: t.header.origSize,
          receivedAt: Date.now(),
          direction: "received",
          durationMs: Date.now() - t.startedAt,
          valid,
          blob,
        });
      } catch (err) {
        console.warn("Could not save to history:", err);
      }

      const previewUrl = URL.createObjectURL(blob);
      doneUrlRef.current = previewUrl;
      setCelebrate((n) => n + 1);
      setDone({ name: t.header.name, mime, size: t.header.origSize, blob, url: previewUrl });
      transferRef.current = null; // lets the (possibly huge) decode buffer be freed
      lastPayloadRef.current = "";
      setScanInfo(null);
      setProgress(EMPTY_PROGRESS);
      await stop(true);
      onSaved();
    } catch (e) {
      transferRef.current = null;
      lastPayloadRef.current = "";
      setScanInfo(null);
      setProgress(EMPTY_PROGRESS);
      setError(e instanceof Error ? e.message : "The scanned file could not be reconstructed yet.");
    } finally {
      finishingRef.current = false;
    }
  }

  /* ---------------------------------------------------------------- camera lifecycle */

  async function attachStream(stream: MediaStream) {
    streamRef.current = stream;
    commitView({ cx: 0.5, cy: 0.5, z: 1 });
    const video = videoRef.current;
    if (video) {
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "true");
      video.srcObject = stream;
      await waitForVideoMetadata(video);
      await video.play();
      await waitForUsableVideo(video);
      setVideoSize({ w: video.videoWidth, h: video.videoHeight });
    }
    void applyCameraFocus(stream);
  }

  async function start(facingMode: "environment" | "user" = facingRef.current) {
    if (active || starting || stopping) return;
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
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera permission is unavailable in this browser.");
      setFastDecoder(Boolean(getDetector()));
      await attachStream(await openCameraStream(facingMode));
      const remaining = CAMERA_TRANSITION_MS - (performance.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
      scanningRef.current = true;
      lastSeenQrRef.current = performance.now();
      setActive(true);
      setStarting(false);
      cancelTick();
      tick();
    } catch (e) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
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
      await sleep(CAMERA_TRANSITION_MS);
    }
    scanningRef.current = false;
    finishingRef.current = false;
    // An unfinished transfer is kept in memory so the user can resume without losing progress.
    const t = transferRef.current;
    if (t && !t.decoder.complete && t.decoder.count > 0) {
      setPaused({ name: t.header.name, size: t.header.origSize, frac: t.decoder.progress });
    } else {
      transferRef.current = null;
      setPaused(null);
    }
    lastPayloadRef.current = "";
    setActive(false);
    setStarting(false);
    setQrBox(null);
    setScanInfo(null);
    setProgress(EMPTY_PROGRESS);
    setFlipping(false);
    commitView({ cx: 0.5, cy: 0.5, z: 1 });
    boxVisibleRef.current = false;
    cancelTick();
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    }
    streamRef.current?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    });
    streamRef.current = null;
    setStopping(false);
  }
  stopRef.current = stop;

  async function flipCamera() {
    if (!active || stopping || starting || flipping) return;
    const next = facingRef.current === "environment" ? "user" : "environment";
    setFlipping(true);
    try {
      scanningRef.current = false;
      cancelTick();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      await attachStream(await openCameraStream(next));
      facingRef.current = next;
      setFacing(next);
      scanningRef.current = true;
      lastDecodeRef.current = 0;
      tick();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Camera could not flip. Try again.");
    } finally {
      await sleep(160);
      setFlipping(false);
    }
  }

  /** Auto-focus & framing: ON = lens steers at the code and the view eases in; OFF = plain camera. */
  function toggleAutoAssist() {
    const next = !autoAssistRef.current;
    autoAssistRef.current = next;
    setAutoAssist(next);
    if (next) {
      void applyCameraFocus(streamRef.current);
      sfx.toggleOn();
    } else {
      commitView({ cx: 0.5, cy: 0.5, z: 1 });
      sfx.toggleOff();
    }
  }

  function discardPaused() {
    transferRef.current = null;
    lastPayloadRef.current = "";
    setPaused(null);
    sfx.close();
  }

  /* ---------------------------------------------------------------- result actions */

  function clearDonePreview() {
    if (doneUrlRef.current) {
      URL.revokeObjectURL(doneUrlRef.current);
      doneUrlRef.current = null;
    }
    setViewer(null);
    setDone(null);
  }

  async function downloadDone() {
    if (!done?.blob || !done.url || downloading) return;
    setDownloading(true);
    const a = document.createElement("a");
    a.href = done.url;
    a.download = done.name || "offdrop-file";
    a.click();
    await sleep(600);
    setDownloading(false);
  }

  async function shareDone() {
    if (!done?.blob) return;
    try {
      const file = new File([done.blob], done.name || "offdrop-file", { type: done.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: done.name });
        onCompleteAction?.();
      } else {
        void downloadDone();
      }
    } catch {
      /* user cancelled */
    }
  }

  /* ---------------------------------------------------------------- effects */

  useEffect(() => {
    onBusyChange?.(active || starting || stopping);
  }, [active, starting, stopping, onBusyChange]);

  useEffect(() => {
    if (stopRequestKey > 0) void stopRef.current(true).then(() => onStopRequestComplete?.());
  }, [stopRequestKey, onStopRequestComplete]);

  useEffect(() => {
    if (!visible) clearDonePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Warn before the page is closed mid-transfer.
  useEffect(() => {
    if (!active || progress.total === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, progress.total]);

  useEffect(
    () => () => {
      void stopRef.current();
      workerRef.current?.terminate();
      workerRef.current = undefined;
      if (doneUrlRef.current) URL.revokeObjectURL(doneUrlRef.current);
    },
    [],
  );

  /* ---------------------------------------------------------------- render */

  const pct = progress.total ? Math.min(100, progress.frac * 100) : 0;
  const label = mediaLabel(scanInfo?.mime);
  const live = active || starting;
  const hasProgress = progress.total > 0;
  const speedLabel = progress.rate > 0 ? `${formatBytes(Math.round(progress.rate))}/s` : null;
  const etaLabel = formatEta(progress.eta);

  const errorBanner = error ? (
    <div
      role="alert"
      className="glass animate-pop-in pointer-events-auto flex items-start gap-2 rounded-2xl border border-destructive/40 p-3 text-left text-xs font-medium text-destructive"
    >
      <span className="min-w-0 flex-1">{error}</span>
      <button onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 active:scale-90">
        <X className="h-4 w-4" />
      </button>
    </div>
  ) : null;

  const statusTitle = hasProgress
    ? (scanInfo?.name ?? `Receiving ${label}`)
    : qrBox
      ? "Code locked — hold steady"
      : "Looking for an OFFDROP code…";
  const statusSub = hasProgress
    ? [scanInfo ? formatBytes(scanInfo.size) : null, speedLabel, etaLabel].filter(Boolean).join(" · ")
    : "Aim at the sender's screen";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MediaViewer item={viewer} onClose={() => setViewer(null)} />

      {/* ============================ IDLE ============================ */}
      {!live && !done && (
        <div className="relative mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-4 text-center no-scrollbar md:glass-strong md:my-auto md:max-h-[34rem] md:flex-none md:rounded-[2rem] md:py-10">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden="true" />
          <div className="hero-stage relative grid shrink-0 place-items-center">
            <span className="absolute h-32 w-32 rounded-full bg-primary/25 animate-pulse-ring md:h-40 md:w-40" />
            <div className="hero-cube relative grid h-24 w-24 place-items-center rounded-[1.75rem] bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40 md:h-28 md:w-28 md:rounded-[2rem]">
              <ScanLine className="h-10 w-10 text-primary-foreground md:h-12 md:w-12" strokeWidth={2} />
              <span className="hero-shine absolute inset-0 rounded-[1.75rem] md:rounded-[2rem]" />
            </div>
          </div>

          <div className="relative max-w-xs">
            <h2 className="text-display text-2xl md:text-3xl">{paused ? "Transfer paused" : "Receive a file"}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {paused
                ? "Your progress is kept. Point at the sender's screen again to continue."
                : "On the other device open Send, press play, then aim this camera at it."}
            </p>
          </div>

          {paused && (
            <div className="glass animate-pop-in relative w-full max-w-xs rounded-3xl p-4 text-left">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-primary to-accent text-sm font-extrabold text-primary-foreground">
                  {Math.floor(paused.frac * 100)}%
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{paused.name}</p>
                  <p className="text-[11px] text-muted-foreground">{formatBytes(paused.size)}</p>
                </div>
                <button
                  onClick={discardPaused}
                  aria-label="Discard paused transfer"
                  className="glass grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground active:scale-90"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-gradient-to-r from-primary to-accent" style={{ width: `${paused.frac * 100}%` }} />
              </div>
            </div>
          )}

          {errorBanner && <div className="relative w-full max-w-xs">{errorBanner}</div>}

          <button
            onClick={() => {
              sfx.unlock();
              void start();
            }}
            disabled={starting}
            className="group relative flex w-full max-w-xs shrink-0 items-center justify-center gap-2.5 overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-accent py-4 text-base font-bold text-primary-foreground shadow-xl shadow-primary/35 transition-transform duration-200 active:scale-[0.96] disabled:opacity-80"
          >
            <span className="btn-sheen absolute inset-0" />
            {paused ? <RotateCcw className="relative h-5 w-5" /> : <Camera className="relative h-5 w-5" />}
            <span className="relative">{paused ? "Resume scanning" : "Start camera"}</span>
          </button>

          <ul className="relative hidden flex-wrap items-center justify-center gap-2 text-[11px] font-semibold text-muted-foreground min-[380px]:flex [@media(max-height:640px)]:hidden">
            <li className="glass rounded-full px-3 py-1">Works offline</li>
            <li className="glass rounded-full px-3 py-1">Any file type</li>
            <li className="glass rounded-full px-3 py-1">Checksum verified</li>
          </ul>
        </div>
      )}

      {/* ============================ LIVE: viewfinder + status ============================ */}
      {live && !done && (
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-2.5 px-4 pb-1 md:px-8 lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(20rem,1fr)] lg:items-center lg:gap-8 lg:py-1">
          {/* The viewfinder is a bounded window, never the whole screen. */}
          <div
            ref={stageRef}
            data-no-swipe
            className="relative min-h-[12rem] flex-1 overflow-hidden rounded-[1.75rem] bg-black shadow-2xl shadow-black/30 ring-1 ring-white/10 lg:h-full lg:max-h-[calc(100dvh-13rem)] lg:min-h-0 lg:flex-none lg:aspect-[4/3] lg:w-full lg:self-center"
          >
            {/* Video + lock-on outline share ONE transformed layer so they always stay aligned. */}
            <div className="absolute inset-0 will-change-transform" style={viewTransform(view)}>
              <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
              {qrBox && active && (
                <svg
                  className="scanner-corners pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${qrBox.w} ${qrBox.h}`}
                  preserveAspectRatio="xMidYMid slice"
                >
                  <polygon points={qrBox.corners.map((p) => `${p.x},${p.y}`).join(" ")} />
                  {qrBox.corners.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={Math.max(6, qrBox.w / 140)} />
                  ))}
                </svg>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />

            {starting && !active && (
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 text-white backdrop-blur-sm">
                <Loader2 className="h-9 w-9 animate-spin" />
                <span className="text-sm font-semibold">Opening camera…</span>
              </div>
            )}

            {active && (
              <>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/35" />
                <div
                  className={`scanner-corners-in pointer-events-none absolute inset-5 rounded-3xl transition-opacity duration-300 ${
                    qrBox ? "opacity-0" : "opacity-100"
                  }`}
                >
                  <span className="absolute left-0 top-0 h-10 w-10 rounded-tl-2xl border-l-[3px] border-t-[3px] border-white/90" />
                  <span className="absolute right-0 top-0 h-10 w-10 rounded-tr-2xl border-r-[3px] border-t-[3px] border-white/90" />
                  <span className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-2xl border-b-[3px] border-l-[3px] border-white/90" />
                  <span className="absolute bottom-0 right-0 h-10 w-10 rounded-br-2xl border-b-[3px] border-r-[3px] border-white/90" />
                  <div className="absolute inset-0 overflow-hidden rounded-3xl">
                    <div className="scan-sweep-y absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent" />
                  </div>
                </div>
                <span className="hud-card pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold text-white">
                  <span className={`h-2 w-2 rounded-full ${qrBox ? "bg-emerald-400" : "animate-pulse bg-amber-300"}`} />
                  {qrBox ? "Locked" : "Searching"}
                </span>
                {autoAssist && view.z > 1.05 && (
                  <span className="hud-card pointer-events-none absolute right-3 top-3 rounded-full px-3 py-1.5 text-[11px] font-bold tabular-nums text-white">
                    {view.z.toFixed(1)}×
                  </span>
                )}
              </>
            )}

            {flipping && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/25 backdrop-blur-sm">
                <div className="glass grid h-16 w-16 place-items-center rounded-2xl">
                  <SwitchCamera className="h-7 w-7 animate-pulse text-primary" strokeWidth={2.4} />
                </div>
              </div>
            )}
          </div>

          {/* Status + controls live OUTSIDE the video, so nothing is ever drawn over the camera feed. */}
          <div className="flex min-w-0 shrink-0 flex-col gap-2.5 lg:gap-4">
            <div className="glass animate-pop-in min-w-0 rounded-3xl p-3">
              <div className="flex items-center gap-3">
                <ProgressRing value={pct} active={hasProgress} locked={Boolean(qrBox)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold leading-tight">{statusTitle}</p>
                  <p className="mt-0.5 truncate text-[11px] font-medium text-muted-foreground">{statusSub}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-primary">
                    {fastDecoder ? "Hardware" : "Software"}
                  </span>
                  {hasProgress && (
                    <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                      {progress.have}/{progress.total}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="progress-fill h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            {errorBanner}

            <div className="flex items-center gap-2">
              <button
                onClick={() => void flipCamera()}
                disabled={stopping || starting || flipping}
                aria-label={`Flip camera (current: ${facing === "environment" ? "back" : "front"})`}
                className="glass grid h-12 w-12 shrink-0 place-items-center rounded-2xl transition-transform active:scale-90 disabled:opacity-60"
              >
                <SwitchCamera className={`h-5 w-5 ${facing === "user" ? "scale-x-[-1]" : ""}`} strokeWidth={2.2} />
              </button>
              <button
                onClick={toggleAutoAssist}
                disabled={stopping || starting}
                aria-pressed={autoAssist}
                aria-label="Auto-focus and framing"
                title="Auto-focus & framing"
                className={`relative flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-2xl px-3.5 text-xs font-bold transition-all active:scale-90 disabled:opacity-60 ${
                  autoAssist ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "glass text-muted-foreground"
                }`}
              >
                <Focus className="h-5 w-5" strokeWidth={2.2} />
                <span className="hidden min-[360px]:inline">{autoAssist ? "Auto" : "Off"}</span>
              </button>
              <button
                onClick={() => void stop(true)}
                disabled={stopping}
                className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-foreground px-5 text-sm font-bold text-background shadow-lg transition-transform active:scale-95 disabled:opacity-80"
              >
                {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <CameraOff className="h-4 w-4" />}
                {stopping ? "Stopping" : "Stop"}
              </button>
            </div>
            <p className="hidden items-center gap-1.5 text-[11px] font-medium text-muted-foreground lg:flex">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Auto focus steers the lens at the code and eases the view in until it is easy to read.
            </p>
          </div>
        </div>
      )}

      {/* ============================ RESULT ============================ */}
      {done && (
        <div className="animate-pop-in relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3 pt-1 md:max-w-3xl">
          <Confetti key={celebrate} />
          <button
            type="button"
            onClick={() => {
              if (done.url) setViewer({ url: done.url, name: done.name, mime: done.mime, size: done.size, blob: done.blob });
            }}
            aria-label={`Open ${done.name}`}
            className="group glass-strong relative min-h-[14rem] w-full flex-1 overflow-hidden rounded-[2rem] bg-black/80 text-left transition-transform duration-300 active:scale-[0.985]"
          >
            {done.mime.startsWith("image/") && done.url ? (
              <img src={done.url} alt={done.name} className="absolute inset-0 h-full w-full object-contain" />
            ) : done.mime.startsWith("video/") && done.url ? (
              <>
                <video src={done.url} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-contain" />
                <span className="absolute inset-0 grid place-items-center">
                  <span className="grid h-16 w-16 place-items-center rounded-full bg-white/25 backdrop-blur transition-transform duration-300 group-hover:scale-110">
                    <Play className="ml-1 h-7 w-7 text-white" fill="currentColor" />
                  </span>
                </span>
              </>
            ) : done.mime.startsWith("audio/") ? (
              <span className="audio-tile absolute inset-0 grid place-items-center">
                <Music2 className="h-16 w-16 text-primary" strokeWidth={1.6} />
              </span>
            ) : (
              <span className="absolute inset-0 grid place-items-center text-muted-foreground">
                <FileText className="h-16 w-16" strokeWidth={1.4} />
              </span>
            )}
            <span className="success-badge absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-bold text-white backdrop-blur">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Verified
            </span>
            <span className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-bold text-white backdrop-blur transition-transform duration-300 group-hover:scale-105">
              <Maximize2 className="h-3.5 w-3.5" /> Tap to open
            </span>
          </button>

          <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{done.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {formatBytes(done.size)} · {done.mime || "file"} · saved to History
              </p>
            </div>
            <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-500" />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => void shareDone()}
              className="glass flex flex-col items-center justify-center gap-1 rounded-2xl py-3 text-xs font-bold transition-transform active:scale-95"
            >
              <Share2 className="h-5 w-5" /> Share
            </button>
            <button
              type="button"
              onClick={() => void downloadDone()}
              disabled={downloading}
              className="glass flex flex-col items-center justify-center gap-1 rounded-2xl py-3 text-xs font-bold transition-transform active:scale-95 disabled:opacity-80"
            >
              {downloading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />} Save
            </button>
            <button
              type="button"
              onClick={() => {
                clearDonePreview();
                void start();
              }}
              className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-gradient-to-br from-primary to-accent py-3 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/30 transition-transform active:scale-95"
            >
              <ScanLine className="h-5 w-5" /> Receive more
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Circular progress with the percentage in the middle. */
function ProgressRing({ value, active, locked }: { value: number; active: boolean; locked: boolean }) {
  const r = 19;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid h-12 w-12 shrink-0 place-items-center">
      <svg viewBox="0 0 48 48" className="h-12 w-12 -rotate-90">
        <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
        <circle
          cx="24"
          cy="24"
          r={r}
          fill="none"
          stroke="url(#ring-grad)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (active ? value : 0) / 100)}
          style={{ transition: "stroke-dashoffset 0.35s cubic-bezier(0.22,1,0.36,1)" }}
        />
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" />
            <stop offset="100%" stopColor="var(--color-accent)" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute text-[11px] font-extrabold tabular-nums">
        {active ? (value >= 100 ? 100 : Math.floor(value)) : locked ? "✓" : "…"}
      </span>
    </div>
  );
}

/** One-shot celebration burst; pure CSS, no dependencies. */
function Confetti() {
  const pieces = Array.from({ length: 26 }, (_, i) => {
    const angle = (i / 26) * Math.PI * 2;
    const dist = 90 + ((i * 37) % 70);
    return {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist - 40,
      rot: (i * 53) % 360,
      delay: (i % 5) * 20,
      hue: [280, 200, 320, 170, 50][i % 5],
    };
  });
  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-30 flex justify-center" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={
            {
              "--x": `${p.x}px`,
              "--y": `${p.y}px`,
              "--r": `${p.rot}deg`,
              animationDelay: `${p.delay}ms`,
              background: `oklch(0.75 0.19 ${p.hue})`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
