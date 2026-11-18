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
  Expand,
  Sparkles,
  Palette,
  Zap as ZapIcon,
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
import { haptics } from "@/lib/haptics";
import { useWakeLock } from "@/lib/wake-lock";
import { cn } from "@/lib/utils";
import { MediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { Portal } from "@/components/Portal";
import { GlideSegment } from "@/components/GlideSegment";
import { LaneGrid } from "@/components/LaneGrid";

type SpeedTier = "Gentle" | "Normal" | "Fast" | "Turbo";
type Phase = "bundle" | "compress" | "hash";
type Lanes = 1 | 2 | 4 | 6 | 8 | 9 | 12;

const LANE_OPTIONS: { key: Lanes; label: string }[] = [
  { key: 1, label: "1×" },
  { key: 2, label: "2×" },
  { key: 4, label: "4×" },
  { key: 6, label: "6×" },
  { key: 8, label: "8×" },
  { key: 9, label: "9×" },
  { key: 12, label: "12×" },
];

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const MIN_FPS = 1;
const MAX_FPS = 30;
/** 15 fps is the sweet spot: every code stays on screen for ~2 camera frames at 30 fps. */
const DEFAULT_FPS = 15;
const DENSITY_KEY = "offdrop:density";
const FPS_KEY = "offdrop:fps2";
/** Largest file we also keep a copy of in local history. */
const HISTORY_BLOB_LIMIT = 64 * 1024 * 1024;

const TIER_RANGES: { tier: SpeedTier; min: number; max: number }[] = [
  { tier: "Gentle", min: 1, max: 6 },
  { tier: "Normal", min: 7, max: 12 },
  { tier: "Fast", min: 13, max: 20 },
  { tier: "Turbo", min: 21, max: 30 },
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
    if (v === "reliable" || v === "balanced" || v === "dense" || v === "max" || v === "ultra") return v;
  } catch {
    /* ignore */
  }
  return "dense";
}

/** Play <-> Pause: both glyphs are always mounted and cross-rotate/scale into each other. */
function PlayPauseIcon({ playing, className }: { playing: boolean; className?: string }) {
  const base = "absolute inset-0 block h-full w-full origin-center transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]";
  return (
    <span className={cn("relative inline-block shrink-0", className ?? "h-4 w-4")} aria-hidden="true">
      <Play
        className={base}
        fill="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        style={{ opacity: playing ? 0 : 1, transform: playing ? "rotate(90deg) scale(0.3)" : "rotate(0deg) scale(1)" }}
      />
      <Pause
        className={base}
        fill="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        style={{ opacity: playing ? 1 : 0, transform: playing ? "rotate(0deg) scale(1)" : "rotate(-90deg) scale(0.3)" }}
      />
    </span>
  );
}

