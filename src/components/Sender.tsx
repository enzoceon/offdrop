import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Upload,
  Play,
  Pause,
  RotateCcw,
  X,
  Repeat2,
  Music2,
  FileText,
  HardDrive,
  Layers3,
  Clock,
  Loader2,
  AlertTriangle,
  Maximize2,
  Minimize2,
  Zap,
  Gauge,
  PackageOpen,
  Film,
  Files,
  Timer,
  Activity,
} from "lucide-react";
import {
  DENSITY_PRESETS,
  LONG_TRANSFER_BYTES,
  MAX_FILE_BYTES,
  cycleLength,
  formatBytes,
  presetFor,
  type DensityKey,
  type StreamPlan,
} from "@/lib/qr-protocol";
import { FramePipeline, PrepareCancelled, paintFrame, prepareFile, type PreparedFile } from "@/lib/sender-engine";
import { BundleCancelled, buildZip } from "@/lib/zip-bundle";
import { saveItem } from "@/lib/history";
import { sfx } from "@/lib/feedback";
import { useWakeLock } from "@/lib/wake-lock";
import { cn } from "@/lib/utils";
import { MediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { Portal } from "@/components/Portal";

type SpeedTier = "Gentle" | "Normal" | "Fast" | "Turbo" | "Ultra";
type Phase = "bundle" | "compress" | "hash";

const MIN_FPS = 1;
const MAX_FPS = 60;
const DEFAULT_FPS = 8;
const DENSITY_KEY = "offdrop:density";
const FPS_KEY = "offdrop:fps";
/** Largest file we also keep a copy of in local history. */
const HISTORY_BLOB_LIMIT = 64 * 1024 * 1024;

const TIER_RANGES: { tier: SpeedTier; min: number; max: number }[] = [
  { tier: "Gentle", min: 1, max: 3 },
  { tier: "Normal", min: 4, max: 8 },
  { tier: "Fast", min: 9, max: 15 },
  { tier: "Turbo", min: 16, max: 30 },
  { tier: "Ultra", min: 31, max: 60 },
];

function tierForFps(fps: number): SpeedTier {
  return TIER_RANGES.find((t) => fps >= t.min && fps <= t.max)?.tier ?? "Normal";
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const whole = Math.ceil(seconds);
  const hours = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours) return `${hours}h ${mins.toString().padStart(2, "0")}m`;
  return mins ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;
}

function readDensity(): DensityKey {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === "reliable" || v === "balanced" || v === "dense" || v === "max") return v;
  } catch {
    /* ignore */
  }
  return "dense";
}

function readFps(): number {
  try {
    const v = Number(localStorage.getItem(FPS_KEY));
    if (Number.isFinite(v) && v >= MIN_FPS && v <= MAX_FPS) return Math.round(v);
  } catch {
    /* ignore */
  }
  return DEFAULT_FPS;
}

const PHASE_LABEL: Record<Phase, string> = {
  bundle: "Bundling files",
  compress: "Compressing",
  hash: "Preparing",
};

