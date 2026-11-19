import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
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
  Activity,
  Video,
  WifiOff,
  Zap,
  Layers3,
  Timer,
} from "lucide-react";
import {
  FountainDecoder,
  RECEIVE_LIMIT_BYTES,
  crc32,
  formatBytes,
  parseFrame,
  type FrameMeta,
} from "@/lib/qr-protocol";
import { saveItem } from "@/lib/history";
import { MediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { sfx } from "@/lib/feedback";
import { haptics } from "@/lib/haptics";
import { roiFromQuads, type Rect } from "@/lib/roi";
import { RateMeter, type RateReport } from "@/lib/rate-meter";
import { useWakeLock } from "@/lib/wake-lock";

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

interface Transfer {
  meta: FrameMeta;
  decoder: FountainDecoder;
  startedAt: number;
  /** Known once a header frame has been seen (data frames alone are enough to start). */
  name: string | null;
  mime: string | null;
}

type ProgressState = {
  have: number;
  total: number;
  frac: number;
  eta: number | null;
  rate: number;
  coverage: number[];
};
const EMPTY_PROGRESS: ProgressState = { have: 0, total: 0, frac: 0, eta: null, rate: 0, coverage: [] };

type NativeDetection = { rawValue: string; cornerPoints?: Array<{ x: number; y: number }> };
type NativeDetector = { detect: (source: CanvasImageSource) => Promise<NativeDetection[]> };

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];
/** Detected codes in *video pixel* space. */
type QrBox = { w: number; h: number; quads: Quad[] };
type ScanResult = { data: string; corners: Quad };
/** Auto-framing view: centre in normalised video coordinates plus a digital zoom factor. */
type View = { cx: number; cy: number; z: number };
type DonePreview = { name: string; mime: string; size: number; blob: Blob; url?: string; report?: RateReport };
type CamQuality = "hd" | "4k";
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

const CAMERA_TRANSITION_MS = 120;
const DECODE_INTERVAL_MS = 24; // jsQR pacing (the native detector runs flat out)
const DECODE_MAX_EDGE = 1280; // jsQR decode resolution (several codes per frame need pixels)
const NATIVE_MAX_EDGE = 1920; // crop size cap when the native detector reads a zoomed crop
const MAX_INFLIGHT = 2; // frames being decoded at once (hides detector latency)
const WORKER_POOL = 2;
const PROGRESS_COMMIT_MS = 200;
const SCAN_SOUND_MS = 220;
const SEEN_MS = 150; // ignore the same frame seen again within this window
const SWITCH_AFTER = 4; // frames of a different transfer before we abandon the current one
const NAME_WAIT_MS = 3500; // finish without a header frame after this long

// Hardware autofocus & lens tracking timing
const FOCUS_THROTTLE_MS = 250;
const FOCUS_HUNT_INTERVAL_MS = 2500;
const MAX_BOXES = 16;
const LAUNCH_MIN_MS = 750; // the Start button's spinner stays long enough to be seen
const STOP_MIN_MS = 650; // same for Stop
const PING_MS = 800;
const ROI_REACQUIRE = 8; // every Nth frame scans the WHOLE frame again (new codes, moved screen)
const CAMQ_KEY = "offdrop:camq";

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

function mediaLabel(mime?: string | null) {
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
      window.setTimeout(check, 30);
    };
    check();
  });
}