/** Two glyphs morphing into each other (used for fullscreen expand/collapse). */
function SwapIcon({ on, a, b, className }: { on: boolean; a: ReactNode; b: ReactNode; className?: string }) {
  const base = "absolute inset-0 grid place-items-center transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]";
  return (
    <span className={cn("relative inline-block", className ?? "h-4 w-4")} aria-hidden="true">
      <span className={base} style={{ opacity: on ? 0 : 1, transform: on ? "scale(0.3) rotate(45deg)" : "scale(1)" }}>{a}</span>
      <span className={base} style={{ opacity: on ? 1 : 0, transform: on ? "scale(1)" : "scale(0.3) rotate(-45deg)" }}>{b}</span>
    </span>
  );
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
  // Default is always 4 codes at once (the fastest setting that stays readable on most screens).
  const [lanes, setLanes] = useState<Lanes>(4);
  const [switching, setSwitching] = useState<string | null>(null);
  // EXPERIMENTAL: three independent QR codes per tile (R, G, B channels).
  const [color, setColor] = useState(false);
  const [resetSpin, setResetSpin] = useState(0);
  const switchingRef = useRef(false);
  const isLg = useMediaQuery("(min-width: 1024px)");
  const inputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [tapFlash, setTapFlash] = useState<"play" | "pause" | null>(null);
  const mainRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const fullRefs = useRef<Array<HTMLCanvasElement | null>>([]);
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

  function installPipeline(prepared: { plan: StreamPlan; blob: Blob }, ec: "L" | "M", colorMode = color) {
    disposePipeline();
    const pipeline = new FramePipeline(prepared.plan, prepared.blob, ec, colorMode);
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
      installPipeline(prepared, preset.ec, color);
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
    announceSwitch(`${p.label} · ${formatBytes(p.chunk)} per code`);
    installPipeline(prepared.rechunk(p.chunk), p.ec, color);
  }

  function toggleColor() {
    const prepared = preparedRef.current;
    const next = !color;
    setColor(next);
    announceSwitch(next ? "Colour ×3 (beta) on" : "Colour mode off");
    haptics.toggle(next);
    sfx.toggleOn();
    if (prepared && plan) installPipeline({ plan, blob: prepared.blob }, preset.ec, next);
  }

  /** Brief, visible acknowledgement while the new frames render (replaces the old loading state). */
  function announceSwitch(label: string) {
    switchingRef.current = true;
    setSwitching(label);
    window.setTimeout(() => {
      // Safety net: never leave the tile dimmed if no frame arrives.
      if (switchingRef.current) {
        switchingRef.current = false;
        setSwitching(null);
      }
    }, 1500);
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
  // Several codes per tick only make sense where there is room: fullscreen, or the big desktop stage.
  const activeLanes: Lanes = expanded || isLg ? lanes : 1;
  const stride = color ? 3 : 1; // frames consumed per tile
  const step = activeLanes * stride; // sequence numbers consumed per tick
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
      for (let i = 0; i < activeLanes; i++) if (!pipeline.get(n + i * stride)) return false;
      return true;
    };

    const paint = (n: number) => {
      if (!have(n)) return false;
      try {
        const multi = activeLanes > 1;
        for (let i = 0; i < activeLanes; i++) {
          const frame = pipeline.get(n + i * stride)!;
          const main = mainRefs.current[i];
          const full = fullRefs.current[i];
          if (main) paintFrame(main, frame, multi ? 700 : 1000);
          if (full) paintFrame(full, frame, multi ? 900 : 1600);
        }
      } catch (error) {
        setQrError(error instanceof Error ? error.message : "QR rendering failed.");
        setPlaying(false);
        return false;
      }
      paintedRef.current = n;
      if (switchingRef.current) {
        switchingRef.current = false;
        window.setTimeout(() => setSwitching(null), 380);
      }
      return true;
    };

    const frameLoop = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(frameLoop);

      // A presenter canvas that mounted after the frame was painted needs catching up.
      for (let i = 0; i < activeLanes; i++) {
        const c = fullRefs.current[i] ?? mainRefs.current[i];
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
        const next = seqRef.current + step;
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
  }, [plan, playing, fps, loop, passLength, expanded, activeLanes, stride, step]);

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

  const ready = Boolean(plan);
  const tickRate = fps * step; // frames shown per second
  const passSeconds = passLength / tickRate;
  const inFirstPass = seq < passLength;
  const remainingSeconds = Math.max(0, (passLength - seq - step) / tickRate);
  const progress = !plan ? 0 : inFirstPass ? Math.min(100, ((seq + step) / passLength) * 100) : 100;
  const shownFrames = plan ? Math.min(totalData, Math.round(((seq + step) / passLength) * totalData)) : 0;
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
                disabled={picking}
                onClick={() => {
                  sfx.unlock();
                  setPicking(true);
                  const done = () => {
                    window.removeEventListener("focus", onFocus);
                    setPicking(false);
                  };
                  // The OS picker blurs the window; when focus returns without a change event the picker was cancelled.
                  const onFocus = () => window.setTimeout(done, 600);
                  window.addEventListener("focus", onFocus);
                  inputRef.current?.addEventListener("cancel", done, { once: true });
                  inputRef.current?.addEventListener("change", done, { once: true });
                  window.setTimeout(done, 60000);
                  inputRef.current?.click(); // must stay synchronous (iOS/Safari need the user gesture)
                }}
                className="group relative mt-7 flex items-center gap-2 overflow-hidden rounded-full bg-gradient-to-br from-primary to-accent px-8 py-4 text-sm font-bold text-primary-foreground shadow-xl shadow-primary/30 transition-transform duration-200 active:scale-95"
              >
                <span className="btn-sheen absolute inset-0" />
                {picking ? <Loader2 className="relative h-4 w-4 animate-spin" /> : <Upload className="relative h-4 w-4" />}
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
    <div className="relative flex h-full w-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <LaneGrid count={activeLanes} refs={mainRefs} live={playing} gap={8} switching={Boolean(switching)} />
        {(!qrReady || !ready) && !qrError && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm font-semibold text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            {busyLabel ?? "Building frames…"}
          </div>
        )}
        {ready && qrReady && (
          <button
            onClick={() => {
              setTapFlash(playing ? "pause" : "play");
              window.setTimeout(() => setTapFlash(null), 700);
              togglePlaying();
            }}
            className={cn(
              "group absolute inset-0 grid place-items-center rounded-[1.5rem] transition-opacity duration-300 focus-visible:opacity-100",
              !playing || tapFlash ? "opacity-100" : "opacity-0 hover:opacity-100",
              !playing ? "" : "bg-transparent",
            )}
            aria-label={playing ? "Pause" : "Play"}
          >
            <span
              className={cn(
                "grid h-16 w-16 place-items-center rounded-full bg-black/55 text-white shadow-xl backdrop-blur transition-all duration-300",
                !playing ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "",
                !playing && tapFlash ? "opacity-100" : "",
                playing && !tapFlash ? "scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100" : "",
              )}
            >
              <PlayPauseIcon playing={playing} className="h-7 w-7" />
            </span>
          </button>
        )}
        {switching && (
          <div className="switch-toast pointer-events-none absolute bottom-3 left-1/2 z-10 flex items-center gap-2 whitespace-nowrap rounded-full bg-black/65 px-3.5 py-1.5 text-[11px] font-bold text-white shadow-lg backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {switching}
          </div>
        )}
        {qrError && (
          <div
            role="alert"
            className="glass animate-pop-in absolute inset-x-0 top-2 z-10 mx-auto w-[min(100%,24rem)] rounded-2xl border border-destructive/40 p-2.5 text-center text-xs text-destructive"
          >
            {qrError}
          </div>
        )}
      </div>
      <div className="mx-auto mt-2 h-1.5 w-full max-w-md shrink-0 overflow-hidden rounded-full bg-secondary">
        <div
          className="progress-fill h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
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
      <PlayPauseIcon playing={playing} className="relative h-4 w-4" />
      <span className="relative">{playing ? "Pause" : "Play"}</span>
    </button>
  );
  const fullscreenButton = (
    <button
      type="button"
      onClick={toggleExpanded}
      disabled={!ready}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/30 transition-transform active:scale-90 disabled:opacity-50"
      aria-label="Fullscreen QR"
      title="Fullscreen QR (F)"
    >
      <SwapIcon on={expanded} a={<Expand className="h-4 w-4" />} b={<Minimize2 className="h-4 w-4" />} />
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
      <Repeat2
        className="h-4 w-4 transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{ transform: loop ? "rotate(180deg)" : "rotate(0deg)" }}
      />
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
    <GlideSegment
      ariaLabel="QR density"
      value={density}
      onChange={changeDensity}
      options={DENSITY_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
    />
  );
  const lanePicker = (
    <GlideSegment
      ariaLabel="QR codes per frame"
      value={lanes}
      onChange={(l) => {
        setLanes(l);
        paintedRef.current = -1;
        announceSwitch(`${l}× codes at once`);
        sfx.tick();
      }}
      options={LANE_OPTIONS}
    />
  );

  /** Phone/tablet controls: three tight rows, sized so the whole Send screen fits without scrolling. */
  const controlsCompact = (
    <div className="flex w-full shrink-0 flex-col gap-1.5 lg:hidden">
      <div className="flex items-center gap-2">
        {loopButton}
        {playButton}
        <button
          onClick={() => {
            setResetSpin((n) => n + 1);
            resetPlayback();
          }}
          className="glass grid h-11 w-11 shrink-0 place-items-center rounded-2xl transition-transform active:scale-90"
          aria-label="Reset"
        >
          <RotateCcw
            className="h-4 w-4 transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ transform: `rotate(${-360 * resetSpin}deg)` }}
          />
        </button>
        {fullscreenButton}
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
        {loopButton}
        {playButton}
        <button
          onClick={() => {
            setResetSpin((n) => n + 1);
            resetPlayback();
          }}
          className="glass flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold transition-transform active:scale-95"
        >
          <RotateCcw
            className="h-4 w-4 transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ transform: `rotate(${-360 * resetSpin}deg)` }}
          />
          Reset
        </button>
        {fullscreenButton}
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
      <div className="glass flex flex-col gap-2 rounded-3xl p-2.5">
        {densityPicker}
        <p className="px-1 text-center text-[11px] font-medium text-muted-foreground">
          {preset.hint} · {formatBytes(preset.chunk)}/code
        </p>
        <div className="flex items-center gap-2">
          <Layers3 className="ml-1 h-4 w-4 shrink-0 text-primary" />
          <span className="shrink-0 text-[11px] font-bold">QR codes at once</span>
          <div className="min-w-0 flex-1">{lanePicker}</div>
        </div>
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
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-4 pb-1 animate-fade-up md:px-8 lg:overflow-visible lg:px-10">
      <MediaViewer item={viewer} onClose={() => setViewer(null)} />

      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-2 lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)] lg:gap-8 lg:py-1">
        <div className="order-2 min-h-[8.5rem] flex-1 lg:order-1 lg:min-h-0">
          {stage}
        </div>
        <div className="order-1 flex shrink-0 flex-col gap-2 lg:order-2 lg:min-h-0 lg:shrink lg:gap-3 [@media(max-height:780px)]:lg:-m-3 [@media(max-height:780px)]:lg:overflow-y-auto [@media(max-height:780px)]:lg:p-3 no-scrollbar">
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
            className="presenter fixed inset-0 z-[90] grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-neutral-950 text-white [background-image:radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--color-primary)_28%,transparent),transparent)] landscape:grid-cols-[minmax(0,1fr)_19rem] landscape:grid-rows-[auto_minmax(0,1fr)] lg:landscape:grid-cols-[minmax(0,1fr)_24rem]"
            role="dialog"
            aria-modal="true"
            aria-label="Fullscreen QR"
          >
            {/* QR area: 1-8 codes, auto-arranged to be as large as the screen allows. */}
            <div className={cn("row-start-2 min-h-0 min-w-0 landscape:col-start-1 landscape:row-span-2 landscape:row-start-1", activeLanes > 1 ? "p-1.5 sm:p-4" : "p-3 sm:p-5")}>
              <LaneGrid count={activeLanes} refs={fullRefs} live={playing} gap={12} switching={Boolean(switching)} />
            </div>

            {/* Title block: preview, name and the key facts as chips. */}
            <header className="safe-top row-start-1 flex min-w-0 flex-col gap-2 px-4 pb-1 pt-3 landscape:col-start-2 landscape:row-start-1 landscape:pt-4 lg:px-5">
              <div className="flex items-center gap-3">
                <div className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white/10 ring-1 ring-white/15">
                  {thumb("h-full w-full")}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-extrabold leading-tight">{file.name}</p>
                  <p className="mt-0.5 truncate text-[11px] font-medium text-white/55">{file.type || "File"} · {bundleCount ? `${bundleCount} files` : "single file"}</p>
                </div>
                <button
                  onClick={toggleExpanded}
                  className="hud-card grid h-11 w-11 shrink-0 place-items-center rounded-full text-white transition-transform active:scale-90"
                  aria-label="Exit fullscreen"
                >
                  <Minimize2 className="h-5 w-5" />
                </button>
              </div>
              <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
                <PChip icon={<HardDrive className="h-3 w-3" />}>{formatBytes(file.size)}</PChip>
                <PChip icon={<Layers3 className="h-3 w-3" />}>{plan.total} frames</PChip>
                <PChip icon={<ZapIcon className="h-3 w-3" />}>{activeLanes}×{color ? "·RGB" : ""} · {fps} fps</PChip>
                <PChip icon={<Gauge className="h-3 w-3" />}>{preset.label}</PChip>
                {savedBytes > 0 && (
                  <span className="hidden sm:contents">
                    <PChip icon={<PackageOpen className="h-3 w-3" />} tone="good">
                      −{Math.round((savedBytes / file.size) * 100)}%
                    </PChip>
                  </span>
                )}
              </div>
            </header>

            {/* Details (large screens) + transport */}
            <footer className="safe-bottom row-start-3 flex min-w-0 flex-col gap-3 px-4 pb-4 pt-2 landscape:col-start-2 landscape:row-start-2 landscape:min-h-0 landscape:justify-end landscape:overflow-y-auto landscape:pb-5 lg:px-5 no-scrollbar">
              {/* Large screens: the exact preview plus a stats grid in the side space. */}
              <div className="hidden min-h-0 flex-1 overflow-hidden rounded-3xl bg-white/[0.06] ring-1 ring-white/10 lg:landscape:block">
                <div className="relative h-full min-h-[8rem]">
                  {preview && isImage ? (
                    <img src={preview} alt="" className="absolute inset-0 h-full w-full object-contain p-2" />
                  ) : preview && isVideo ? (
                    <video src={preview} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-contain p-2" />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center text-white/50">
                      {isAudio ? <Music2 className="h-12 w-12" /> : bundleCount ? <Files className="h-12 w-12" /> : <FileText className="h-12 w-12" />}
                    </span>
                  )}
                </div>
              </div>
              <div className="hidden grid-cols-2 gap-2 lg:landscape:grid">
                <PStat icon={<HardDrive className="h-3.5 w-3.5" />} label="Size" value={formatBytes(payloadBytes)} />
                <PStat icon={<Layers3 className="h-3.5 w-3.5" />} label="Frames" value={`${shownFrames}/${plan.total}`} />
                <PStat icon={<Timer className="h-3.5 w-3.5" />} label="Time left" value={inFirstPass ? formatDuration(remainingSeconds) : "Repair"} />
                <PStat icon={<Activity className="h-3.5 w-3.5" />} label="Rate" value={`${formatBytes(throughput)}/s`} />
              </div>

              <div className="hud-card min-w-0 rounded-3xl p-3.5">
                <div className="flex items-center gap-3">
                  <button
                    onClick={togglePlaying}
                    className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/40 transition-transform active:scale-90"
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    <PlayPauseIcon playing={playing} className="h-6 w-6" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-lg font-extrabold tabular-nums">{Math.floor(progress)}%</span>
                      <span className="truncate text-[11px] font-semibold text-white/70">
                        {inFirstPass ? `${formatDuration(remainingSeconds)} left` : "Repair frames"}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/15">
                      <div className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200" style={{ width: `${progress}%` }} />
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
                <div className="mt-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-white/80">
                    <span className="flex items-center gap-1.5">
                      <Layers3 className="h-3.5 w-3.5" /> QR codes at once
                    </span>
                    <span className="font-medium text-white/55">≈ {formatBytes(throughput)}/s</span>
                  </div>
                  <GlideSegment
                    ariaLabel="QR codes per frame"
                    tone="dark"
                    value={lanes}
                    options={LANE_OPTIONS}
                    onChange={(l) => {
                      setLanes(l);
                      paintedRef.current = -1;
                      announceSwitch(`${l}× codes at once`);
                      sfx.tick();
                    }}
                  />
                  <button
                    type="button"
                    onClick={toggleColor}
                    aria-pressed={color}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-2xl px-3 py-2 text-[11px] font-bold transition-all active:scale-[0.98]",
                      color ? "bg-gradient-to-r from-fuchsia-500/80 via-amber-400/80 to-cyan-400/80 text-white" : "bg-white/10 text-white/80",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <Palette className="h-3.5 w-3.5" /> Colour ×3 <span className="rounded bg-black/30 px-1 text-[9px]">BETA</span>
                    </span>
                    <span>{color ? "On" : "Off"}</span>
                  </button>
                  <GlideSegment
                    ariaLabel="QR density"
                    tone="dark"
                    value={density}
                    options={DENSITY_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
                    onChange={changeDensity}
                  />
                  <p className="text-center text-[10px] font-medium text-white/45">
                    More codes = faster, but the receiver camera must resolve all of them. Raise screen brightness.
                  </p>
                </div>
              </div>
            </footer>
          </div>
        </Portal>
      )}
    </div>
  );
}

/** Small pill used in the fullscreen header. */
function PChip({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: "good" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-bold",
        tone === "good" ? "bg-emerald-400/20 text-emerald-300" : "bg-white/10 text-white/80",
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function PStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-white/[0.07] px-3 py-2.5 ring-1 ring-white/10">
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-white/50">
        {icon}
        {label}
      </span>
      <span className="mt-0.5 block truncate text-sm font-extrabold tabular-nums">{value}</span>
    </div>
  );
}