export function Sender({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [bundleCount, setBundleCount] = useState(0);
  const [plan, setPlan] = useState<StreamPlan | null>(null);
  const [busy, setBusy] = useState<{ f: number; phase: Phase } | null>(null);
  const [savedBytes, setSavedBytes] = useState(0);
  const [seq, setSeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [loop, setLoop] = useState(true);
  const [density, setDensity] = useState<DensityKey>("dense");
  const [preview, setPreview] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrReady, setQrReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lanes, setLanes] = useState<1 | 2>(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fullRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const tiltRef = useRef<HTMLDivElement>(null);
  const pipelineRef = useRef<FramePipeline | null>(null);
  const preparedRef = useRef<PreparedFile | null>(null);
  const seqRef = useRef(0);
  const paintedRef = useRef(-1);
  const pickTokenRef = useRef(0);
  const previewUrlRef = useRef<string | null>(null);

  const preset = presetFor(density);
  const totalData = plan?.total ?? 0;
  const passLength = plan ? cycleLength(plan.total) : 0;

  useWakeLock(playing);
  useEffect(() => {
    setDensity(readDensity());
    setFps(readFps());
  }, []);

  function disposePipeline() {
    pipelineRef.current?.dispose();
    pipelineRef.current = null;
  }

  function setPreviewUrl(url: string | null) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreview(url);
  }

  function installPipeline(prepared: { plan: StreamPlan; blob: Blob }, ec: "L" | "M") {
    disposePipeline();
    const pipeline = new FramePipeline(prepared.plan, prepared.blob, ec);
    pipeline.onChange = () => {
      if (pipeline.error) {
        setQrError("A QR frame could not be generated. Remove the file and try again.");
        setPlaying(false);
      }
    };
    pipelineRef.current = pipeline;
    pipeline.reset(0);
    seqRef.current = 0;
    paintedRef.current = -1;
    setSeq(0);
    setPlan(prepared.plan);
  }

  function resetForNewPick() {
    disposePipeline();
    preparedRef.current = null;
    setPlan(null);
    setSeq(0);
    seqRef.current = 0;
    paintedRef.current = -1;
    setPlaying(false);
    setQrError(null);
    setQrReady(false);
    setExpanded(false);
    setViewer(null);
    setSavedBytes(0);
  }

  /** One file, or many (bundled into a single zip first). */
  async function onPickMany(list: File[]) {
    if (list.length === 0) return;
    if (list.length === 1) return void onPick(list[0], 0);
    const token = ++pickTokenRef.current;
    resetForNewPick();
    setFile(null);
    setBundleCount(list.length);
    try {
      setBusy({ f: 0, phase: "bundle" });
      const zip = await buildZip(list, {
        isCancelled: () => token !== pickTokenRef.current,
        onProgress: (f) => {
          if (token === pickTokenRef.current) setBusy({ f, phase: "bundle" });
        },
      });
      if (token !== pickTokenRef.current) return;
      await onPick(zip, list.length, token);
    } catch (error) {
      if (error instanceof BundleCancelled || token !== pickTokenRef.current) return;
      setBusy(null);
      setBundleCount(0);
      setQrError(error instanceof Error ? error.message : "These files could not be bundled.");
      sfx.error();
    }
  }

  async function onPick(f: File, bundled = 0, existingToken?: number) {
    const token = existingToken ?? ++pickTokenRef.current;
    resetForNewPick();
    setFile(f);
    setBundleCount(bundled);
    setPreviewUrl(URL.createObjectURL(f));

    if (f.size === 0) {
      setBusy(null);
      setQrError("This file is empty, so there is nothing to send.");
      sfx.error();
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setBusy(null);
      setQrError("Files over 4 GB are not supported.");
      sfx.error();
      return;
    }

    try {
      setBusy({ f: 0, phase: "hash" });
      const prepared = await prepareFile(f, {
        chunk: preset.chunk,
        isCancelled: () => token !== pickTokenRef.current,
        onProgress: (fraction, phase) => {
          if (token === pickTokenRef.current) setBusy({ f: fraction, phase });
        },
      });
      if (token !== pickTokenRef.current) return;
      preparedRef.current = prepared;
      setSavedBytes(prepared.savedBytes);
      installPipeline(prepared, preset.ec);
      setBusy(null);
      sfx.fileFound();
      void saveItem({
        id: prepared.plan.idHex + "-sent-" + Date.now(),
        filename: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
        receivedAt: Date.now(),
        direction: "sent",
        valid: true,
        blob: f.size <= HISTORY_BLOB_LIMIT ? f : undefined,
      }).catch(() => {
        /* history is best-effort (quota, private mode) */
      });
    } catch (error) {
      if (error instanceof PrepareCancelled || token !== pickTokenRef.current) return;
      setBusy(null);
      setQrError(error instanceof Error ? error.message : "This file could not be prepared.");
      setPlaying(false);
      sfx.error();
    }
  }

  /** Switch QR density without re-hashing: the payload is the same, only the framing changes. */
  function changeDensity(next: DensityKey) {
    if (next === density) return;
    setDensity(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      /* ignore */
    }
    sfx.tick();
    const prepared = preparedRef.current;
    if (!prepared) return;
    const p = presetFor(next);
    installPipeline(prepared.rechunk(p.chunk), p.ec);
    setQrReady(false);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files) as File[];
    if (dropped.length) void onPickMany(dropped);
  }

  // Playback clock. Frames are built ahead of time by the worker pipeline; this loop only
  // decides *when* to advance and blits already-finished bitmaps, so it stays smooth up to 60 fps.
  // In dual mode every tick shows two consecutive frames side by side (2x the data per tick).
  const activeLanes = expanded ? lanes : 1;
  useEffect(() => {
    const pipeline = pipelineRef.current;
    if (!plan || !pipeline) return;
    let raf = 0;
    let stopped = false;
    let nextAt = performance.now();
    let lastUi = 0;
    const interval = 1000 / fps;
    pipeline.want(seqRef.current);

    const have = (n: number) => {
      for (let i = 0; i < activeLanes; i++) if (!pipeline.get(n + i)) return false;
      return true;
    };

    const paint = (n: number) => {
      if (!have(n)) return false;
      try {
        for (let i = 0; i < activeLanes; i++) {
          const frame = pipeline.get(n + i)!;
          if (i === 0 && canvasRef.current) paintFrame(canvasRef.current, frame);
          const target = fullRefs.current[i];
          if (target) paintFrame(target, frame, 1600);
        }
      } catch (error) {
        setQrError(error instanceof Error ? error.message : "QR rendering failed.");
        setPlaying(false);
        return false;
      }
      paintedRef.current = n;
      return true;
    };

    const frameLoop = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(frameLoop);

      // A presenter canvas that mounted after the frame was painted needs catching up.
      for (let i = 0; i < activeLanes; i++) {
        const c = fullRefs.current[i];
        if (c && c.width <= 300) paintedRef.current = -1;
      }

      if (paintedRef.current !== seqRef.current) {
        if (paint(seqRef.current)) {
          setQrReady(true);
          nextAt = Math.max(nextAt, now);
        } else {
          pipeline.want(seqRef.current);
          return;
        }
      }

      if (playing && now >= nextAt) {
        const next = seqRef.current + activeLanes;
        if (!loop && next >= passLength) {
          setPlaying(false);
          setSeq(seqRef.current);
          sfx.pause();
          return;
        }
        if (!have(next)) {
          pipeline.want(seqRef.current); // not ready yet; hold this frame
          return;
        }
        seqRef.current = next;
        pipeline.want(next);
        paint(next);
        nextAt = now - nextAt > interval * 2 ? now + interval : nextAt + interval;
      }

      if (now - lastUi > 120) {
        lastUi = now;
        setSeq((prev) => (prev === seqRef.current ? prev : seqRef.current));
      }
    };
    raf = requestAnimationFrame(frameLoop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      setSeq(seqRef.current);
    };
  }, [plan, playing, fps, loop, passLength, expanded, activeLanes]);

  // Stop broadcasting when the user leaves the Send tab.
  useEffect(() => {
    if (!active) {
      setPlaying(false);
      setExpanded(false);
    }
  }, [active]);

  useEffect(
    () => () => {
      pickTokenRef.current++;
      pipelineRef.current?.dispose();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  function removeFile() {
    pickTokenRef.current++;
    resetForNewPick();
    setFile(null);
    setBundleCount(0);
    setBusy(null);
    setPreviewUrl(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function resetPlayback() {
    seqRef.current = 0;
    paintedRef.current = -1;
    pipelineRef.current?.reset(0);
    setSeq(0);
    setPlaying(false);
    sfx.reset();
  }

  function togglePlaying() {
    if (!plan) return;
    const next = !playing;
    setPlaying(next);
    if (next) sfx.start();
    else sfx.pause();
  }

  function toggleLoop() {
    const next = !loop;
    setLoop(next);
    if (next) sfx.toggleOn();
    else sfx.toggleOff();
  }

  function toggleExpanded() {
    setExpanded((v) => !v);
    paintedRef.current = -1;
    sfx.open();
  }

  function handleFpsChange(next: number) {
    if (next === fps) return;
    const prevTier = tierForFps(fps);
    const nextTier = tierForFps(next);
    if (prevTier !== nextTier) sfx.speedTier(nextTier);
    else sfx.tick();
    setFps(next);
    try {
      localStorage.setItem(FPS_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (!active) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (plan) togglePlaying();
      }
      if (event.key === "Escape" && expanded) setExpanded(false);
      if (event.key.toLowerCase() === "r" && plan) resetPlayback();
      if (event.key.toLowerCase() === "l") toggleLoop();
      if (event.key.toLowerCase() === "f" && plan) toggleExpanded();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function onTilt(e: ReactPointerEvent<HTMLDivElement>) {
    const el = tiltRef.current;
    if (!el || e.pointerType === "touch") return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(900px) rotateY(${px * 8}deg) rotateX(${-py * 8}deg) scale3d(1.012,1.012,1.012)`;
  }
  function onTiltLeave() {
    if (tiltRef.current) tiltRef.current.style.transform = "perspective(900px) rotateY(0) rotateX(0)";
  }

  const ready = Boolean(plan);
  const tickRate = fps * activeLanes; // frames shown per second
  const passSeconds = passLength / tickRate;
  const inFirstPass = seq < passLength;
  const remainingSeconds = Math.max(0, (passLength - seq - activeLanes) / tickRate);
  const progress = !plan ? 0 : inFirstPass ? Math.min(100, ((seq + activeLanes) / passLength) * 100) : 100;
  const shownFrames = plan ? Math.min(totalData, Math.round(((seq + activeLanes) / passLength) * totalData)) : 0;
  const isLarge = Boolean(file && file.size > LONG_TRANSFER_BYTES);
  const throughput = (plan?.chunk ?? preset.chunk) * tickRate;
  const payloadBytes = plan?.size ?? file?.size ?? 0;
  const busyLabel = busy ? `${PHASE_LABEL[busy.phase]} ${Math.round(busy.f * 100)}%` : null;
  const statusLine =
    busyLabel ??
    (!plan
      ? "—"
      : playing
        ? inFirstPass
          ? `${formatDuration(remainingSeconds)} left`
          : "Sending repair frames"
        : `${formatDuration(passSeconds)} to send`);

  /* ---------------------------------------------------------------- empty / busy state */
  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-4 animate-fade-up md:px-8">
        <div
          className={cn(
            "relative flex w-full max-w-2xl flex-col items-center justify-center rounded-[2.25rem] px-6 py-9 text-center transition-all duration-500",
            "border border-dashed border-transparent md:border-glass-border md:py-16",
            dragging ? "glass-strong scale-[1.015] border-primary/60" : "md:glass",
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="hero-stage relative mb-6 grid shrink-0 place-items-center">
            <span className="absolute h-32 w-32 rounded-full bg-primary/25 animate-pulse-ring md:h-40 md:w-40" />
            <div
              className={cn(
                "hero-cube relative grid h-24 w-24 place-items-center rounded-[1.75rem] bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40 transition-transform duration-500 md:h-28 md:w-28 md:rounded-[2rem]",
                dragging && "scale-110 rotate-6",
              )}
            >
              {busy ? (
                <Loader2 className="h-10 w-10 animate-spin text-primary-foreground" />
              ) : (
                <Upload className="h-10 w-10 text-primary-foreground md:h-12 md:w-12" strokeWidth={2} />
              )}
              <span className="hero-shine absolute inset-0 rounded-[1.75rem] md:rounded-[2rem]" />
            </div>
          </div>

          {busy ? (
            <>
              <h2 className="text-display text-2xl md:text-3xl">{PHASE_LABEL[busy.phase]}…</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {bundleCount} files into one transfer · {Math.round(busy.f * 100)}%
              </p>
              <div className="mt-5 h-2 w-full max-w-xs overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200"
                  style={{ width: `${busy.f * 100}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <h2 className="text-display text-3xl md:text-4xl">{dragging ? "Release to add" : "Send files"}</h2>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground md:text-base">
                Pick one file or a whole batch — photos, videos, documents. Offline, private, no accounts.
              </p>
              <button
                onClick={() => {
                  sfx.unlock();
                  inputRef.current?.click();
                }}
                className="group relative mt-7 flex items-center gap-2 overflow-hidden rounded-full bg-gradient-to-br from-primary to-accent px-8 py-4 text-sm font-bold text-primary-foreground shadow-xl shadow-primary/30 transition-transform duration-200 active:scale-95"
              >
                <span className="btn-sheen absolute inset-0" />
                <Upload className="relative h-4 w-4" />
                <span className="relative">Choose files</span>
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []) as File[];
                  if (picked.length) void onPickMany(picked);
                }}
              />
              {qrError && (
                <div role="alert" className="glass mt-5 w-full max-w-sm rounded-2xl border border-destructive/40 p-3 text-xs text-destructive">
                  {qrError}
                </div>
              )}
              <div className="mt-7 flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold text-muted-foreground">
                <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                  <Zap className="h-3 w-3 text-primary" /> Up to 30 frames/s
                </span>
                <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                  <PackageOpen className="h-3 w-3 text-primary" /> Auto-compression
                </span>
                <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
                  <Files className="h-3 w-3 text-primary" /> Multi-file bundles
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");
  const openViewer = () => {
    if (preview) setViewer({ url: preview, name: file.name, mime: file.type, size: file.size, blob: file });
  };

  const thumb = (cls: string) =>
    preview && isImage ? (
      <img src={preview} alt={file.name} className={cn("object-cover", cls)} />
    ) : preview && isVideo ? (
      <video src={preview} muted playsInline preload="metadata" className={cn("object-cover", cls)} />
    ) : isAudio ? (
      <span className={cn("audio-tile grid place-items-center", cls)}>
        <Music2 className="h-5 w-5 text-primary" />
      </span>
    ) : (
      <span className={cn("grid place-items-center bg-secondary", cls)}>
        {bundleCount ? <Files className="h-5 w-5 text-primary" /> : <FileText className="h-5 w-5 text-muted-foreground" />}
      </span>
    );

  /** Compact file row (phones / tablets). A fixed square thumbnail keeps ANY image ratio tidy. */
  const fileRow = (
    <div className="glass flex w-full shrink-0 items-center gap-2.5 rounded-2xl p-2 lg:hidden">
      <button
        type="button"
        onClick={openViewer}
        aria-label="Open preview"
        className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-secondary transition-transform active:scale-95"
      >
        {thumb("h-full w-full")}
        {isVideo && (
          <span className="absolute inset-0 grid place-items-center bg-black/25">
            <Film className="h-4 w-4 text-white" />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[13px] font-bold leading-tight">{file.name}</h3>
        <p className="mt-0.5 truncate text-[11px] font-medium text-muted-foreground">
          {bundleCount ? `${bundleCount} files · ` : ""}
          {formatBytes(file.size)} · {plan ? totalData : "…"} frames · <span className="font-semibold text-foreground/80">{statusLine}</span>
          {savedBytes > 0 && (
            <span className="font-bold text-emerald-600 dark:text-emerald-400"> · −{Math.round((savedBytes / file.size) * 100)}%</span>
          )}
        </p>
      </div>
      <button
        onClick={removeFile}
        className="glass grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground active:scale-90"
        aria-label="Remove file"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  /** Large preview card (desktop): fills the height that is left, any aspect ratio, never distorted. */
  const filePanel = (
    <div className="glass relative hidden min-h-[10rem] flex-1 overflow-hidden rounded-[2rem] lg:block">
      <button type="button" onClick={openViewer} aria-label="Open preview" className="group absolute inset-0 bg-black/10">
        {preview && isImage ? (
          <img src={preview} alt={file.name} className="absolute inset-0 h-full w-full object-contain p-3" />
        ) : preview && isVideo ? (
          <video src={preview} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-contain p-3" />
        ) : isAudio ? (
          <span className="audio-tile absolute inset-0 grid place-items-center">
            <Music2 className="h-16 w-16 text-primary" strokeWidth={1.5} />
          </span>
        ) : (
          <span className="absolute inset-0 grid place-items-center text-muted-foreground">
            {bundleCount ? <Files className="h-16 w-16 text-primary" strokeWidth={1.4} /> : <FileText className="h-16 w-16" strokeWidth={1.3} />}
          </span>
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <span className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-xs font-bold text-neutral-900">
            <Maximize2 className="h-3.5 w-3.5" /> Open preview
          </span>
        </span>
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-3 bg-gradient-to-t from-black/70 to-transparent p-4 pt-12 text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{file.name}</p>
          <p className="text-[11px] text-white/70">
            {bundleCount ? `${bundleCount} files · ` : ""}
            {formatBytes(file.size)} · {file.type || "file"}
          </p>
        </div>
      </div>
      <button
        onClick={removeFile}
        className="hud-card absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full text-white active:scale-90"
        aria-label="Remove file"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const statTile = (icon: ReactNode, labelText: string, value: string, tone = "") => (
    <div className="glass flex min-w-0 flex-col gap-0.5 rounded-2xl px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {icon}
        {labelText}
      </span>
      <span className={cn("truncate text-sm font-extrabold tabular-nums", tone)}>{value}</span>
    </div>
  );

  const stats = (
    <div className="hidden grid-cols-2 gap-2 lg:grid xl:grid-cols-4">
      {statTile(<HardDrive className="h-3 w-3 text-primary" />, "Size", formatBytes(payloadBytes))}
      {statTile(<Layers3 className="h-3 w-3 text-primary" />, "Frames", plan ? String(totalData) : "…")}
      {statTile(<Timer className="h-3 w-3 text-primary" />, "Time", statusLine)}
      {statTile(
        savedBytes > 0 ? <PackageOpen className="h-3 w-3 text-primary" /> : <Activity className="h-3 w-3 text-primary" />,
        savedBytes > 0 ? "Compressed" : "Rate",
        savedBytes > 0 ? `−${Math.round((savedBytes / file.size) * 100)}%` : `${formatBytes(throughput)}/s`,
        savedBytes > 0 ? "text-emerald-600 dark:text-emerald-400" : "",
      )}
    </div>
  );

  const stage = (
    <div className="relative flex h-full w-full min-h-0 flex-col items-center justify-center">
      <div
        ref={tiltRef}
        onPointerMove={onTilt}
        onPointerLeave={onTiltLeave}
        style={{ width: "min(100%, calc(100cqh - 1.25rem))" }}
        className={cn(
          "qr-stage relative aspect-square rounded-[1.5rem] bg-white p-1.5 shadow-2xl transition-[transform,box-shadow] duration-300 ease-out",
          playing ? "qr-stage-live shadow-primary/40" : "shadow-black/20",
        )}
      >
        <canvas
          ref={canvasRef}
          aria-label="OFFDROP transfer QR frame"
          className={cn(
            "h-full w-full rounded-2xl object-contain [image-rendering:pixelated] transition-opacity duration-300",
            !qrReady || !ready ? "opacity-0" : "opacity-100",
          )}
        />
        {(!qrReady || !ready) && !qrError && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm font-semibold text-neutral-500">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            {busyLabel ?? "Building frames…"}
          </div>
        )}
        {ready && qrReady && !playing && (
          <button
            onClick={togglePlaying}
            className="absolute inset-0 grid place-items-center rounded-[1.5rem] bg-black/35 opacity-0 backdrop-blur-[2px] transition-opacity duration-300 hover:opacity-100 focus-visible:opacity-100"
            aria-label="Play"
          >
            <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 shadow-xl">
              <Play className="ml-1 h-7 w-7 text-neutral-900" fill="currentColor" />
            </span>
          </button>
        )}
        <button
          onClick={toggleExpanded}
          disabled={!ready}
          className="absolute -right-1.5 -top-1.5 grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/40 transition-transform active:scale-90 disabled:opacity-50"
          aria-label="Fullscreen QR"
          title="Fullscreen QR (F)"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      <div
        className="mt-2 h-1.5 shrink-0 overflow-hidden rounded-full bg-secondary"
        style={{ width: "min(100%, calc(100cqh - 1.25rem))" }}
      >
        <div
          className="progress-fill h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      {qrError && (
        <div
          role="alert"
          className="glass animate-pop-in absolute inset-x-0 top-2 z-10 mx-auto w-[min(100%,24rem)] rounded-2xl border border-destructive/40 p-2.5 text-center text-xs text-destructive"
        >
          {qrError}
        </div>
      )}
    </div>
  );

  const playButton = (
    <button
      onClick={togglePlaying}
      disabled={!ready}
      className={cn(
        "relative flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden rounded-2xl py-3 text-sm font-bold transition-all duration-200 active:scale-[0.96] disabled:opacity-60",
        playing ? "glass text-foreground" : "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/30",
      )}
    >
      {!playing && <span className="btn-sheen absolute inset-0" />}
      {playing ? <Pause className="relative h-4 w-4" /> : <Play className="relative h-4 w-4" />}
      <span className="relative">{playing ? "Pause" : "Play"}</span>
    </button>
  );
  const loopButton = (
    <button
      type="button"
      onClick={toggleLoop}
      className={cn(
        "grid h-11 w-11 shrink-0 place-items-center rounded-2xl transition-all duration-200 active:scale-90",
        loop ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "glass text-muted-foreground",
      )}
      aria-label={loop ? "Repair frames on" : "Repair frames off"}
      aria-pressed={loop}
      title="Keep sending repair frames after the first pass (L)"
    >
      <Repeat2 className="h-4 w-4" />
    </button>
  );
  const speedSlider = (
    <input
      type="range"
      min={MIN_FPS}
      max={MAX_FPS}
      step={1}
      value={fps}
      onChange={(e) => handleFpsChange(Number(e.target.value))}
      className="ios-range min-w-0 flex-1"
      aria-label="Transfer speed"
      data-no-swipe
    />
  );
  const densityPicker = (
    <div className="grid grid-cols-4 gap-1 rounded-2xl bg-secondary/60 p-1" role="radiogroup" aria-label="QR density">
      {DENSITY_PRESETS.map((p) => (
        <button
          key={p.key}
          role="radio"
          aria-checked={density === p.key}
          onClick={() => changeDensity(p.key)}
          className={cn(
            "rounded-xl px-1 py-1.5 text-[11px] font-bold transition-all duration-300",
            density === p.key
              ? "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-md shadow-primary/25"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );

  /** Phone/tablet controls: three tight rows, sized so the whole Send screen fits without scrolling. */
  const controlsCompact = (
    <div className="flex w-full shrink-0 flex-col gap-1.5 lg:hidden">
      <div className="flex items-center gap-2">
        {playButton}
        {loopButton}
        <button
          onClick={resetPlayback}
          className="glass grid h-11 w-11 shrink-0 place-items-center rounded-2xl transition-transform active:scale-90"
          aria-label="Reset"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>
      <div className="glass flex items-center gap-2.5 rounded-2xl px-3 py-2">
        <Gauge className="h-4 w-4 shrink-0 text-primary" />
        {speedSlider}
        <span className="min-w-[5.5rem] text-right text-[11px] font-extrabold tabular-nums text-primary">
          {fps} fps · {tierForFps(fps)}
        </span>
      </div>
      <div className="glass rounded-2xl p-1">{densityPicker}</div>
    </div>
  );

  /** Desktop controls: roomier, with hints. */
  const controlsRich = (
    <div className="hidden w-full shrink-0 flex-col gap-2.5 lg:flex">
      <div className="flex w-full items-center gap-2">
        {playButton}
        {loopButton}
        <button
          onClick={resetPlayback}
          className="glass flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold transition-transform active:scale-95"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
      </div>
      <div className="glass rounded-3xl px-4 py-3">
        <div className="flex items-center gap-3">
          <Gauge className="h-4 w-4 shrink-0 text-primary" />
          {speedSlider}
          <span className="min-w-[4.4rem] text-right text-[11px] font-extrabold uppercase tracking-wider text-primary">
            {tierForFps(fps)}
          </span>
        </div>
        <p className="mt-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
          <span>
            {fps} fps · ≈ {formatBytes(throughput)}/s
          </span>
          <span>{formatDuration(payloadBytes / (preset.chunk * fps))} total</span>
        </p>
      </div>
      <div className="glass rounded-3xl p-2.5">
        {densityPicker}
        <p className="mt-1.5 px-1 text-center text-[11px] font-medium text-muted-foreground">
          {preset.hint} · {formatBytes(preset.chunk)}/code
        </p>
      </div>
      {isLarge && ready && !qrError && (
        <div className="glass flex items-start gap-2 rounded-2xl p-3 text-left text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            Large file: about {formatDuration(passSeconds)} at this speed. Screens stay awake automatically. Try
            fullscreen with Dual QR for 2× throughput.
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-4 pb-1 animate-fade-up md:px-8 lg:overflow-hidden">
      <MediaViewer item={viewer} onClose={() => setViewer(null)} />

      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-2 lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)] lg:gap-8 lg:py-1">
        <div className="order-2 min-h-[8.5rem] flex-1 lg:order-1 lg:min-h-0" style={{ containerType: "size" }}>
          {stage}
        </div>
        <div className="order-1 flex shrink-0 flex-col gap-2 lg:order-2 lg:min-h-0 lg:shrink lg:gap-3 lg:overflow-y-auto lg:pr-1 no-scrollbar">
          {fileRow}
          {filePanel}
          {stats}
          {controlsRich}
        </div>
        <div className="order-3 shrink-0 lg:hidden">{controlsCompact}</div>
      </div>

      {expanded && plan && (
        <Portal>
          <div
            className="presenter fixed inset-0 z-[90] grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-neutral-950 text-white [background-image:radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--color-primary)_28%,transparent),transparent)] landscape:grid-cols-[minmax(0,1fr)_19rem] landscape:grid-rows-[auto_minmax(0,1fr)]"
            role="dialog"
            aria-modal="true"
            aria-label="Fullscreen QR"
          >
            {/* QR area: one code, or two when Dual is on. Layout flips with the area's own aspect ratio. */}
            <div className="lane-area row-start-2 min-h-0 min-w-0 p-3 sm:p-5 landscape:col-start-1 landscape:row-span-2 landscape:row-start-1">
              <div className="lane-inner" style={{ ["--n" as string]: activeLanes }}>
                {Array.from({ length: activeLanes }, (_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "lane-tile relative rounded-[1.5rem] bg-white p-2 shadow-[0_0_90px_-10px_var(--color-primary)]",
                      playing && "qr-stage-live",
                    )}
                  >
                    <canvas
                      ref={(el) => {
                        fullRefs.current[i] = el;
                      }}
                      className="h-full w-full rounded-xl object-contain [image-rendering:pixelated]"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Title + exit */}
            <header className="safe-top row-start-1 flex min-w-0 items-center gap-3 px-4 pb-1 pt-3 landscape:col-start-2 landscape:row-start-1 landscape:pt-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{file.name}</p>
                <p className="truncate text-[11px] text-white/60">
                  {bundleCount ? `${bundleCount} files · ` : ""}
                  {formatBytes(file.size)} · {plan.total} frames
                </p>
              </div>
              <button
                onClick={toggleExpanded}
                className="hud-card grid h-11 w-11 shrink-0 place-items-center rounded-full text-white transition-transform active:scale-90"
                aria-label="Exit fullscreen"
              >
                <Minimize2 className="h-5 w-5" />
              </button>
            </header>

            {/* Transport */}
            <footer className="safe-bottom row-start-3 flex min-w-0 flex-col gap-3 px-4 pb-4 pt-2 landscape:col-start-2 landscape:row-start-2 landscape:justify-end landscape:pb-5">
              <div className="hud-card min-w-0 rounded-3xl p-3.5">
                <div className="flex items-center gap-3">
                  <button
                    onClick={togglePlaying}
                    className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/40 transition-transform active:scale-90"
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {playing ? <Pause className="h-6 w-6" fill="currentColor" /> : <Play className="ml-0.5 h-6 w-6" fill="currentColor" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-lg font-extrabold tabular-nums">{Math.floor(progress)}%</span>
                      <span className="truncate text-[11px] font-semibold text-white/70">
                        {inFirstPass ? `${formatDuration(remainingSeconds)} left` : "Repair frames"}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/15">
                      <div
                        className="progress-fill h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <Gauge className="h-4 w-4 shrink-0 text-white/70" />
                  <input
                    type="range"
                    min={MIN_FPS}
                    max={MAX_FPS}
                    step={1}
                    value={fps}
                    onChange={(e) => handleFpsChange(Number(e.target.value))}
                    className="ios-range min-w-0 flex-1"
                    aria-label="Transfer speed"
                  />
                  <span className="min-w-[3.4rem] text-right text-[11px] font-extrabold uppercase tracking-wide text-white/80">
                    {fps} fps
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setLanes((l) => (l === 1 ? 2 : 1));
                      paintedRef.current = -1;
                      sfx.toggleOn();
                    }}
                    aria-pressed={lanes === 2}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all active:scale-95",
                      lanes === 2 ? "bg-primary text-primary-foreground" : "bg-white/12 text-white/80",
                    )}
                  >
                    <Layers3 className="h-3.5 w-3.5" /> Dual QR {lanes === 2 ? "on" : "off"}
                  </button>
                  <span className="truncate text-[11px] font-medium text-white/55">
                    ≈ {formatBytes(throughput)}/s{activeLanes === 2 ? " · needs a sharp camera" : ""}
                  </span>
                </div>
              </div>
            </footer>
          </div>
        </Portal>
      )}
    </div>
  );
}