async function openCameraOnce(facingMode: "environment" | "user", quality: CamQuality) {
  const attempts: MediaStreamConstraints[] = [
    ...(quality === "4k"
      ? [
          {
            video: {
              facingMode: { ideal: facingMode },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
              frameRate: { ideal: 30, max: 60 },
            },
            audio: false,
          } as MediaStreamConstraints,
        ]
      : []),
    {
      video: {
        facingMode: { ideal: facingMode },
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
    { video: { facingMode: { ideal: facingMode } }, audio: false },
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

/**
 * Open the camera, retrying briefly when the device is still being released by a previous session
 * (Windows/Chrome webcams report "NotReadableError" if you re-open them right after stopping).
 */
async function openCameraStream(facingMode: "environment" | "user", quality: CamQuality) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await openCameraOnce(facingMode, quality);
    } catch (error) {
      lastError = error;
      const name = (error as { name?: string })?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError") break; // permission problems won't fix themselves
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Camera permission is unavailable in this browser.");
}

/** High-performance hardware autofocus with point-of-interest lens steering and focus sweep pulsing. */
async function applyCameraFocus(stream: MediaStream | null, point?: Point, pulse = false) {
  const track = stream?.getVideoTracks()[0] as CameraControlTrack | undefined;
  if (!track || track.readyState !== "live") return false;
  const caps = (track.getCapabilities?.() || {}) as CameraControlCapabilities & {
    pointsOfInterest?: boolean;
    exposureMode?: string[];
    whiteBalanceMode?: string[];
  };
  const available = caps.focusMode ?? [];
  const pt = point ? { x: clamp(point.x, 0.05, 0.95), y: clamp(point.y, 0.05, 0.95) } : undefined;

  // Pulse: trigger a fast single-shot focus sweep on point then resume continuous tracking
  if (pulse && available.includes("single-shot")) {
    try {
      const singleAdv: Record<string, unknown> = { focusMode: "single-shot" };
      if (pt) singleAdv.pointsOfInterest = [pt];
      await track.applyConstraints({ advanced: [singleAdv as MediaTrackConstraintSet] });
      if (available.includes("continuous")) {
        window.setTimeout(() => {
          if (track.readyState === "live") {
            const contAdv: Record<string, unknown> = { focusMode: "continuous" };
            if (pt) contAdv.pointsOfInterest = [pt];
            void track.applyConstraints({ advanced: [contAdv as MediaTrackConstraintSet] }).catch(() => {});
          }
        }, 300);
      }
      return true;
    } catch {
      /* continue to standard attempts */
    }
  }

  const attempts: MediaTrackConstraintSet[] = [];
  if (pt) {
    attempts.push({
      focusMode: available.includes("continuous") ? "continuous" : "single-shot",
      pointsOfInterest: [pt],
      ...(caps.exposureMode?.includes("continuous") ? { exposureMode: "continuous" } : {}),
      ...(caps.whiteBalanceMode?.includes("continuous") ? { whiteBalanceMode: "continuous" } : {}),
    } as MediaTrackConstraintSet);
    if (available.includes("single-shot")) {
      attempts.push({
        focusMode: "single-shot",
        pointsOfInterest: [pt],
      } as MediaTrackConstraintSet);
    }
  }

  if (available.includes("continuous") || available.length === 0) {
    attempts.push({
      focusMode: "continuous",
      ...(caps.exposureMode?.includes("continuous") ? { exposureMode: "continuous" } : {}),
    } as MediaTrackConstraintSet);
  }

  for (const adv of attempts) {
    try {
      await track.applyConstraints({ advanced: [adv] });
      return true;
    } catch {
      /* try next constraint */
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

/**
 * Where video-normalised coordinates land inside a cover-fitted element.
 * Returns screen-normalised (0..1) coordinates.
 */
function makeScreenMapper(videoW: number, videoH: number, boxW: number, boxH: number, _v?: View) {
  const ea = boxH ? boxW / boxH : videoW / videoH;
  const va = videoW / videoH;
  const toElement = (vx: number, vy: number): Point =>
    va > ea ? { x: (vx - 0.5) / (ea / va) + 0.5, y: vy } : { x: vx, y: (vy - 0.5) / (va / ea) + 0.5 };
  return {
    exc: 0.5,
    eyc: 0.5,
    map(vx: number, vy: number): Point {
      return toElement(vx, vy);
    },
  };
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
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasPool = useRef<HTMLCanvasElement[]>([]);
  const slotBusy = useRef<boolean[]>(new Array(MAX_INFLIGHT).fill(false));
  const rafRef = useRef(0);
  const vfcRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const transferRef = useRef<Transfer | null>(null);
  const candidateRef = useRef<{ id: number; count: number } | null>(null);
  const nameTimerRef = useRef(0);
  const detectorRef = useRef<NativeDetector | null | undefined>(undefined);
  const workersRef = useRef<Worker[] | null | undefined>(undefined);
  const workerPending = useRef(new Map<number, (r: ScanResult[]) => void>());
  const workerSeq = useRef(0);
  const seenRef = useRef(new Map<string, number>());
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
  const camFramesRef = useRef(0);
  const learnedRef = useRef(0);
  const facingRef = useRef<"environment" | "user">("environment");
  const doneUrlRef = useRef<string | null>(null);
  const progressCommitRef = useRef(0);
  const viewRef = useRef<View>({ cx: 0.5, cy: 0.5, z: 1 });
  const autoAssistRef = useRef(true); // Active hardware autofocus by default
  const stopRef = useRef<(showStopping?: boolean) => Promise<void>>(async () => {});
  const polyRefs = useRef<Array<SVGPolygonElement | null>>([]);
  const lockRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const labelTextRef = useRef<HTMLSpanElement>(null);
  const stageSize = useRef({ w: 1, h: 1 });
  const videoSizeRef = useRef({ w: 16, h: 9 });
  const pctRef = useRef(0);
  const expectedRef = useRef({ n: 0, t: 0 });
  const smoothRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const lastPingRef = useRef(0);
  const samplesRef = useRef<Array<{ t: number; f: number }>>([]);
  const etaRateRef = useRef(0);
  const busyRef = useRef(false);
  const stoppingRef = useRef(false);
  const activeRef = useRef(false);
  const flippingRef = useRef(false);
  const colorModeRef = useRef(false);
  const roiRef = useRef<(Rect & { t: number; misses: number }) | null>(null);
  const meterRef = useRef(new RateMeter());
  const camQualityRef = useRef<CamQuality>("hd");
  const lastColorAtRef = useRef(0);
  const lastCountRef = useRef(0);
  const milestoneRef = useRef(0);

  const [active, setActive] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [camQuality, setCamQuality] = useState<CamQuality>("hd");
  const [camInfo, setCamInfo] = useState<{ w: number; h: number; fps: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [scanInfo, setScanInfo] = useState<{ name: string; mime: string; size: number; named: boolean } | null>(null);
  const [codeCount, setCodeCount] = useState(0);
  const [focusPing, setFocusPing] = useState<{ x: number; y: number; key: number } | null>(null);
  const [assistToast, setAssistToast] = useState<string | null>(null);
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
  const [stats, setStats] = useState({ cam: 0, rx: 0 });

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

  function canvasFor(slot: number): HTMLCanvasElement {
    return (canvasPool.current[slot] ??= document.createElement("canvas"));
  }

  /** jsQR in a small Web Worker pool; falls back to the main thread if workers are unavailable. */
  function decodeAsync(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    deep: boolean,
    channels = false,
  ): Promise<ScanResult[]> {
    if (workersRef.current === undefined) {
      try {
        const pool: Worker[] = [];
        for (let i = 0; i < WORKER_POOL; i++) {
          const worker = new Worker(new URL("../lib/qr-decode.worker.ts", import.meta.url), { type: "module" });
          worker.onmessage = (event: MessageEvent<{ id: number; results: ScanResult[] }>) => {
            const resolve = workerPending.current.get(event.data.id);
            workerPending.current.delete(event.data.id);
            resolve?.(event.data.results ?? []);
          };
          worker.onerror = () => {
            workersRef.current = null;
            for (const resolve of workerPending.current.values()) resolve([]);
            workerPending.current.clear();
          };
          pool.push(worker);
        }
        workersRef.current = pool;
      } catch {
        workersRef.current = null;
      }
    }
    const pool = workersRef.current;
    if (!pool?.length) return Promise.resolve(decodeQrMainThread(ctx, w, h, deep));
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
      pool[id % pool.length].postMessage({ id, data: img.data.buffer, w, h, deep, channels }, [img.data.buffer]);
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
    camFramesRef.current += 1;
    const slot = slotBusy.current.findIndex((b) => !b);
    if (slot < 0) return; // pipeline full: skip this camera frame rather than queue stale work
    const video = videoRef.current;
    const now = performance.now();
    const detector = getDetector();
    if (
      !video ||
      now - lastDecodeRef.current < (detector ? 0 : DECODE_INTERVAL_MS) ||
      video.readyState < video.HAVE_CURRENT_DATA ||
      video.videoWidth <= 0 ||
      video.videoHeight <= 0
    ) {
      return;
    }
    lastDecodeRef.current = now;
    slotBusy.current[slot] = true;
    void processFrame(video, slot, now).finally(() => {
      slotBusy.current[slot] = false;
    });
  }

  async function processFrame(video: HTMLVideoElement, slot: number, now: number) {
    try {
      const detector = getDetector();
      const canvas = canvasFor(slot);
      decodeFrameRef.current += 1;
      const frameNo = decodeFrameRef.current;
      const W = video.videoWidth;
      const H = video.videoHeight;
      const v = viewRef.current;
      // TRACKED FAST PATH: once codes are located, decode only a window around them (cut from the
      // full-resolution frame, so the codes also get more pixels per module). Every ROI_REACQUIRE-th
      // frame scans the whole frame again to notice new codes or a moved screen.
      const roi = roiRef.current;
      const useRoi = Boolean(roi) && now - (roi as { t: number }).t < 1500 && frameNo % ROI_REACQUIRE !== 0;
      const viewCrop = cropOf(W, H, v);
      const sx = useRoi ? (roi as Rect).sx : viewCrop.sx;
      const sy = useRoi ? (roi as Rect).sy : viewCrop.sy;
      const cropW = useRoi ? (roi as Rect).w : viewCrop.cropW;
      const cropH = useRoi ? (roi as Rect).h : viewCrop.cropH;
      // Frames bigger than the detector's sweet spot (e.g. 4K) are always passed through a downscaled canvas.
      const zoomed = useRoi || v.z > 1.02 || Math.max(W, H) > NATIVE_MAX_EDGE;
      const quads: Quad[] = []; // video pixel space
      const seenValues = new Set<string>();
      const expected = expectedRef.current;
      // We have recently seen several codes: if this frame finds fewer, look harder for the missing ones.
      const wantMore = expected.n > 1 && now - expected.t < 2500;
      // A recent colour (RGB) stream? Then read the channels first.
      const colorFirst = colorModeRef.current && now - lastColorAtRef.current < 2500;

      const collect = (raw: string, pts: Point[] | undefined, map: (p: Point) => Point) => {
        if (!raw || seenValues.has(raw)) return;
        if (!handleScan(raw)) return;
        seenValues.add(raw);
        if (pts && pts.length >= 4) quads.push([map(pts[0]), map(pts[1]), map(pts[2]), map(pts[3])] as Quad);
      };

      if (detector) {
        try {
          const runMono = async () => {
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
            const mapMain = (p: Point): Point =>
              zoomed ? { x: sx + (p.x * cropW) / cw, y: sy + (p.y * cropH) / ch } : { x: p.x, y: p.y };
            const found = await detector.detect(source);
            if (!scanningRef.current) return;
            for (const item of found) collect(item.rawValue, item.cornerPoints, mapMain);

            // Recovery pass: re-detect on four overlapping, upscaled quarters to catch small/blurred codes.
            if (wantMore && quads.length < expected.n && frameNo % 2 === 0) {
              const rw = cropW * 0.6;
              const rh = cropH * 0.6;
              const scale = Math.min(1, NATIVE_MAX_EDGE / Math.max(rw, rh));
              const qw = Math.max(1, Math.round(rw * scale));
              const qh = Math.max(1, Math.round(rh * scale));
              for (const [fx, fy] of [[0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4]] as const) {
                if (!scanningRef.current || quads.length >= expected.n) break;
                const rx = sx + cropW * fx;
                const ry = sy + cropH * fy;
                if (canvas.width !== qw) canvas.width = qw;
                if (canvas.height !== qh) canvas.height = qh;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx) break;
                ctx.drawImage(video, rx, ry, rw, rh, 0, 0, qw, qh);
                const part = await detector.detect(canvas);
                for (const item of part) {
                  collect(item.rawValue, item.cornerPoints, (p) => ({ x: rx + (p.x * rw) / qw, y: ry + (p.y * rh) / qh }));
                }
              }
            }
          };

          /**
           * Colour (RGB) streams: three independent QR codes share each tile, one per colour channel.
           * Split the camera image into R, G and B, stretch the contrast of each (cameras bleed light
           * between channels), and detect on each as a plain greyscale image.
           */
          const runChannels = async () => {
            const scale = Math.min(1, 1280 / Math.max(cropW, cropH));
            const cw = Math.max(1, Math.round(cropW * scale));
            const ch = Math.max(1, Math.round(cropH * scale));
            if (canvas.width !== cw) canvas.width = cw;
            if (canvas.height !== ch) canvas.height = ch;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
            const img = ctx.getImageData(0, 0, cw, ch);
            const d = img.data;
            const out = ctx.createImageData(cw, ch);
            const o = out.data;
            for (let k = 0; k < 3; k++) {
              if (!scanningRef.current) return;
              let mn = 255;
              let mx = 0;
              for (let i = k; i < d.length; i += 4 * 37) {
                const val = d[i];
                if (val < mn) mn = val;
                if (val > mx) mx = val;
              }
              const gain = 255 / Math.max(32, mx - mn);
              for (let i = 0; i < d.length; i += 4) {
                const val = Math.max(0, Math.min(255, (d[i + k] - mn) * gain));
                o[i] = o[i + 1] = o[i + 2] = val;
                o[i + 3] = 255;
              }
              ctx.putImageData(out, 0, 0);
              const part = await detector.detect(canvas);
              for (const item of part) {
                collect(item.rawValue, item.cornerPoints, (p) => ({ x: sx + (p.x * cropW) / cw, y: sy + (p.y * cropH) / ch }));
              }
            }
            if (quads.length) {
              colorModeRef.current = true;
              lastColorAtRef.current = now;
            }
          };

          if (colorFirst) await runChannels();
          if (quads.length === 0) await runMono();
          // Nothing readable in greyscale for a moment? Maybe it is a colour stream: try the channels now and then.
          if (quads.length === 0 && !colorFirst && frameNo % 5 === 2) await runChannels();
          // Instant capture: if native detector missed (common on LCD monitor glare/moiré), run WASM worker
          if (quads.length === 0) {
            const scale = Math.min(1, DECODE_MAX_EDGE / Math.max(cropW, cropH));
            const cw = Math.max(1, Math.round(cropW * scale));
            const ch = Math.max(1, Math.round(cropH * scale));
            if (canvas.width !== cw) canvas.width = cw;
            if (canvas.height !== ch) canvas.height = ch;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
              const mapJs = (p: Point): Point => ({ x: sx + (p.x * cropW) / cw, y: sy + (p.y * cropH) / ch });
              const codes = await decodeAsync(ctx, cw, ch, true);
              if (scanningRef.current) {
                for (const code of codes) collect(code.data, code.corners, mapJs);
              }
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
        const mapJs = (p: Point): Point => ({ x: sx + (p.x * cropW) / cw, y: sy + (p.y * cropH) / ch });
        const deep = (!boxVisibleRef.current ? frameNo % 3 === 0 : frameNo % 14 === 0) || (wantMore && frameNo % 2 === 0);
        if (colorFirst) {
          ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
          for (const code of await decodeAsync(ctx, cw, ch, true, true)) collect(code.data, code.corners, mapJs);
          if (quads.length) lastColorAtRef.current = now;
        }
        if (quads.length === 0) {
          ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
          const codes = await decodeAsync(ctx, cw, ch, deep);
          if (!scanningRef.current) return;
          for (const code of codes) collect(code.data, code.corners, mapJs);
        }
        if (quads.length === 0 && !colorFirst && frameNo % 5 === 2) {
          ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cw, ch);
          for (const code of await decodeAsync(ctx, cw, ch, true, true)) collect(code.data, code.corners, mapJs);
          if (quads.length) {
            colorModeRef.current = true;
            lastColorAtRef.current = now;
          }
        }
      }
      frameErrorCountRef.current = 0;

      const n = quads.length;
      if (n >= expected.n || now - expected.t > 2500) expectedRef.current = { n, t: now };

      if (n > 0) {
        lastSeenQrRef.current = now;
        boxVisibleRef.current = true;
        if (lastCountRef.current === 0) haptics.lock(); // first code of this sighting: a little click
        lastCountRef.current = n;
        // Tracking is applied straight to the DOM (no React render) so the outline follows the code exactly.
        applyDetections(quads, W, H);
        setCodeCount((prev) => (prev === n ? prev : n));
        stepAutoFrame(quads, W, H, now);
        // Follow the codes. A tracked frame that found fewer codes than expected keeps its window
        // (the missing ones are probably just outside it); the next full-frame pass widens it again.
        if (!useRoi || n >= expected.n) {
          const next = roiFromQuads(quads, W, H);
          if (next) roiRef.current = { ...next, t: now, misses: 0 };
        } else if (roiRef.current) {
          roiRef.current.t = now;
        }
      } else {
        if (useRoi && roiRef.current) {
          roiRef.current.misses += 1;
          if (roiRef.current.misses >= 2) roiRef.current = null; // lost them: back to full-frame search
        }
        if (boxVisibleRef.current && now - lastSeenQrRef.current > 250) {
          boxVisibleRef.current = false;
          lastCountRef.current = 0;
          applyDetections(null, W, H);
          setCodeCount(0);
        }
        // Lost every code for a while: sweep lens back to center to re-acquire.
        if (autoAssistRef.current && now - lastSeenQrRef.current > FOCUS_HUNT_INTERVAL_MS) {
          relaxAutoFrame(now);
        }
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

  /** Draw the tracking graphics straight into the DOM: outlines (video space) + 3D lock frame (screen space). */
  function applyDetections(quads: Quad[] | null, W: number, H: number) {
    const polys = polyRefs.current;
    const lock = lockRef.current;
    if (!quads || quads.length === 0) {
      for (const el of polys) if (el) el.style.display = "none";
      if (lock) {
        lock.style.opacity = "0";
        lock.dataset.shown = "0";
      }
      return;
    }
    for (let i = 0; i < MAX_BOXES; i++) {
      const el = polys[i];
      if (!el) continue;
      const q = quads[i];
      if (q) {
        el.setAttribute("points", q.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" "));
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    }
    if (!lock) return;
    const g = makeScreenMapper(W, H, stageSize.current.w, stageSize.current.h, viewRef.current);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of quads) {
      for (const pt of q) {
        const sp = g.map(pt.x / W, pt.y / H);
        minX = Math.min(minX, sp.x);
        maxX = Math.max(maxX, sp.x);
        minY = Math.min(minY, sp.y);
        maxY = Math.max(maxY, sp.y);
      }
    }
    const pad = 0.018;
    minX = clamp(minX - pad, 0, 1);
    maxX = clamp(maxX + pad, 0, 1);
    minY = clamp(minY - pad, 0, 1);
    maxY = clamp(maxY + pad, 0, 1);
    lock.style.left = `${minX * 100}%`;
    lock.style.top = `${minY * 100}%`;
    lock.style.width = `${(maxX - minX) * 100}%`;
    lock.style.height = `${(maxY - minY) * 100}%`;
    lock.style.setProperty("--tx", `${(((minX + maxX) / 2 - 0.5) * -14).toFixed(2)}deg`);
    lock.style.setProperty("--ty", `${(((minY + maxY) / 2 - 0.5) * 14).toFixed(2)}deg`);
    if (lock.dataset.shown !== "1") {
      lock.dataset.shown = "1";
      lock.classList.remove("lock-enter");
      void lock.offsetWidth; // restart the CSS animation
      lock.classList.add("lock-enter");
    }
    lock.style.opacity = "1";
    // The label sits above the frame, or below / inside it when there is no room (never clipped).
    const label = labelRef.current;
    if (label) {
      label.dataset.pos = minY > 0.14 ? "above" : maxY < 0.86 ? "below" : "inside";
      if (labelTextRef.current) {
        const n = quads.length;
        const p = pctRef.current;
        labelTextRef.current.textContent = `${n} code${n > 1 ? "s" : ""}${p > 0 ? ` · ${Math.floor(p)}%` : ""}`;
      }
    }
  }

  /** Visible confirmation that the lens is being steered: a focus square at the point it aims for. */
  function pingFocus(vx: number, vy: number, W: number, H: number, now: number, force = false) {
    if (!force && now - lastPingRef.current < 1500) return;
    lastPingRef.current = now;
    const g = makeScreenMapper(W, H, stageSize.current.w, stageSize.current.h, viewRef.current);
    const sp = g.map(vx, vy);
    setFocusPing({ x: clamp(sp.x, 0.08, 0.92) * 100, y: clamp(sp.y, 0.08, 0.92) * 100, key: Math.round(now) });
    window.setTimeout(() => setFocusPing(null), PING_MS);
  }

  /**
   * Hardware lens tracking: steers the physical camera lens at the centroid of detected QR codes.
   * Viewfinder stays rock-solid at native 1x resolution with zero digital zooming jitter.
   */
  function stepAutoFrame(quads: Quad[], W: number, H: number, now: number) {
    if (!autoAssistRef.current || flippingRef.current) return;
    if (now - lastFrameStepRef.current < FOCUS_THROTTLE_MS) return;
    lastFrameStepRef.current = now;

    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const q of quads) {
      for (const pt of q) {
        sumX += pt.x / W;
        sumY += pt.y / H;
        count++;
      }
    }
    if (count === 0) return;
    const cx = sumX / count;
    const cy = sumY / count;

    const prev = smoothRef.current;
    const moved = prev ? Math.hypot(cx - prev.minX, cy - prev.minY) > 0.08 : true;
    if (moved || now - lastFocusRef.current > 1200) {
      lastFocusRef.current = now;
      smoothRef.current = { minX: cx, maxX: cx, minY: cy, maxY: cy };
      void applyCameraFocus(streamRef.current, { x: cx, y: cy });
      pingFocus(cx, cy, W, H, now, false);
    }
  }

  function relaxAutoFrame(now: number) {
    if (!autoAssistRef.current || flippingRef.current) return;
    if (now - lastFocusRef.current < FOCUS_HUNT_INTERVAL_MS) return;
    lastFocusRef.current = now;
    smoothRef.current = null;
    void applyCameraFocus(streamRef.current, { x: 0.5, y: 0.5 }, true);
    pingFocus(0.5, 0.5, videoSizeRef.current.w, videoSizeRef.current.h, now, false);
  }

  /** Tap on viewfinder to focus: steers hardware lens directly to the tapped coordinate. */
  function handleStageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!activeRef.current || !streamRef.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clickX = (e.clientX - rect.left) / rect.width;
    const clickY = (e.clientY - rect.top) / rect.height;

    const W = videoSizeRef.current.w;
    const H = videoSizeRef.current.h;
    const ea = rect.width / rect.height;
    const va = W / H;
    let vx = clickX;
    let vy = clickY;
    if (va > ea) {
      vx = (clickX - 0.5) * (ea / va) + 0.5;
    } else {
      vy = (clickY - 0.5) * (va / ea) + 0.5;
    }
    vx = clamp(vx, 0.05, 0.95);
    vy = clamp(vy, 0.05, 0.95);

    const now = performance.now();
    lastFocusRef.current = now;
    void applyCameraFocus(streamRef.current, { x: vx, y: vy }, true);
    pingFocus(vx, vy, W, H, now, true);
    haptics.lock();
    sfx.tick();
    setAssistToast("Focus locked");
    window.setTimeout(() => setAssistToast(null), 1200);
  }

  /** View transform: keeps the preview 100% stable at native 1x (no digital zoom jitter). */
  function viewTransform(_v?: View): CSSProperties {
    return {
      transform: "none",
      transition: flipping ? "opacity 0.16s ease" : undefined,
    };
  }

  /* ---------------------------------------------------------------- progress + frames */

  function updateProgress(t: Transfer, force = false) {
    const now = performance.now();
    if (!force && now - progressCommitRef.current < PROGRESS_COMMIT_MS) return;
    progressCommitRef.current = now;
    const frac = t.decoder.progress;
    pctRef.current = frac * 100;
    meterRef.current.add(now, frac * t.meta.size);
    const step = frac >= 0.75 ? 3 : frac >= 0.5 ? 2 : frac >= 0.25 ? 1 : 0;
    if (step > milestoneRef.current && frac < 1) {
      milestoneRef.current = step;
      haptics.milestone(step as 1 | 2 | 3);
    }
    const elapsed = (Date.now() - t.startedAt) / 1000;

    // Rate is measured over the LAST ~10 seconds of real progress, smoothed: it follows reality
    // (camera quality, distance) instead of extrapolating the slow first moments.
    const samples = samplesRef.current;
    samples.push({ t: now, f: frac });
    while (samples.length > 2 && now - samples[0].t > 10000) samples.shift();
    const first = samples[0];
    const span = (now - first.t) / 1000;
    const df = frac - first.f;
    if (span >= 2 && df > 0) {
      const inst = df / span;
      etaRateRef.current = etaRateRef.current ? etaRateRef.current * 0.6 + inst * 0.4 : inst;
    } else if (span >= 5 && df <= 0) {
      etaRateRef.current = 0; // stalled: do not promise a time
    }
    const rate = etaRateRef.current;
    const eta = elapsed >= 2.5 && frac >= 0.015 && rate > 0 && frac < 1 ? (1 - frac) / rate : null;
    setProgress({
      have: t.decoder.count,
      total: t.meta.total,
      frac,
      eta,
      rate: rate * t.meta.size,
      coverage: t.decoder.coverage(48),
    });
  }

  function startTransfer(meta: FrameMeta): Transfer | null {
    if (meta.size > RECEIVE_LIMIT_BYTES) {
      setError(
        `This file (${formatBytes(meta.size)}) is too large to receive on this device. The limit is ${formatBytes(RECEIVE_LIMIT_BYTES)}.`,
      );
      return null;
    }
    let decoder: FountainDecoder;
    try {
      decoder = new FountainDecoder(meta);
    } catch {
      setError("Not enough free memory on this device to receive this file.");
      return null;
    }
    const t: Transfer = { meta, decoder, startedAt: Date.now(), name: null, mime: null };
    transferRef.current = t;
    candidateRef.current = null;
    samplesRef.current = [];
    etaRateRef.current = 0;
    pctRef.current = 0;
    milestoneRef.current = 0;
    meterRef.current.reset();
    window.clearTimeout(nameTimerRef.current);
    setError(null);
    setPaused(null);
    setScanInfo({ name: "Incoming file", mime: "", size: meta.origSize, named: false });
    sfx.fileFound();
    return t;
  }

  /** Returns true when the payload was one of ours (used to pick among several QR codes). */
  function handleScan(payload: string): boolean {
    if (finishingRef.current) return true;
    const now = performance.now();
    // The same frame stays on screen for several camera frames; skip repeats before any parsing.
    const key = payload.length > 32 ? payload.slice(0, 32) : payload;
    const prev = seenRef.current.get(key);
    if (prev !== undefined && now - prev < SEEN_MS) return true;
    const parsed = parseFrame(payload);
    if (!parsed) return false;
    seenRef.current.set(key, now);
    if (seenRef.current.size > 96) seenRef.current.clear();

    let t = transferRef.current;
    if (t && t.meta.id !== parsed.id) {
      // Another transfer is in view. Only abandon the current one if the new one persists
      // (avoids flicker when a second sender's screen briefly crosses the frame).
      const cand = candidateRef.current;
      if (!cand || cand.id !== parsed.id) candidateRef.current = { id: parsed.id, count: 1 };
      else cand.count += 1;
      if ((candidateRef.current?.count ?? 0) < SWITCH_AFTER) return true;
      t = null;
    }
    // INSTANT START: any frame (data, repair or header) carries everything needed.
    if (!t) {
      t = startTransfer(parsed.meta);
      if (!t) return true;
      updateProgress(t, true);
    }

    if (parsed.kind === "header") {
      if (t.name === null) {
        t.name = parsed.name;
        t.mime = parsed.mime;
        setScanInfo({ name: parsed.name, mime: parsed.mime, size: t.meta.origSize, named: true });
        sfx.tick();
      }
      if (t.decoder.complete) void finish();
      return true;
    }

    if (t.decoder.add(parsed)) {
      learnedRef.current += 1;
      updateProgress(t);
      if (now - lastScanSoundRef.current > SCAN_SOUND_MS) {
        lastScanSoundRef.current = now;
        sfx.scan(t.decoder.progress);
      }
    }
    if (t.decoder.complete) {
      if (t.name !== null) void finish();
      else if (!nameTimerRef.current) {
        // Complete before any header frame arrived: give one a moment, then save with a generic name.
        nameTimerRef.current = window.setTimeout(() => {
          nameTimerRef.current = 0;
          void finish();
        }, NAME_WAIT_MS);
      }
    }
    return true;
  }

  async function finish() {
    const t = transferRef.current;
    if (!t || finishingRef.current || !t.decoder.complete) return;
    finishingRef.current = true;
    window.clearTimeout(nameTimerRef.current);
    nameTimerRef.current = 0;
    try {
      updateProgress(t, true);
      const received = t.decoder.result();
      let bytes: Uint8Array = received;
      let valid = crc32(received) === t.meta.crc;
      if (valid && t.meta.compressed) {
        bytes = await inflateRaw(received);
        valid = bytes.length === t.meta.origSize;
      }
      if (!valid) {
        // Never hand over a corrupt file: drop it and start over cleanly.
        sfx.error();
        transferRef.current = null;
        seenRef.current.clear();
        setScanInfo(null);
        setProgress(EMPTY_PROGRESS);
        setError("Checksum mismatch — the file was discarded. Keep scanning and it will restart automatically.");
        return;
      }
      const idHex = t.meta.id.toString(16).padStart(8, "0");
      const name = t.name ?? `offdrop-${idHex}`;
      const mime = t.mime || "application/octet-stream";
      const blob = new Blob([bytes as BlobPart], { type: mime });
      sfx.success();
      haptics.success();

      // History is best-effort: a full disk must never cost the user the file they just received.
      try {
        await saveItem({
          id: idHex + "-" + Date.now(),
          filename: name,
          mime,
          size: t.meta.origSize,
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
      const report = meterRef.current.report(t.meta.size, performance.now());
      setDone({ name, mime, size: t.meta.origSize, blob, url: previewUrl, report });
      transferRef.current = null; // lets the (possibly huge) decode buffer be freed
      seenRef.current.clear();
      setScanInfo(null);
      setProgress(EMPTY_PROGRESS);
      await stop(false); // straight to the result card: no extra waiting
      onSaved();
    } catch (e) {
      transferRef.current = null;
      seenRef.current.clear();
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
    if (!video) return;

    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("autoplay", "true");
    video.srcObject = stream;

    // Listen for OS or browser revoking track
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        console.warn("Camera track ended by system/OS");
        void stopRef.current(false);
      };
    }

    // Start playback immediately
    try {
      await video.play();
    } catch (err) {
      console.warn("video.play() initial call error:", err);
    }

    // Safely wait for metadata & usable frame without hanging or crashing
    await Promise.race([waitForVideoMetadata(video), sleep(1200)]);
    await Promise.race([waitForUsableVideo(video), sleep(1200)]);

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    setVideoSize({ w: vw, h: vh });
    videoSizeRef.current = { w: vw, h: vh };

    const st = track?.getSettings?.() ?? {};
    setCamInfo({
      w: st.width || vw,
      h: st.height || vh,
      fps: Math.round(st.frameRate || 30),
    });
  }

  async function start(facingMode: "environment" | "user" = facingRef.current) {
    if (busyRef.current) return;
    if (activeRef.current) {
      const hasLiveTrack = streamRef.current?.getVideoTracks().some((t) => t.readyState === "live");
      if (hasLiveTrack) return;
      await stop(false);
    }
    busyRef.current = true;
    facingRef.current = facingMode;
    setFacing(facingMode);
    setError(null);
    setLaunching(true); // the Start button's camera icon turns into a spinner

    try {
      // Release any lingering tracks before requesting a new stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        streamRef.current = null;
      }

      // If the previous session is still shutting down, wait for it instead of silently doing nothing.
      for (let i = 0; i < 40 && stoppingRef.current; i++) await sleep(25);
      if (doneUrlRef.current) {
        URL.revokeObjectURL(doneUrlRef.current);
        doneUrlRef.current = null;
      }
      setDone(null);
      finishingRef.current = false;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera permission is unavailable in this browser.");
      setFastDecoder(Boolean(getDetector()));

      // Open the camera while the spinner plays; hold the moment for at least LAUNCH_MIN_MS.
      const [stream] = await Promise.all([openCameraStream(facingMode, camQualityRef.current), sleep(LAUNCH_MIN_MS)]);

      setStarting(true);
      setLaunching(false);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await sleep(40);

      if (!videoRef.current) throw new Error("The camera view is unavailable. Please reload the page.");
      await attachStream(stream);
      void applyCameraFocus(stream);
      await sleep(CAMERA_TRANSITION_MS);

      scanningRef.current = true;
      activeRef.current = true;
      lastSeenQrRef.current = performance.now();
      camFramesRef.current = 0;
      learnedRef.current = 0;
      expectedRef.current = { n: 0, t: 0 };
      smoothRef.current = null;
      colorModeRef.current = false;
      roiRef.current = null;
      lastCountRef.current = 0;
      setActive(true);
      setStarting(false);
      haptics.start();
      cancelTick();
      tick();
    } catch (e) {
      console.error("Camera start error:", e);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        streamRef.current = null;
      }
      scanningRef.current = false;
      activeRef.current = false;
      setLaunching(false);
      setStarting(false);
      setStopping(false);
      setActive(false);
      haptics.error();
      setError(e instanceof Error ? e.message : "Camera unavailable. Grant camera permission and retry.");
    } finally {
      busyRef.current = false;
    }
  }

  async function stop(showStopping = false) {
    // Take effect IMMEDIATELY (the button must feel instant), then show the moment.
    const wasLive = activeRef.current || Boolean(streamRef.current);
    scanningRef.current = false;
    activeRef.current = false;
    stoppingRef.current = true;
    cancelTick();
    const shouldShowStopping = showStopping && wasLive;
    if (shouldShowStopping) {
      setStopping(true);
      setStarting(false);
      haptics.stop();
    }
    finishingRef.current = false;
    window.clearTimeout(nameTimerRef.current);
    nameTimerRef.current = 0;
    applyDetections(null, 1, 1);

    // Camera off right away (privacy + the LED), then pause the preview.
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
      streamRef.current = null;
    }

    // An unfinished transfer is kept in memory so the user can resume without losing progress.
    const t = transferRef.current;
    if (t && !t.decoder.complete && t.decoder.count > 0) {
      setPaused({ name: t.name ?? "Incoming file", size: t.meta.origSize, frac: t.decoder.progress });
    } else {
      transferRef.current = null;
      setPaused(null);
    }
    seenRef.current.clear();

    // Hold the spinner long enough to be felt, then switch the UI back.
    if (shouldShowStopping) await sleep(STOP_MIN_MS);
    setActive(false);
    setStarting(false);
    setCodeCount(0);
    setScanInfo(null);
    setProgress(EMPTY_PROGRESS);
    setFlipping(false);
    flippingRef.current = false;
    commitView({ cx: 0.5, cy: 0.5, z: 1 });
    boxVisibleRef.current = false;
    lastCountRef.current = 0;
    milestoneRef.current = 0;
    roiRef.current = null;
    // Give the OS a moment to release the device so an immediate restart works (desktop webcams).
    await sleep(100);
    setStopping(false);
    stoppingRef.current = false;
  }
  stopRef.current = stop;

  async function flipCamera() {
    if (!active || stopping || starting || flipping) return;
    const next = facingRef.current === "environment" ? "user" : "environment";
    setFlipping(true);
    flippingRef.current = true;
    try {
      scanningRef.current = false;
      cancelTick();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      await attachStream(await openCameraStream(next, camQualityRef.current));
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
      flippingRef.current = false;
    }
  }

  /** Auto focus: ON = hardware lens steers at the codes; OFF = manual focus. */
  function toggleAutoAssist() {
    const next = !autoAssistRef.current;
    autoAssistRef.current = next;
    setAutoAssist(next);
    smoothRef.current = null;
    setAssistToast(next ? "Autofocus active · lens tracking" : "Autofocus paused · manual");
    window.setTimeout(() => setAssistToast(null), 1600);
    if (next) {
      void applyCameraFocus(streamRef.current, { x: 0.5, y: 0.5 }, true);
      pingFocus(0.5, 0.5, videoSizeRef.current.w, videoSizeRef.current.h, performance.now(), true);
      sfx.toggleOn();
    } else {
      sfx.toggleOff();
    }
  }

  /** Switch between HD (1080p) and 4K capture without leaving the screen. */
  async function toggleQuality() {
    if (!activeRef.current || flippingRef.current || stoppingRef.current) return;
    const next: CamQuality = camQualityRef.current === "hd" ? "4k" : "hd";
    camQualityRef.current = next;
    setCamQuality(next);
    try {
      localStorage.setItem(CAMQ_KEY, next);
    } catch {
      /* ignore */
    }
    setAssistToast(next === "4k" ? "4K capture · more pixels per module" : "HD capture · faster, lighter");
    window.setTimeout(() => setAssistToast(null), 1600);
    flippingRef.current = true;
    setFlipping(true);
    haptics.toggle(next === "4k");
    try {
      scanningRef.current = false;
      cancelTick();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      roiRef.current = null;
      await attachStream(await openCameraStream(facingRef.current, next));
      scanningRef.current = true;
      lastDecodeRef.current = 0;
      tick();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the camera quality.");
    } finally {
      await sleep(160);
      setFlipping(false);
      flippingRef.current = false;
    }
  }

  function discardPaused() {
    transferRef.current = null;
    seenRef.current.clear();
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

  // When the app or tab is backgrounded (user switches apps, locks screen), release the camera
  // so the OS doesn't kill it or leave the device in a locked/glitched state.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && activeRef.current) {
        void stopRef.current(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!visible) {
      clearDonePreview();
      if (activeRef.current) {
        void stopRef.current(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Live health numbers: how fast the camera delivers frames vs. how many new codes we actually learn.
  useEffect(() => {
    if (!active) return;
    let lastCam = camFramesRef.current;
    let lastRx = learnedRef.current;
    const id = window.setInterval(() => {
      setStats({ cam: camFramesRef.current - lastCam, rx: learnedRef.current - lastRx });
      lastCam = camFramesRef.current;
      lastRx = learnedRef.current;
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CAMQ_KEY);
      if (saved === "4k" || saved === "hd") {
        camQualityRef.current = saved;
        setCamQuality(saved);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Keep the viewfinder size in a ref (reading clientWidth during render forced a layout each frame).
  const liveNow = active || starting;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      stageSize.current = { w: el.clientWidth || 1, h: el.clientHeight || 1 };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [liveNow]);

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
      window.clearTimeout(nameTimerRef.current);
      workersRef.current?.forEach((w) => w.terminate());
      workersRef.current = undefined;
      if (doneUrlRef.current) URL.revokeObjectURL(doneUrlRef.current);
    },
    [],
  );

  /* ---------------------------------------------------------------- render */

  const pct = progress.total ? Math.min(100, progress.frac * 100) : 0;
  const live = active || starting || stopping;
  const hasProgress = progress.total > 0;
  const named = scanInfo?.named ?? false;
  const speedLabel = progress.rate > 0 ? `${formatBytes(Math.round(progress.rate))}/s` : null;
  const etaLabel = formatEta(progress.eta);
  const phase: "searching" | "locked" | "receiving" = hasProgress ? "receiving" : codeCount > 0 ? "locked" : "searching";

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

  const statusTitle =
    phase === "receiving"
      ? named
        ? (scanInfo?.name ?? "Receiving")
        : `Receiving ${mediaLabel(scanInfo?.mime)}…`
      : phase === "locked"
        ? `${codeCount} code${codeCount > 1 ? "s" : ""} locked`
        : "Looking for an OFFDROP code…";
  const statusSub =
    phase === "receiving"
      ? [scanInfo ? formatBytes(scanInfo.size) : null, speedLabel, etaLabel].filter(Boolean).join(" · ")
      : phase === "locked"
        ? "Reading… hold steady"
        : "Aim at the center of the screen";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MediaViewer item={viewer} onClose={() => setViewer(null)} />

      {/* ============================ IDLE (same card language as Send) ============================ */}
      {!live && !done && (
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-6 animate-fade-up md:px-8">
          <div className="relative flex w-full max-w-2xl flex-col items-center justify-center rounded-[2.25rem] px-6 py-9 text-center md:glass md:py-16">
            <div className="hero-stage relative mb-6 grid shrink-0 place-items-center">
              <span className="absolute h-32 w-32 rounded-full bg-primary/25 animate-pulse-ring md:h-40 md:w-40" />
              <div className="hero-cube relative grid h-24 w-24 place-items-center rounded-[1.75rem] bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40 md:h-28 md:w-28 md:rounded-[2rem]">
                <ScanLine className="h-10 w-10 text-primary-foreground md:h-12 md:w-12" strokeWidth={2} />
                <span className="hero-shine absolute inset-0 rounded-[1.75rem] md:rounded-[2rem]" />
              </div>
            </div>

            <h2 className="text-display text-3xl md:text-4xl">{paused ? "Transfer paused" : "Receive files"}</h2>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground md:text-base">
              {paused
                ? "Your progress is kept. Point at the sender's screen again to continue."
                : "Open Send on the other device, press play, then aim this camera at its screen."}
            </p>

            {paused && (
              <div className="glass animate-pop-in relative mt-5 w-full max-w-xs rounded-3xl p-4 text-left">
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

            {errorBanner && <div className="mt-5 w-full max-w-sm">{errorBanner}</div>}

            <button
              onClick={() => {
                sfx.unlock();
                void start();
              }}
              disabled={launching || starting || stopping}
              className="group relative mt-7 flex items-center gap-2 overflow-hidden rounded-full bg-gradient-to-br from-primary to-accent px-8 py-4 text-sm font-bold text-primary-foreground shadow-xl shadow-primary/30 transition-transform duration-200 active:scale-95 disabled:opacity-90"
            >
              <span className="btn-sheen absolute inset-0" />
              <span className="relative inline-block h-4 w-4" aria-hidden="true">
                <span
                  className="absolute inset-0 grid place-items-center transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                  style={{ opacity: launching ? 0 : 1, transform: launching ? "scale(0.2) rotate(120deg)" : "scale(1)" }}
                >
                  {paused ? <RotateCcw className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
                </span>
                <span
                  className="absolute inset-0 grid place-items-center transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                  style={{ opacity: launching ? 1 : 0, transform: launching ? "scale(1)" : "scale(0.2) rotate(-120deg)" }}
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                </span>
              </span>
              <span className="relative">{launching ? "Starting camera…" : paused ? "Resume scanning" : "Start camera"}</span>
            </button>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold text-muted-foreground">
              <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                <Zap className="h-3 w-3 text-primary" /> Hardware decoding
              </span>
              <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                <Layers3 className="h-3 w-3 text-primary" /> Reads up to 8 codes at once
              </span>
              <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                <ShieldCheck className="h-3 w-3 text-primary" /> Checksum verified
              </span>
              <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                <WifiOff className="h-3 w-3 text-primary" /> Works offline
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ============================ LIVE: viewfinder + status ============================ */}
      {/* Always mounted (hidden when idle): the <video> element can never be "missing" when the camera starts. */}
      {(
        <div className={`mx-auto min-h-0 w-full max-w-6xl flex-1 flex-col gap-2.5 px-4 pb-1 md:px-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(21rem,1fr)] lg:items-center lg:gap-8 lg:py-1 ${live && !done ? "flex lg:grid" : "invisible absolute inset-0 pointer-events-none -z-10"}`}>
          {/* The viewfinder is a bounded window, never the whole screen. */}
          <div
            ref={stageRef}
            data-no-swipe
            onClick={handleStageClick}
            onContextMenu={(e) => e.preventDefault()}
            className={`relative min-h-[12rem] flex-1 select-none [-webkit-touch-callout:none] overflow-hidden rounded-[1.75rem] bg-black shadow-2xl shadow-black/30 ring-1 ring-white/10 transition-shadow duration-500 lg:h-full lg:max-h-[calc(100dvh-13rem)] lg:min-h-0 lg:flex-none lg:aspect-[4/3] lg:w-full lg:self-center cursor-pointer ${
              autoAssist ? "autofocus-ring" : ""
            }`}
          >
            {/* Video + exact code outlines share ONE transformed layer so they always stay aligned. */}
            <div className="absolute inset-0 will-change-transform" style={viewTransform(view)}>
              <video
                ref={videoRef}
                playsInline
                muted
                disablePictureInPicture
                disableRemotePlayback
                controlsList="nodownload noplaybackrate noremoteplayback"
                onContextMenu={(e) => e.preventDefault()}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
              />
              <svg
                className="scanner-corners lock-svg pointer-events-none absolute inset-0 h-full w-full"
                viewBox={`0 0 ${videoSize.w} ${videoSize.h}`}
                preserveAspectRatio="xMidYMid slice"
              >
                {Array.from({ length: MAX_BOXES }, (_, i) => (
                  <polygon
                    key={i}
                    ref={(el) => {
                      polyRefs.current[i] = el;
                    }}
                    style={{ display: "none" }}
                  />
                ))}
              </svg>
            </div>

            {starting && !active && (
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 text-white backdrop-blur-sm">
                <Loader2 className="h-9 w-9 animate-spin" />
                <span className="text-sm font-semibold">Opening camera…</span>
              </div>
            )}
            {stopping && (
              <div className="animate-pop-in pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/70 text-white backdrop-blur-md">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <span className="text-sm font-bold">Stopping camera…</span>
              </div>
            )}

            {active && (
              <>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/30" />

                {/* Searching reticle (fades out the instant a code is locked). */}
                <div
                  className={`scanner-corners-in pointer-events-none absolute inset-6 rounded-3xl transition-all duration-500 ${
                    codeCount > 0 ? "scale-110 opacity-0" : "opacity-100"
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

                {/* 3D lock-on frame around ALL detected codes. Positioned imperatively every frame. */}
                <div className="lock-stage pointer-events-none absolute inset-0">
                  <div ref={lockRef} className="lock-frame absolute" style={{ opacity: 0 }}>
                    <span className="lock-corner left-0 top-0 rounded-tl-xl border-l-[3px] border-t-[3px]" />
                    <span className="lock-corner right-0 top-0 rounded-tr-xl border-r-[3px] border-t-[3px]" />
                    <span className="lock-corner bottom-0 left-0 rounded-bl-xl border-b-[3px] border-l-[3px]" />
                    <span className="lock-corner bottom-0 right-0 rounded-br-xl border-b-[3px] border-r-[3px]" />
                    <span ref={labelRef} data-pos="above" className="lock-label">
                      <Sparkles className="h-3 w-3" />
                      <span ref={labelTextRef} />
                    </span>
                  </div>
                </div>

                {/* Auto focus: a focus square where the lens is aimed, and a confirmation toast. */}
                {focusPing && <span key={focusPing.key} className="focus-ping" style={{ left: `${focusPing.x}%`, top: `${focusPing.y}%` }} />}
                {assistToast && (
                  <div className="switch-toast pointer-events-none absolute bottom-14 left-1/2 z-20 flex items-center gap-2 whitespace-nowrap rounded-full bg-black/70 px-3.5 py-2 text-[11px] font-bold text-white shadow-lg backdrop-blur">
                    <Focus className="h-3.5 w-3.5 text-primary" />
                    {assistToast}
                  </div>
                )}
                {autoAssist && (
                  <span className="hud-card pointer-events-none absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-extrabold text-white">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    AUTOFOCUS
                  </span>
                )}

                {/* Status chip: centred at the top, and it changes with what is actually happening. */}
                <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
                  <span
                    key={phase}
                    className="hud-card animate-pop-in flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] font-bold text-white"
                  >
                    {phase === "searching" && <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />}
                    {phase === "locked" && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                    {phase === "receiving" && <Activity className="h-3.5 w-3.5 text-emerald-300" />}
                    {phase === "searching" ? "Searching…" : phase === "locked" ? "Code detected" : `Receiving ${Math.floor(pct)}%`}
                  </span>
                </div>
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

          {/* Status, progress and controls live OUTSIDE the video, so nothing covers the camera feed. */}
          <div className="flex min-w-0 shrink-0 flex-col gap-2.5 lg:gap-3.5">
            <div className="glass animate-pop-in min-w-0 rounded-3xl p-3">
              <div className="flex items-center gap-3">
                <ProgressRing value={pct} active={hasProgress} phase={phase} />
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
            </div>

            {/* Progress lives in its own track, with a chunk map showing exactly which parts have arrived. */}
            <div className="min-w-0 px-1">
              <div className="flex items-center justify-between gap-3 text-[11px] font-bold">
                <span className="tabular-nums">{pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%</span>
                <span className="flex min-w-0 items-center gap-1.5 truncate font-medium text-muted-foreground">
                  {hasProgress ? (
                    [speedLabel, etaLabel].filter(Boolean).join(" · ") || "receiving…"
                  ) : (
                    <>
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
                      Waiting for the first code
                    </>
                  )}
                </span>
              </div>
              <div className={`progress-track relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-secondary ${hasProgress ? "" : "indeterminate"}`}>
                <div
                  className="progress-fill h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <ChunkMap coverage={progress.coverage} searching={!hasProgress} />
            </div>

            <div className="flex items-center justify-center gap-2 text-[10px] font-semibold text-muted-foreground">
              <button
                type="button"
                onClick={() => void toggleQuality()}
                disabled={flipping || stopping || starting}
                aria-label="Switch camera quality between HD and 4K"
                className="glass flex items-center gap-1 rounded-full px-2.5 py-1 transition-transform active:scale-95 disabled:opacity-60"
              >
                <Video className="h-3 w-3 text-primary" />
                <span className="rounded bg-primary/15 px-1 text-[9px] font-extrabold text-primary">{camQuality === "4k" ? "4K" : "HD"}</span>
                {camInfo ? `${camInfo.w}×${camInfo.h}` : ""} · {stats.cam} fps
              </button>
              <span className="glass flex items-center gap-1 rounded-full px-2.5 py-1">
                <Activity className="h-3 w-3 text-primary" /> {stats.rx} new codes/s
              </span>
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
                onClick={() => void stop(true)}
                disabled={stopping}
                className="relative flex h-12 min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-accent px-4 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/30 transition-transform active:scale-95 disabled:opacity-80"
              >
                {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <CameraOff className="h-4 w-4" />}
                {stopping ? "Stopping" : "Stop"}
              </button>
              <button
                onClick={toggleAutoAssist}
                disabled={stopping || starting}
                aria-pressed={autoAssist}
                aria-label="Auto focus"
                className={`relative flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-2xl px-3.5 text-xs font-bold transition-all active:scale-90 disabled:opacity-60 ${
                  autoAssist ? "bg-foreground text-background shadow-lg" : "glass text-muted-foreground"
                }`}
              >
                <Focus className="h-5 w-5" strokeWidth={2.2} />
                <span className="whitespace-nowrap">Auto focus</span>
              </button>
            </div>
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

          {done.report && (
            <div className="grid grid-cols-3 gap-2">
              <div className="glass min-w-0 rounded-2xl px-3 py-2">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <Timer className="h-3 w-3 text-primary" /> Time
                </span>
                <span className="block truncate text-sm font-extrabold tabular-nums">
                  {done.report.seconds < 60 ? `${done.report.seconds.toFixed(1)}s` : `${Math.floor(done.report.seconds / 60)}m ${Math.round(done.report.seconds % 60)}s`}
                </span>
              </div>
              <div className="glass min-w-0 rounded-2xl px-3 py-2">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <Activity className="h-3 w-3 text-primary" /> Sustained
                </span>
                <span className="block truncate text-sm font-extrabold tabular-nums">{formatBytes(Math.round(done.report.sustained))}/s</span>
              </div>
              <div className="glass min-w-0 rounded-2xl px-3 py-2">
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <Zap className="h-3 w-3 text-primary" /> Peak
                </span>
                <span className="block truncate text-sm font-extrabold tabular-nums">{formatBytes(Math.round(done.report.peak))}/s</span>
              </div>
            </div>
          )}

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

/** Circular progress: spinning arc while searching, gradient arc with a glowing head once receiving. */
const ProgressRing = memo(function ProgressRing({
  value,
  active,
  phase,
}: {
  value: number;
  active: boolean;
  phase: "searching" | "locked" | "receiving";
}) {
  const size = 56;
  const r = 23;
  const c = 2 * Math.PI * r;
  const frac = active ? Math.min(1, value / 100) : 0;
  const angle = frac * 2 * Math.PI - Math.PI / 2;
  const hx = 28 + r * Math.cos(angle);
  const hy = 28 + r * Math.sin(angle);
  return (
    <div className={`progress-ring relative grid shrink-0 place-items-center ${phase}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 56 56" className="-rotate-90" style={{ width: size, height: size }}>
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" />
            <stop offset="100%" stopColor="var(--color-accent)" />
          </linearGradient>
        </defs>
        <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="5" />
        {phase === "searching" ? (
          <circle
            cx="28"
            cy="28"
            r={r}
            fill="none"
            stroke="url(#ring-grad)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${c * 0.22} ${c}`}
            className="ring-search"
          />
        ) : (
          frac > 0 && (
            <circle
              cx="28"
              cy="28"
              r={r}
              fill="none"
              stroke="url(#ring-grad)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - frac)}
              style={{ transition: "stroke-dashoffset 0.35s cubic-bezier(0.22,1,0.36,1)" }}
            />
          )
        )}
      </svg>
      {active && frac > 0.01 && frac < 0.999 && (
        <svg viewBox="0 0 56 56" className="pointer-events-none absolute inset-0" style={{ width: size, height: size }}>
          <circle cx={hx} cy={hy} r="3" fill="white" />
        </svg>
      )}
      <span className="absolute grid place-items-center text-[12px] font-extrabold tabular-nums">
        {phase === "searching" ? (
          <ScanLine className="animate-scan-bob h-5 w-5 text-primary" strokeWidth={2.4} />
        ) : active ? (
          value >= 100 ? 100 : Math.floor(value)
        ) : (
          "✓"
        )}
      </span>
    </div>
  );
});

/** Row of cells, one per slice of the file; each lights up as that slice arrives. */
const ChunkMap = memo(function ChunkMap({ coverage, searching }: { coverage: number[]; searching: boolean }) {
  const cells = coverage.length ? coverage : new Array(48).fill(0);
  return (
    <div className="mt-1.5 flex h-2.5 gap-[2px]" aria-hidden="true">
      {cells.map((v, i) => (
        <span
          key={i}
          className={`h-full min-w-0 flex-1 rounded-[3px] transition-[opacity,background-color] duration-300 ${
            v > 0 ? "bg-primary" : "bg-secondary"
          } ${searching ? "chunk-wave" : ""}`}
          style={{
            opacity: v > 0 ? 0.45 + 0.55 * v : 1,
            animationDelay: searching ? `${(i % 12) * 90}ms` : undefined,
          }}
        />
      ))}
    </div>
  );
});

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
