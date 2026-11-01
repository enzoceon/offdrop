import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
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
import {
  FramePipeline,
  PrepareCancelled,
  paintFrame,
  prepareFile,
  type PreparedFile,
} from "@/lib/sender-engine";
import { saveItem } from "@/lib/history";
import { sfx } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { MediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { Portal } from "@/components/Portal";

type SpeedTier = "Gentle" | "Normal" | "Fast" | "Turbo";

const MIN_FPS = 1;
const MAX_FPS = 30;
const DEFAULT_FPS = MAX_FPS;
const DENSITY_KEY = "offdrop:density";
/** Largest file we also keep a copy of in local history. */
const HISTORY_BLOB_LIMIT = 64 * 1024 * 1024;

const TIER_RANGES: { tier: SpeedTier; min: number; max: number }[] = [
  { tier: "Gentle", min: 1, max: 3 },
  { tier: "Normal", min: 4, max: 8 },
  { tier: "Fast", min: 9, max: 15 },
  { tier: "Turbo", min: 16, max: 30 },
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
  return "max";
}

export function Sender({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<StreamPlan | null>(null);
  const [preparing, setPreparing] = useState<{ f: number; phase: "compress" | "hash" } | null>(null);
  const [savedBytes, setSavedBytes] = useState(0);
  const [seq, setSeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [loop, setLoop] = useState(true);
  const [density, setDensity] = useState<DensityKey>("max");
  const [preview, setPreview] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrReady, setQrReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement>(null);
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

  useEffect(() => setDensity(readDensity()), []);

  function disposePipeline() {
    pipelineRef.current?.dispose();
    pipelineRef.current = null;
  }

  function setPreviewUrl(url: string | null) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreview(url);
  }

  function installPipeline(prepared: { plan: StreamPlan; source: PreparedFile["source"] }, ec: "L" | "M") {
    disposePipeline();
    const pipeline = new FramePipeline(prepared.plan, prepared.source, ec);
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

  async function onPick(f: File) {
    const token = ++pickTokenRef.current;
    disposePipeline();
    preparedRef.current = null;
    setFile(f);
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
    setPreviewUrl(URL.createObjectURL(f));

    if (f.size === 0) {
      setQrError("This file is empty, so there is nothing to send.");
      sfx.error();
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setQrError("Files over 4 GB are not supported.");
      sfx.error();
      return;
    }

    try {
      setPreparing({ f: 0, phase: "hash" });
      const prepared = await prepareFile(f, {
        chunk: preset.chunk,
        isCancelled: () => token !== pickTokenRef.current,
        onProgress: (fraction, phase) => {
          if (token === pickTokenRef.current) setPreparing({ f: fraction, phase });
        },
      });
      if (token !== pickTokenRef.current) return;
      preparedRef.current = prepared;
      setSavedBytes(prepared.savedBytes);
      installPipeline(prepared, preset.ec);
      setPreparing(null);
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
      setPreparing(null);
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
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) void onPick(dropped);
  }

  // Playback clock. Frames are built ahead of time by the pipeline; this loop
  // only decides *when* to advance and paints the already-prepared frame, so the
  // frame rate holds steady even for dense codes.
  useEffect(() => {
    const pipeline = pipelineRef.current;
    if (!plan || !pipeline) return;
    let raf = 0;
    let stopped = false;
    let nextAt = performance.now();
    let lastUi = 0;
    const interval = 1000 / fps;
    pipeline.want(seqRef.current);

    const paint = (n: number) => {
      const frame = pipeline.get(n);
      const canvas = canvasRef.current;
      if (!frame || !canvas) return false;
      try {
        paintFrame(canvas, frame);
        // Presenter mode mirrors the same frame onto the fullscreen canvas.
        if (fullCanvasRef.current) paintFrame(fullCanvasRef.current, frame, 1400);
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

      // The fullscreen canvas mounts after the frame was painted: catch it up.
      if (fullCanvasRef.current && fullCanvasRef.current.width <= 300) paintedRef.current = -1;

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
        const next = seqRef.current + 1;
        if (!loop && next >= passLength) {
          setPlaying(false);
          setSeq(seqRef.current);
          sfx.pause();
          return;
        }
        if (!pipeline.get(next)) {
          pipeline.want(seqRef.current); // not ready yet; hold this frame
          return;
        }
        seqRef.current = next;
        pipeline.want(next);
        paint(next);
        // Keep a steady cadence, but never try to "catch up" with a burst.
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
  }, [plan, playing, fps, loop, passLength, expanded]);

  // Stop broadcasting when the user leaves the Send tab.
  useEffect(() => {
    if (!active) {
      setPlaying(false);
      setExpanded(false);
    }
  }, [active]);

  // Release everything on unmount.
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
    disposePipeline();
    preparedRef.current = null;
    setFile(null);
    setPlan(null);
    setPreparing(null);
    setSeq(0);
    seqRef.current = 0;
    paintedRef.current = -1;
    setPlaying(false);
    setExpanded(false);
    setViewer(null);
    setQrError(null);
    setQrReady(false);
    setSavedBytes(0);
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

  /** Gentle 3D tilt that follows the pointer over the QR card (desktop/tablet hover and touch drag). */
  function onTilt(e: ReactPointerEvent<HTMLDivElement>) {
    const el = tiltRef.current;
    if (!el || e.pointerType === "touch") return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(900px) rotateY(${px * 10}deg) rotateX(${-py * 10}deg) scale3d(1.015,1.015,1.015)`;
  }
  function onTiltLeave() {
    if (tiltRef.current) tiltRef.current.style.transform = "perspective(900px) rotateY(0) rotateX(0)";
  }

  const ready = Boolean(plan);
  const passSeconds = passLength / fps;
  const inFirstPass = seq < passLength;
  const remainingSeconds = Math.max(0, (passLength - seq - 1) / fps);
  const progress = !plan ? 0 : inFirstPass ? Math.min(100, ((seq + 1) / passLength) * 100) : 100;
  const shownFrames = plan ? Math.min(totalData, Math.round(((seq + 1) / passLength) * totalData)) : 0;
  const isLarge = Boolean(file && file.size > LONG_TRANSFER_BYTES);
  const payloadBytes = plan?.size ?? file?.size ?? 0;
  const throughput = payloadBytes / Math.max(1, passSeconds);
  const prepLabel = preparing
    ? preparing.phase === "compress"
      ? `Compressing ${Math.round(preparing.f * 100)}%`
      : `Preparing ${Math.round(preparing.f * 100)}%`
    : null;

  /* ---------------------------------------------------------------- empty state */
  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 animate-fade-up md:px-8">
        <div
          className={cn(
            "relative flex w-full max-w-xl flex-col items-center justify-center rounded-[2.25rem] px-6 py-10 text-center transition-all duration-500",
            "border border-dashed border-transparent md:border-glass-border md:py-14",
            dragging ? "glass-strong scale-[1.015] border-primary/60" : "md:glass",
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="hero-stage relative mb-7 grid place-items-center">
            <span className="absolute h-36 w-36 rounded-full bg-primary/25 animate-pulse-ring" />
            <div
              className={cn(
                "hero-cube relative grid h-28 w-28 place-items-center rounded-[2rem] bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40 transition-transform duration-500",
                dragging && "scale-110 rotate-6",
              )}
            >
              <Upload className="h-12 w-12 text-primary-foreground" strokeWidth={2} />
              <span className="hero-shine absolute inset-0 rounded-[2rem]" />
            </div>
          </div>
          <h2 className="text-display text-3xl md:text-4xl">{dragging ? "Release to add" : "Send a file"}</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground md:text-base">
            Photos, videos, audio, documents — turned into a private, offline QR stream that another phone just
            watches.
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
            <span className="relative">Choose file</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
          />
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold text-muted-foreground">
            <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
              <Zap className="h-3 w-3 text-primary" /> Up to 30 frames/s
            </span>
            <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
              <PackageOpen className="h-3 w-3 text-primary" /> Auto-compression
            </span>
            <span className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
              <Layers3 className="h-3 w-3 text-primary" /> Loss-proof repair frames
            </span>
          </div>
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

  const fileCard = (
    <div className="glass flex w-full items-center gap-3 rounded-3xl p-3">
      <button
        type="button"
        onClick={openViewer}
        aria-label="Open preview"
        className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-secondary shadow-sm transition-transform active:scale-95"
      >
        {preview && isImage ? (
          <img src={preview} alt={file.name} className="h-full w-full object-cover" />
        ) : preview && isVideo ? (
          <>
            <video src={preview} muted playsInline preload="metadata" className="h-full w-full object-cover" />
            <span className="absolute inset-0 grid place-items-center bg-black/25">
              <Film className="h-5 w-5 text-white" />
            </span>
          </>
        ) : isAudio ? (
          <span className="audio-tile grid h-full w-full place-items-center">
            <Music2 className="h-6 w-6 text-primary" />
          </span>
        ) : (
          <span className="grid h-full w-full place-items-center">
            <FileText className="h-6 w-6 text-muted-foreground" />
          </span>
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <Maximize2 className="h-4 w-4 text-white" />
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-bold leading-tight">{file.name}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-muted-foreground">
          <span className="flex items-center gap-1">
            <HardDrive className="h-3 w-3 text-primary" />
            {formatBytes(file.size)}
          </span>
          <span className="flex items-center gap-1">
            <Layers3 className="h-3 w-3 text-primary" />
            {plan ? (playing && inFirstPass ? `${shownFrames}/${totalData}` : totalData) : "…"} frames
          </span>
          {savedBytes > 0 && (
            <span className="flex items-center gap-1 font-bold text-emerald-600 dark:text-emerald-400">
              <PackageOpen className="h-3 w-3" />
              −{Math.round((savedBytes / file.size) * 100)}% compressed
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-foreground/80">
          <Clock className="h-3 w-3 text-primary" />
          {prepLabel ??
            (!plan
              ? "—"
              : playing
                ? inFirstPass
                  ? `${formatDuration(remainingSeconds)} left`
                  : "Sending repair frames"
                : `${formatDuration(passSeconds)} to send`)}
        </div>
      </div>
      <button
        onClick={removeFile}
        className="glass grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground transition-all hover:text-foreground active:scale-90"
        aria-label="Remove file"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const stage = (
    <div className="relative mx-auto flex w-full max-w-[min(100%,calc(100dvh-20rem))] flex-col items-center sm:max-w-[min(100%,34rem,calc(100dvh-12rem))] lg:max-w-[min(100%,calc(100dvh-8rem))] xl:max-w-[min(100%,48rem,calc(100dvh-9rem))]">
      <div
        ref={tiltRef}
        onPointerMove={onTilt}
        onPointerLeave={onTiltLeave}
        className={cn(
          "qr-stage relative aspect-square w-full rounded-[1.75rem] bg-white p-2 shadow-2xl transition-[transform,box-shadow] duration-300 ease-out",
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
            {prepLabel ?? "Building frames…"}
          </div>
        )}
        {ready && qrReady && !playing && (
          <button
            onClick={togglePlaying}
            className="absolute inset-0 grid place-items-center rounded-[1.75rem] bg-black/35 opacity-0 backdrop-blur-[2px] transition-opacity duration-300 hover:opacity-100 focus-visible:opacity-100"
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
          className="absolute -right-2 -top-2 grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/40 transition-transform active:scale-90 disabled:opacity-50"
          aria-label="Fullscreen QR"
          title="Fullscreen QR (F)"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-secondary p-[1px]">
        <div
          className="progress-fill h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  const controls = (
    <div className="flex w-full flex-col gap-3">
      <div className="flex w-full items-center justify-center gap-2">
        <button
          onClick={togglePlaying}
          disabled={!ready}
          className={cn(
            "relative flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden rounded-2xl py-3.5 text-sm font-bold transition-all duration-200 active:scale-[0.96] disabled:opacity-60",
            playing
              ? "glass text-foreground"
              : "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/30",
          )}
        >
          {!playing && <span className="btn-sheen absolute inset-0" />}
          {playing ? <Pause className="relative h-4 w-4" /> : <Play className="relative h-4 w-4" />}
          <span className="relative">{playing ? "Pause" : "Play"}</span>
        </button>
        <button
          type="button"
          onClick={toggleLoop}
          className={cn(
            "grid h-[3.1rem] w-[3.1rem] shrink-0 place-items-center rounded-2xl transition-all duration-200 active:scale-90",
            loop ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "glass text-muted-foreground",
          )}
          aria-label={loop ? "Repair frames on" : "Repair frames off"}
          aria-pressed={loop}
          title="Keep sending repair frames after the first pass (L)"
        >
          <Repeat2 className="h-4 w-4" />
        </button>
        <button
          onClick={resetPlayback}
          className="glass flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold transition-transform active:scale-95"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
      </div>

      <div className="glass rounded-3xl px-4 py-3">
        <div className="flex items-center gap-3">
          <Gauge className="h-4 w-4 shrink-0 text-primary" />
          <input
            type="range"
            min={MIN_FPS}
            max={MAX_FPS}
            step={1}
            value={fps}
            onChange={(e) => handleFpsChange(Number(e.target.value))}
            className="ios-range flex-1"
            aria-label="Transfer speed"
            data-no-swipe
          />
          <span className="min-w-[4.4rem] text-right text-[11px] font-extrabold uppercase tracking-wider text-primary">
            {tierForFps(fps)}
          </span>
        </div>
        <p className="mt-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
          <span>
            {fps} frames/s · ≈ {formatBytes(throughput)}/s
          </span>
          <span>{formatDuration(payloadBytes / throughput)} total</span>
        </p>
      </div>

      <div className="glass rounded-3xl p-3">
        <div className="grid grid-cols-4 gap-1 rounded-2xl bg-secondary/60 p-1" role="radiogroup" aria-label="QR density">
          {DENSITY_PRESETS.map((p) => (
            <button
              key={p.key}
              role="radio"
              aria-checked={density === p.key}
              onClick={() => changeDensity(p.key)}
              className={cn(
                "rounded-xl px-1 py-2 text-[11px] font-bold transition-all duration-300",
                density === p.key
                  ? "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-md shadow-primary/25"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="mt-2 px-1 text-center text-[11px] font-medium text-muted-foreground">
          {preset.hint} · {formatBytes(preset.chunk)} per code
        </p>
      </div>

      {qrError && (
        <div role="alert" className="glass animate-pop-in rounded-2xl border border-destructive/40 p-3 text-center text-xs text-destructive">
          {qrError}
        </div>
      )}

      {isLarge && ready && !qrError && (
        <div className="glass flex items-start gap-2 rounded-2xl p-3 text-left text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            First-pass estimate: about {formatDuration(passSeconds)} at {fps} FPS. Actual time depends on how quickly
            the receiver can read each code; missed frames are recovered while repair frames are playing.
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-3 animate-fade-up md:px-8">
      <MediaViewer item={viewer} onClose={() => setViewer(null)} />

      <div className="mx-auto grid w-full max-w-[100rem] gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(21rem,0.8fr)] lg:items-start lg:gap-8 lg:pt-2 xl:grid-cols-[minmax(0,1.55fr)_minmax(24rem,0.8fr)]">
        <div className="order-2 lg:order-1 lg:sticky lg:top-0">{stage}</div>
        <div className="order-1 flex flex-col gap-3 lg:order-2">
          {fileCard}
          <div className="hidden lg:block">{controls}</div>
        </div>
        <div className="order-3 lg:hidden">{controls}</div>
      </div>

      {expanded && (
        <Portal>
          <div
            className="presenter fixed inset-0 z-[90] flex flex-col items-center justify-between overflow-y-auto bg-[#07090f] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-white sm:px-8"
            onClick={toggleExpanded}
            role="dialog"
            aria-modal="true"
            aria-label="Fullscreen QR"
          >
            <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 py-4">
              <div className="flex w-full max-w-5xl items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
                    OFFDROP · {playing ? "Broadcasting" : "Paused"}
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold sm:text-base">{file.name}</p>
                </div>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold tabular-nums text-white/75">
                  {tierForFps(fps)} · {fps} FPS
                </span>
              </div>
              <canvas
                ref={fullCanvasRef}
                className="max-h-[min(76dvh,calc(100vw-2rem))] max-w-full flex-1 object-contain [image-rendering:pixelated]"
              />
            </div>
            <div
              className="glass-strong w-full max-w-5xl rounded-3xl p-3 sm:p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between gap-3 text-xs">
                <span className="rounded-md bg-white/5 px-2 py-1 font-semibold text-white/75">
                  {inFirstPass ? `${formatDuration(remainingSeconds)} left in first pass` : "Repair frames · keep scanning"}
                </span>
                <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 tabular-nums text-white/55">
                  {inFirstPass ? `${shownFrames.toLocaleString()} / ${totalData.toLocaleString()} frames` : "100% sent"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={togglePlaying}
                  className="flex h-12 min-w-32 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-accent px-5 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 active:scale-95"
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
                  {playing ? "Pause" : "Resume"}
                </button>
                <button
                  onClick={resetPlayback}
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-white/80 active:scale-95"
                  aria-label="Restart transfer"
                  title="Restart transfer"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1 text-right">
                  <p className="truncate text-[11px] font-semibold text-white/75">{file.name}</p>
                  <p className="mt-0.5 text-[10px] text-white/45">
                    {formatBytes(file.size)} · {formatDuration(passSeconds)} estimated
                  </p>
                </div>
                <button
                  onClick={toggleExpanded}
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-white active:scale-95"
                  aria-label="Exit fullscreen"
                >
                  <Minimize2 className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
