import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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

interface Transfer {
  header: ParsedHeader;
  decoder: FountainDecoder;
  startedAt: number;
}

type ProgressState = { have: number; total: number; frac: number; eta: number | null; rate: number };
const EMPTY_PROGRESS: ProgressState = { have: 0, total: 0, frac: 0, eta: null, rate: 0 };

// Minimal typing for the (Chromium/Safari) native QR detector.
type NativeDetection = { rawValue: string; cornerPoints?: Array<{ x: number; y: number }> };
type NativeDetector = { detect: (source: CanvasImageSource) => Promise<NativeDetection[]> };

function formatEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 1) return "";
  const whole = Math.ceil(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return mins ? `${mins}m ${secs.toString().padStart(2, "0")}s left` : `${secs}s left`;
}

type Point = { x: number; y: number };
type QrBox = {
  w: number;
  h: number;
  corners: [Point, Point, Point, Point];
  sourceCorners: [Point, Point, Point, Point];
};
type ScanResult = { data: string; corners: [Point, Point, Point, Point] };
type ViewTransform = { scale: number; x: number; y: number };
type SourceRect = { x: number; y: number; width: number; height: number };
type FocusPoint = { x: number; y: number };
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
  visible?: boolean;
};

const CAMERA_TRANSITION_MS = 180;
const DECODE_INTERVAL_MS = 30; // jsQR fallback pacing (native detector runs flat out)
const DECODE_MAX_EDGE = 880; // jsQR fallback resolution
const NATIVE_MAX_EDGE = 1280; // native detector copes with more pixels, so dense codes read better
const PROGRESS_COMMIT_MS = 150;
const SCAN_SOUND_MS = 220;
type FocusMode = "single-shot" | "continuous" | "manual";
type CameraSettingRange = { min: number; max: number; step?: number };
type CameraControlCapabilities = MediaTrackCapabilities & {
  focusMode?: FocusMode[];
  zoom?: CameraSettingRange;
};
type CameraControlTrack = MediaStreamTrack & {
  getCapabilities?: () => CameraControlCapabilities;
};
type ZoomRange = { min: number; max: number; supported: boolean };
type PanPoint = { x: number; y: number };

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function vibrate(pattern: number | number[]) {
  try {
    if ("vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* ignore unavailable haptics */
  }
}

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

async function openCameraStream(facingMode: "environment" | "user") {
  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        facingMode: { exact: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 960 },
        height: { ideal: 540 },
        frameRate: { ideal: 24, max: 30 },
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

async function applyCameraFocus(stream: MediaStream | null, modes: FocusMode[] = ["single-shot", "continuous"], point?: FocusPoint) {
  const track = stream?.getVideoTracks()[0] as CameraControlTrack | undefined;
  if (!track || track.readyState !== "live") return false;
  const capabilities = track.getCapabilities?.() as CameraControlCapabilities | undefined;
  const availableModes = capabilities?.focusMode ?? [];
  const candidates = availableModes.length ? modes.filter((mode) => availableModes.includes(mode)) : modes;
  for (const mode of candidates) {
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
      /* Try the next browser-supported focus mode. */
    }
  }
  return false;
}

function readZoomRange(stream: MediaStream | null): ZoomRange {
  const track = stream?.getVideoTracks()[0] as CameraControlTrack | undefined;
  const zoom = (track?.getCapabilities?.() as CameraControlCapabilities | undefined)?.zoom;
  if (!track || !zoom || !Number.isFinite(zoom.min) || !Number.isFinite(zoom.max) || zoom.max <= zoom.min) {
    return { min: 1, max: 3, supported: false };
  }
  return {
    min: zoom.min,
    max: Math.min(zoom.max, Math.max(zoom.min + 0.5, 4.5)),
    supported: true,
  };
}

async function applyCameraZoom(stream: MediaStream | null, value: number) {
  const track = stream?.getVideoTracks()[0] as CameraControlTrack | undefined;
  if (!track || track.readyState !== "live") return false;
  const range = readZoomRange(stream);
  if (!range.supported) return false;
  const zoom = clamp(value, range.min, range.max);
  try {
    await track.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

function decodeQr(ctx: CanvasRenderingContext2D, w: number, h: number, deep = false): ScanResult | null {
  const side = Math.min(w, h);
  const center: [number, number, number, number] = [Math.round((w - side) / 2), Math.round((h - side) / 2), side, side];
  const attempts: Array<[number, number, number, number, boolean]> = [[...center, false]];
  if (deep && (side !== w || side !== h)) attempts.push([0, 0, w, h, false]);
  if (deep) attempts.push([...center, true]);

  for (const [sx, sy, sw, sh, attemptInvert] of attempts) {
    const img = ctx.getImageData(sx, sy, sw, sh);
    const code = jsQR(img.data, sw, sh, {
      inversionAttempts: attemptInvert ? "attemptBoth" : "dontInvert",
    });
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

function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  transform: ViewTransform,
) {
  const source = getVideoSourceRect(video, transform);
  ctx.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, w, h);
}

function getVideoSourceRect(video: HTMLVideoElement, transform: ViewTransform): SourceRect {
  const sourceW = video.videoWidth;
  const sourceH = video.videoHeight;
  const rect = video.getBoundingClientRect();
  const scale = Math.max(rect.width / sourceW, rect.height / sourceH);
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0, y: 0, width: sourceW, height: sourceH };
  const cropW = (rect.width / scale) / transform.scale;
  const cropH = (rect.height / scale) / transform.scale;
  return {
    x: clamp(sourceW / 2 - cropW / 2 - transform.x / (scale * transform.scale), 0, sourceW - cropW),
    y: clamp(sourceH / 2 - cropH / 2 - transform.y / (scale * transform.scale), 0, sourceH - cropH),
    width: cropW,
    height: cropH,
  };
}

function getDecodeSize(video: HTMLVideoElement, maxEdge: number) {
  const rect = video.getBoundingClientRect();
  const aspect =
    rect.width && rect.height
      ? rect.width / rect.height
      : video.videoWidth / Math.max(1, video.videoHeight);
  return aspect >= 1
    ? { width: maxEdge, height: Math.max(1, Math.round(maxEdge / aspect)) }
    : { width: Math.max(1, Math.round(maxEdge * aspect)), height: maxEdge };
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

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => GenericTransformStream }).DecompressionStream;
  if (!DS) throw new Error("This browser can't unpack compressed transfers. Update the browser or use Chrome/Safari.");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function AnimatedPercent({ value }: { value: number }) {
  return (
    <div className="mt-3 text-center text-5xl font-medium leading-none tabular-nums text-foreground sm:text-6xl">
      {value >= 100 ? 100 : Math.floor(value)}%
    </div>
  );
}

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
  const rafRef = useRef<number>(0);
  const vfcRef = useRef<number>(0);
  const workerRef = useRef<Worker | null | undefined>(undefined);
  const workerPending = useRef(new Map<number, (r: ScanResult | null) => void>());
  const workerSeq = useRef(0);
  const [fastDecoder, setFastDecoder] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraOperationRef = useRef(0);
  const transferRef = useRef<Transfer | null>(null);
  const detectorRef = useRef<NativeDetector | null | undefined>(undefined);
  const decodeBusyRef = useRef(false);
  const lastPayloadRef = useRef("");
  const lastScanSoundRef = useRef(0);
  const lastDecodeRef = useRef(0);
  const finishingRef = useRef(false);
  const scanningRef = useRef(false);
  const boxVisibleRef = useRef(false);
  const lastBoxUpdateRef = useRef(0);
  const frameErrorCountRef = useRef(0);
  const decodeFrameRef = useRef(0);
  const stopRef = useRef<(showStopping?: boolean, reason?: "manual" | "internal") => Promise<void>>(
    async () => {},
  );
  const facingRef = useRef<"environment" | "user">("environment");
  const doneUrlRef = useRef<string | null>(null);
  const progressCommitRef = useRef(0);
  const lastAutoFrameRef = useRef(0);
  const lastFocusPointRef = useRef(0);
  const zoomRef = useRef(1);
  const zoomRangeRef = useRef<ZoomRange>({ min: 1, max: 3, supported: false });
  const panRefState = useRef<PanPoint>({ x: 0, y: 0 });

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [scanInfo, setScanInfo] = useState<{ name: string; mime: string; size: number } | null>(
    null,
  );
  const [qrBox, setQrBox] = useState<QrBox | null>(null);
  const [done, setDone] = useState<DonePreview | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [flipping, setFlipping] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PanPoint>({ x: 0, y: 0 });

  async function start(facingMode: "environment" | "user" = facingRef.current, force = false) {
    if (!force && (active || starting || stopping)) return;
    const operation = ++cameraOperationRef.current;
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
    lastAutoFrameRef.current = 0;
    lastFocusPointRef.current = 0;
    finishingRef.current = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera permission is unavailable in this browser.");
      }
      setFastDecoder(Boolean(getDetector()));
      const stream = await openCameraStream(facingMode);
      if (operation !== cameraOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const range = readZoomRange(stream);
      zoomRangeRef.current = range;
      zoomRef.current = range.min;
      setZoom(range.min);
      panRefState.current = { x: 0, y: 0 };
      setPan({ x: 0, y: 0 });
      if (videoRef.current) {
        const video = videoRef.current;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("playsinline", "true");
        video.srcObject = stream;
        await waitForVideoMetadata(video);
        if (operation !== cameraOperationRef.current) return;
        await video.play();
        if (operation !== cameraOperationRef.current) return;
        await waitForUsableVideo(video);
        if (operation !== cameraOperationRef.current) return;
      }
      void applyCameraFocus(stream, ["continuous"]);
      if (range.supported) void applyCameraZoom(stream, range.min);
      const remaining = CAMERA_TRANSITION_MS - (performance.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
      if (operation !== cameraOperationRef.current) return;
      scanningRef.current = true;
      setActive(true);
      setStarting(false);
      cancelTick();
      tick();
    } catch (e) {
      if (operation !== cameraOperationRef.current) return;
      setStarting(false);
      setStopping(false);
      setActive(false);
      setError(
        e instanceof Error ? e.message : "Camera unavailable. Grant camera permission and retry.",
      );
    }
  }

  async function stop(showStopping = false) {
    cameraOperationRef.current += 1;
    const shouldShowStopping = showStopping && (active || starting || Boolean(streamRef.current));
    if (shouldShowStopping) {
      setStopping(true);
      setStarting(false);
      await new Promise((resolve) => setTimeout(resolve, CAMERA_TRANSITION_MS));
    }
    scanningRef.current = false;
    finishingRef.current = false;
    transferRef.current = null;
    lastPayloadRef.current = "";
    setActive(false);
    setStarting(false);
    setQrBox(null);
    setScanInfo(null);
    setProgress(EMPTY_PROGRESS);
    setFlipping(false);
    zoomRef.current = zoomRangeRef.current.min;
    panRefState.current = { x: 0, y: 0 };
    setPan({ x: 0, y: 0 });
    boxVisibleRef.current = false;
    cancelTick();
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
    if (!active || stopping || starting || flipping) return;
    const operation = ++cameraOperationRef.current;
    const next = facingRef.current === "environment" ? "user" : "environment";
    setFlipping(true);
    vibrate(12);
    try {
      const video = videoRef.current;
      scanningRef.current = false;
      cancelTick();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await openCameraStream(next);
      if (operation !== cameraOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      facingRef.current = next;
      setFacing(next);
      const range = readZoomRange(stream);
      zoomRangeRef.current = range;
      zoomRef.current = range.min;
      setZoom(range.min);
      panRefState.current = { x: 0, y: 0 };
      setPan({ x: 0, y: 0 });
      if (video) {
        video.srcObject = stream;
        await waitForVideoMetadata(video);
        if (operation !== cameraOperationRef.current) return;
        await video.play();
        if (operation !== cameraOperationRef.current) return;
        await waitForUsableVideo(video);
        if (operation !== cameraOperationRef.current) return;
      }
      void applyCameraFocus(stream, ["continuous"]);
      if (range.supported) void applyCameraZoom(stream, range.min);
      scanningRef.current = true;
      lastDecodeRef.current = 0;
      tick();
    } catch (e) {
      if (operation === cameraOperationRef.current) {
        setError(e instanceof Error ? e.message : "Camera could not flip. Try again.");
      }
    } finally {
      await sleep(160);
      setFlipping(false);
    }
  }

  function autoFrameQr(box: QrBox, now: number) {
    if (now - lastAutoFrameRef.current < 110 || flipping) return;
    const video = videoRef.current;
    const rect = video?.getBoundingClientRect();
    if (!video || !rect || !video.videoWidth || !video.videoHeight) return;
    const sourceRect = getVideoSourceRect(video, { scale: zoomRef.current, ...panRefState.current });
    const scaleX = rect.width / sourceRect.width;
    const scaleY = rect.height / sourceRect.height;
    const xs = box.sourceCorners.map(
      (p) =>
        rect.left +
        rect.width / 2 +
        (p.x - sourceRect.x - sourceRect.width / 2) * scaleX,
    );
    const ys = box.sourceCorners.map(
      (p) =>
        rect.top +
        rect.height / 2 +
        (p.y - sourceRect.y - sourceRect.height / 2) * scaleY,
    );
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const qrW = Math.max(1, maxX - minX);
    const qrH = Math.max(1, maxY - minY);
    const frameSide = Math.min(rect.width, rect.height);
    const currentFill = Math.max(qrW, qrH) / frameSide;
    const targetFill = 0.62;
    const currentZoom = zoomRef.current;
    const next = clamp(
      currentZoom * clamp(targetFill / currentFill, 0.9, 1.12),
      zoomRangeRef.current.min,
      zoomRangeRef.current.max,
    );
    lastAutoFrameRef.current = now;
    if (now - lastFocusPointRef.current > 650) {
      lastFocusPointRef.current = now;
      const sourceCenterX =
        box.sourceCorners.reduce((sum, point) => sum + point.x, 0) / box.sourceCorners.length;
      const sourceCenterY =
        box.sourceCorners.reduce((sum, point) => sum + point.y, 0) / box.sourceCorners.length;
      void applyCameraFocus(streamRef.current, ["continuous", "single-shot"], {
        x: sourceCenterX / video.videoWidth,
        y: sourceCenterY / video.videoHeight,
      });
    }
    const centerX = (minX + maxX) / 2 - rect.left - rect.width / 2;
    const centerY = (minY + maxY) / 2 - rect.top - rect.height / 2;
    const targetPanX = -((centerX - panRefState.current.x) / currentZoom) * next;
    const targetPanY = -((centerY - panRefState.current.y) / currentZoom) * next;
    const nextPan = {
      x: clamp(
        panRefState.current.x + (targetPanX - panRefState.current.x) * 0.45,
        -(rect.width * (next - 1)) / 2,
        (rect.width * (next - 1)) / 2,
      ),
      y: clamp(
        panRefState.current.y + (targetPanY - panRefState.current.y) * 0.45,
        -(rect.height * (next - 1)) / 2,
        (rect.height * (next - 1)) / 2,
      ),
    };
    const zoomChanged = Math.abs(next - currentZoom) > 0.001;
    const panChanged =
      Math.abs(nextPan.x - panRefState.current.x) > 0.5 ||
      Math.abs(nextPan.y - panRefState.current.y) > 0.5;
    zoomRef.current = next;
    panRefState.current = nextPan;
    if (zoomChanged) setZoom(next);
    if (panChanged) setPan(nextPan);
  }

  function recoverCameraFrame(now: number) {
    if (now - lastAutoFrameRef.current < 180) return;
    const minZoom = zoomRangeRef.current.min;
    const nextZoom = Math.max(minZoom, minZoom + (zoomRef.current - minZoom) * 0.75);
    const nextPan = { x: panRefState.current.x * 0.75, y: panRefState.current.y * 0.75 };
    if (
      Math.abs(nextZoom - zoomRef.current) < 0.01 &&
      Math.abs(nextPan.x) < 1 &&
      Math.abs(nextPan.y) < 1
    ) {
      return;
    }
    lastAutoFrameRef.current = now;
    zoomRef.current = nextZoom;
    panRefState.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }

  function clearDonePreview() {
    if (doneUrlRef.current) {
      URL.revokeObjectURL(doneUrlRef.current);
      doneUrlRef.current = null;
    }
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
      } else {
        void downloadDone();
        return;
      }
      onCompleteAction?.();
    } catch {
      /* user cancelled */
    }
  }

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
  function decodeAsync(ctx: CanvasRenderingContext2D, w: number, h: number, deep: boolean): Promise<ScanResult | null> {
    if (workerRef.current === undefined) {
      try {
        const worker = new Worker(new URL("../lib/qr-decode.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ id: number; result: ScanResult | null }>) => {
          const resolve = workerPending.current.get(event.data.id);
          workerPending.current.delete(event.data.id);
          resolve?.(event.data.result);
        };
        worker.onerror = () => {
          workerRef.current = null;
          for (const resolve of workerPending.current.values()) resolve(null);
          workerPending.current.clear();
        };
        workerRef.current = worker;
      } catch {
        workerRef.current = null;
      }
    }
    const worker = workerRef.current;
    if (!worker) return Promise.resolve(decodeQr(ctx, w, h, deep));
    const img = ctx.getImageData(0, 0, w, h);
    const id = ++workerSeq.current;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        workerPending.current.delete(id);
        resolve(null);
      }, 1500);
      workerPending.current.set(id, (r) => {
        window.clearTimeout(timer);
        resolve(r);
      });
      worker.postMessage({ id, data: img.data.buffer, w, h, deep }, [img.data.buffer]);
    });
  }

  /** Run the next decode exactly when the camera delivers a new frame (not on a blind 60 Hz timer). */
  function scheduleTick() {
    const video = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }) | null;
    if (video?.requestVideoFrameCallback) {
      vfcRef.current = video.requestVideoFrameCallback(() => tick());
    } else {
      rafRef.current = requestAnimationFrame(tick);
    }
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
      let corners: ScanResult["corners"] | null = null;
      let sourceCorners: ScanResult["corners"] | null = null;
      let w = video.videoWidth;
      let h = video.videoHeight;
      const frameTransform = { scale: zoomRef.current, ...panRefState.current };
      const sourceRect = getVideoSourceRect(video, frameTransform);

      if (detector) {
        try {
          // Unzoomed: hand the <video> straight to the hardware detector (no canvas copy at all).
          let source: CanvasImageSource = video;
          if (zoomRef.current > 1.01) {
            const size = getDecodeSize(video, NATIVE_MAX_EDGE);
            w = size.width;
            h = size.height;
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            drawVideoFrame(ctx, video, w, h, frameTransform);
            source = canvas;
          }
          const found = await detector.detect(source);
          if (!scanningRef.current) return;
          let accepted = false;
          // A screen can show more than one QR; take every one of ours, mark the first.
          for (const item of found) {
            if (!item.rawValue || !handleScan(item.rawValue)) continue;
            if (!accepted) {
              const pts = item.cornerPoints;
              if (pts && pts.length >= 4) {
                corners = [pts[0], pts[1], pts[2], pts[3]].map((p) => ({
                  x: p.x,
                  y: p.y,
                })) as ScanResult["corners"];
                sourceCorners =
                  zoomRef.current > 1.01
                    ? (corners.map((p) => ({
                        x: sourceRect.x + (p.x / w) * sourceRect.width,
                        y: sourceRect.y + (p.y / h) * sourceRect.height,
                      })) as ScanResult["corners"])
                    : (corners.map((p) => ({
                        x: (p.x / w) * video.videoWidth,
                        y: (p.y / h) * video.videoHeight,
                      })) as ScanResult["corners"]);
              }
              accepted = true;
            }
          }
        } catch (err) {
          // Detector unusable on this device — fall back to jsQR permanently.
          console.warn("Native QR detector failed, falling back to jsQR:", err);
          detectorRef.current = null;
          setFastDecoder(false);
        }
      } else {
        const size = getDecodeSize(video, DECODE_MAX_EDGE);
        w = size.width;
        h = size.height;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        drawVideoFrame(ctx, video, w, h, frameTransform);
        const deepScan = !boxVisibleRef.current ? decodeFrameRef.current % 3 === 0 : decodeFrameRef.current % 14 === 0;
        const code = await decodeAsync(ctx, w, h, deepScan);
        if (!scanningRef.current) return;
        if (code?.data && handleScan(code.data)) {
          corners = code.corners;
          sourceCorners = corners.map((p) => ({
            x: sourceRect.x + (p.x / w) * sourceRect.width,
            y: sourceRect.y + (p.y / h) * sourceRect.height,
          })) as ScanResult["corners"];
        }
      }
      frameErrorCountRef.current = 0;

      if (corners) {
        const box: QrBox = { w, h, corners, sourceCorners: sourceCorners ?? corners };
        if (now - lastBoxUpdateRef.current > 60) {
          boxVisibleRef.current = true;
          lastBoxUpdateRef.current = now;
          setQrBox(box);
          autoFrameQr(box, now);
        }
      } else if (boxVisibleRef.current && now - lastBoxUpdateRef.current > 180) {
        boxVisibleRef.current = false;
        lastBoxUpdateRef.current = now;
        setQrBox(null);
      }
      if (!corners) recoverCameraFrame(now);
    } catch (err) {
      frameErrorCountRef.current += 1;
      console.error("Scan frame error:", err);
      if (frameErrorCountRef.current === 6) {
        setError(
          "Camera scanning hit repeated frame errors. Keep the camera steady and retry if it continues.",
        );
      }
    }
  }

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
    // The same frame stays on screen for several camera frames; ignore repeats cheaply.
    if (payload === lastPayloadRef.current) return true;
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
        sfx.fileFound();
        setScanInfo({ name: parsed.name, mime: parsed.mime, size: parsed.origSize });
        updateProgress(t, true);
      }
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
        // Should be vanishingly rare (QR frames carry their own error correction),
        // but never hand over a corrupt file: drop it and start over cleanly.
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

      const meta = {
        id: t.header.id.toString(16).padStart(8, "0") + "-" + Date.now(),
        filename: t.header.name,
        mime: t.header.mime,
        size: t.header.origSize,
        receivedAt: Date.now(),
        direction: "received" as const,
        durationMs: Date.now() - t.startedAt,
        valid,
      };
      // History is best-effort: a full disk must never cost the user the file they just received.
      try {
        await saveItem({ ...meta, blob });
      } catch (err) {
        console.warn("Could not save to history:", err);
      }

      const previewUrl = URL.createObjectURL(blob);
      doneUrlRef.current = previewUrl;
      const aspectRatio = await detectAspectRatio(blob, mime, previewUrl);
      setCelebrate((n) => n + 1);
      setDone({
        name: t.header.name,
        mime,
        size: t.header.origSize,
        blob,
        url: previewUrl,
        aspectRatio,
      });
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

  useEffect(() => {
    onBusyChange?.(active || starting || stopping);
  }, [active, starting, stopping, onBusyChange]);

  useEffect(() => {
    if (stopRequestKey > 0) {
      void stopRef.current(true).then(() => onStopRequestComplete?.());
    }
  }, [stopRequestKey, onStopRequestComplete]);

  useEffect(() => {
    if (!visible) clearDonePreview();
  }, [visible]);

  useEffect(
    () => () => {
      void stopRef.current();
      workerRef.current?.terminate();
      workerRef.current = undefined;
      if (doneUrlRef.current) URL.revokeObjectURL(doneUrlRef.current);
    },
    [],
  );

  const pct = progress.total ? Math.min(100, progress.frac * 100) : 0;
  const label = mediaLabel(scanInfo?.mime);
  const live = active || starting;
  const hasProgress = progress.total > 0;
  const speedLabel = progress.rate > 0 ? `${formatBytes(Math.round(progress.rate))}/s` : null;
  const etaLabel = formatEta(progress.eta);

  const errorBanner = error ? (
    <div
      role="alert"
      className="glass animate-pop-in pointer-events-auto rounded-2xl border border-destructive/40 p-3 text-xs font-medium text-destructive"
    >
      {error}
    </div>
  ) : null;

  const stageClass = done
    ? "hidden"
    : live
      ? // Phones: the camera owns the whole screen. Tablet/desktop: a framed 16:9 stage.
        "absolute inset-0 z-20 bg-black md:relative md:inset-auto md:z-auto md:aspect-video md:w-full md:max-w-[min(56rem,calc((100dvh-14rem)*16/9))] md:flex-none md:rounded-[2rem] md:shadow-2xl md:shadow-black/30"
      : "relative mx-3 mt-2 flex-1 rounded-[1.5rem] md:mx-auto md:w-full md:max-w-2xl md:flex-none md:aspect-[5/4]";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col md:items-center md:justify-center md:px-8">
      <MediaViewer item={viewer} onClose={() => setViewer(null)} />

      {/* ===================== STAGE: idle hero + live camera ===================== */}
      <div
        className={`glass-strong ${stageClass} overflow-hidden transition-[border-radius,box-shadow] duration-500`}
        data-no-swipe
        style={{ touchAction: "none" }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            display: live ? "block" : "none",
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            transition: flipping ? "opacity 0.16s ease, transform 0.16s ease" : "transform 0.12s ease-out",
          }}
        />
        <canvas ref={canvasRef} className="hidden" />

        {/* ---- idle hero ---- */}
        {!live && (
          <div className="relative flex h-full min-h-[min(25rem,calc(100dvh-13rem))] flex-col items-center justify-center gap-6 px-5 py-5 text-center sm:min-h-[22rem] sm:gap-8 sm:px-7 sm:py-8">
            <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden="true" />
            <div className="hero-stage relative grid place-items-center">
              <span className="absolute h-28 w-28 rounded-full bg-primary/20 animate-pulse-ring sm:h-36 sm:w-36" />
              <div className="hero-cube relative grid h-20 w-20 place-items-center rounded-[1.6rem] bg-gradient-to-br from-primary to-accent shadow-xl shadow-primary/30 sm:h-24 sm:w-24">
                <ScanLine className="h-9 w-9 text-primary-foreground sm:h-10 sm:w-10" strokeWidth={2} />
              </div>
            </div>
            <div className="relative w-full">
              <h2 className="text-display text-2xl sm:text-3xl">Receive a file</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Start your camera, then point it at the animated QR on the sender's screen. OFFDROP keeps the code
                centered for you.
              </p>
              <ul className="mx-auto mt-4 flex max-w-md flex-wrap items-center justify-center gap-2 text-[10px] font-semibold text-muted-foreground sm:text-[11px]">
                <li className="glass rounded-full px-3 py-1.5">Private · no account</li>
                <li className="glass rounded-full px-3 py-1.5">Photos · videos · files</li>
                <li className="glass rounded-full px-3 py-1.5">Verified transfer</li>
              </ul>
            </div>
            <div className="relative flex w-full max-w-md flex-col items-center gap-3">
              {errorBanner && <div className="w-full max-w-sm">{errorBanner}</div>}
              <button
                onClick={() => {
                  sfx.unlock();
                  void start();
                }}
                disabled={starting || stopping}
                className="group relative flex min-h-14 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-accent py-4 text-base font-bold text-primary-foreground shadow-xl shadow-primary/25 transition-transform duration-200 active:scale-[0.98] disabled:opacity-80"
              >
                <span className="btn-sheen absolute inset-0" />
                <Camera className="relative h-5 w-5" />
                <span className="relative">Open camera</span>
              </button>
            </div>
          </div>
        )}

        {/* ---- starting spinner ---- */}
        {starting && !active && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/55 px-8 text-center text-white backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            <div className="grid h-16 w-16 place-items-center rounded-3xl bg-white/10">
              <Camera className="h-7 w-7 text-white/90" strokeWidth={2} />
            </div>
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <div>
              <p className="text-base font-bold">Opening camera for Receive…</p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-white/70">
                Your live view will fill the screen. Point it at the sender's QR code.
              </p>
            </div>
          </div>
        )}

        {/* ---- live camera overlays ---- */}
        {active && (
          <>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/55" />
            <div
              className={`scanner-corners-in pointer-events-none absolute inset-6 rounded-3xl transition-opacity duration-300 sm:inset-10 md:inset-8 ${
                qrBox ? "opacity-0" : "opacity-100"
              }`}
            >
              <span className="absolute left-0 top-0 h-12 w-12 rounded-tl-3xl border-l-[3px] border-t-[3px] border-white/90" />
              <span className="absolute right-0 top-0 h-12 w-12 rounded-tr-3xl border-r-[3px] border-t-[3px] border-white/90" />
              <span className="absolute bottom-0 left-0 h-12 w-12 rounded-bl-3xl border-b-[3px] border-l-[3px] border-white/90" />
              <span className="absolute bottom-0 right-0 h-12 w-12 rounded-br-3xl border-b-[3px] border-r-[3px] border-white/90" />
              <div className="absolute inset-0 overflow-hidden rounded-3xl">
                <div className="scan-sweep absolute left-0 right-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent" />
              </div>
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

            {/* HUD: status + progress */}
            <div className="pointer-events-none absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 mx-auto flex max-w-xl flex-col gap-2 md:top-4">
              <div className="hud-card animate-pop-in pointer-events-auto flex items-center gap-3 rounded-3xl px-3.5 py-2.5 text-white">
                <ProgressRing value={pct} active={hasProgress} locked={Boolean(qrBox)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold leading-tight">
                    {hasProgress
                      ? (scanInfo?.name ?? `Receiving ${label}`)
                      : qrBox
                        ? "Centering QR code…"
                        : "Looking for an OFFDROP code…"}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-white/70">
                    {hasProgress
                      ? [scanInfo ? formatBytes(scanInfo.size) : null, speedLabel, etaLabel].filter(Boolean).join(" · ")
                      : "Fill the frame with the sender's screen"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                    {fastDecoder ? "Hardware decode" : "Software decode"}
                  </span>
                  {hasProgress && (
                    <span className="text-[10px] font-semibold tabular-nums text-white/70">
                      {progress.have}/{progress.total}
                    </span>
                  )}
                </div>
              </div>
              {hasProgress && (
                <div className="mx-2 h-1.5 overflow-hidden rounded-full bg-white/20">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary to-accent shadow-[0_0_14px_var(--color-primary)] transition-[width] duration-300 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              {errorBanner}
            </div>

            {flipping && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/25 backdrop-blur-sm">
                <div className="glass grid h-16 w-16 place-items-center rounded-2xl">
                  <SwitchCamera className="h-7 w-7 animate-pulse text-primary" strokeWidth={2.4} />
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6 md:pb-5">
              <button
                onClick={() => void flipCamera()}
                disabled={stopping || starting || flipping}
                aria-label={`Flip camera (current: ${facing === "environment" ? "back" : "front"})`}
                className="hud-card grid h-14 w-14 place-items-center rounded-full text-white transition-transform active:scale-90 disabled:opacity-60"
              >
                <SwitchCamera className={`h-5 w-5 ${facing === "user" ? "scale-x-[-1]" : ""}`} strokeWidth={2.2} />
              </button>
              <button
                onClick={() => void stop(true)}
                disabled={stopping}
                className="flex h-14 min-w-[10rem] items-center justify-center gap-2 rounded-full bg-white px-6 text-sm font-bold text-black shadow-xl transition-transform active:scale-95 disabled:opacity-80"
              >
                {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <CameraOff className="h-4 w-4" />}
                {stopping ? "Stopping" : "Stop"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ===================== RESULT ===================== */}
      {done && (
        <div className="animate-pop-in relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3 pt-1 md:max-w-3xl">
          <Confetti key={celebrate} />
          <button
            type="button"
            onClick={() => {
              if (done.url) setViewer({ url: done.url, name: done.name, mime: done.mime, size: done.size, blob: done.blob });
            }}
            aria-label={`Open ${done.name}`}
            className="group glass-strong relative min-h-[15rem] w-full flex-1 overflow-hidden rounded-[2rem] bg-black/80 text-left transition-transform duration-300 active:scale-[0.985]"
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
