import { useEffect, useRef, useState } from "react";
import { createClientOnlyFn } from "@tanstack/react-start";
import QRCode from "qrcode";
import jsQR from "jsqr";
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
} from "lucide-react";
import { type Slot } from "@/lib/qr-protocol";
import { saveItem } from "@/lib/history";
import { sfx } from "@/lib/feedback";
import { cn } from "@/lib/utils";

type SpeedTier = "Gentle" | "Normal" | "Fast" | "Turbo";

const TIER_RANGES: { tier: SpeedTier; min: number; max: number; span: number }[] = [
  { tier: "Gentle", min: 1, max: 2, span: 2 },
  { tier: "Normal", min: 3, max: 5, span: 3 },
  { tier: "Fast", min: 6, max: 8, span: 3 },
  { tier: "Turbo", min: 9, max: 10, span: 2 },
];

function tierForFps(fps: number): SpeedTier {
  return TIER_RANGES.find((t) => fps >= t.min && fps <= t.max)?.tier ?? "Normal";
}

const planTransferOnClient = createClientOnlyFn(async (file: File, bytes: Uint8Array) => {
  const { planTransferInWorker } = await import("@/lib/transfer-planner.client");
  return planTransferInWorker(file, bytes);
});

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const whole = Math.ceil(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return mins ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;
}

export function Sender({ active = true }: { active?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [totalData, setTotalData] = useState(0);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(5);
  const [loop, setLoop] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [mediaTime, setMediaTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const audioPreviewRef = useRef<HTMLAudioElement>(null);

  // Back-compat alias for the rest of the component.
  const chunks = slots;

  async function onPick(f: File) {
    try {
      if (preview) URL.revokeObjectURL(preview);
      setFile(f);
      setSlots([]);
      setTotalData(0);
      setIdx(0);
      setPlaying(false);
      setQrError(null);
      setQrImage(null);
      setPreview(URL.createObjectURL(f));
      setPreviewOpen(false);
      const buf = new Uint8Array(await f.arrayBuffer());
      const planned = await planTransferOnClient(f, buf);
      setTotalData(planned.totalData);
      setSlots(planned.slots);
      sfx.fileFound();
      void saveItem({
        id: planned.id + "-sent-" + Date.now(),
        filename: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
        receivedAt: Date.now(),
        direction: "sent",
        valid: true,
        blob: f,
      });
    } catch (error) {
      setQrError(error instanceof Error ? error.message : "This file could not be prepared.");
      setPlaying(false);
      sfx.error();
    }
  }

  // Render current QR
  useEffect(() => {
    if (chunks.length === 0) return;
    setQrError(null);
    const canvas = document.createElement("canvas");
    const text = chunks[idx]?.text ?? "";
    if (!text) return;
    QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: "M",
      version: 20,
      margin: 2,
      width: 720,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(() => {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("QR verification canvas is unavailable.");
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const verified = jsQR(image.data, canvas.width, canvas.height, {
          inversionAttempts: "attemptBoth",
        });
        if (verified?.data !== text) throw new Error("Generated QR failed verification.");
        setQrImage(canvas.toDataURL("image/png"));
      })
      .catch((err) => {
        console.error("QR generation failed:", err);
        setQrError("This QR frame could not be generated cleanly. Try a smaller file or reset the stream.");
        setPlaying(false);
      });
  }, [idx, chunks]);

  // Animate
  useEffect(() => {
    if (!playing || chunks.length === 0) return;
    const id = setInterval(() => {
      setIdx((i) => {
        if (i < chunks.length - 1) return i + 1;
        if (loop) return 0;
        setPlaying(false);
        return i;
      });
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [playing, fps, loop, chunks.length]);

  function removeFile() {
    setFile(null);
    setSlots([]);
    setTotalData(0);
    setIdx(0);
    setPlaying(false);
    setPreviewOpen(false);
    setMediaPlaying(false);
    setMediaTime(0);
    setMediaDuration(0);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function resetPlayback() {
    setIdx(0);
    setPlaying(false);
    sfx.reset();
  }

  function togglePlaying() {
    setPlaying((p) => {
      const next = !p;
      if (next) sfx.start();
      else sfx.pause();
      return next;
    });
  }

  function toggleLoop() {
    setLoop((value) => {
      const next = !value;
      if (next) sfx.toggleOn();
      else sfx.toggleOff();
      return next;
    });
  }

  function handleFpsChange(next: number) {
    setFps((prev) => {
      if (prev === next) return prev;
      const prevTier = tierForFps(prev);
      const nextTier = tierForFps(next);
      if (prevTier !== nextTier) sfx.speedTier(nextTier);
      else sfx.tick();
      return next;
    });
  }


  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  useEffect(() => {
    if (!active && previewOpen) closePreview();
  }, [active, previewOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (event.code === "Space") {
        event.preventDefault();
        if (chunks.length) togglePlaying();
      }
      if (event.key.toLowerCase() === "r") resetPlayback();
      if (event.key.toLowerCase() === "l") toggleLoop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const cycleSeconds = chunks.length / fps;
  const remainingSeconds = chunks.length ? Math.max(0, (chunks.length - idx - 1) / fps) : 0;
  const currentDataIndex =
    chunks[idx]?.dataIndex ??
    (() => {
      // Hold the most recent data position for header slots.
      for (let i = idx; i >= 0; i--) {
        if (chunks[i]?.dataIndex != null) return chunks[i].dataIndex!;
      }
      return 0;
    })();
  const progress = totalData ? ((currentDataIndex + 1) / totalData) * 100 : 0;
  const canOpenPreview = Boolean(preview && file?.type.match(/^(image|video|audio)\//));

  function activePreviewMedia() {
    return videoPreviewRef.current ?? audioPreviewRef.current;
  }

  function syncPreviewMedia(media: HTMLMediaElement) {
    setMediaTime(media.currentTime || 0);
    setMediaDuration(Number.isFinite(media.duration) ? media.duration : 0);
    setMediaPlaying(!media.paused);
  }

  async function togglePreviewPlayback() {
    const media = activePreviewMedia();
    if (!media) return;
    if (media.paused) {
      await media.play();
    } else {
      media.pause();
    }
    syncPreviewMedia(media);
  }

  function seekPreview(value: number) {
    const media = activePreviewMedia();
    if (!media) return;
    media.currentTime = value;
    syncPreviewMedia(media);
  }

  function closePreview() {
    activePreviewMedia()?.pause();
    setMediaPlaying(false);
    setPreviewOpen(false);
  }

  if (!file) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-5">
        <div className="animate-float mb-8 grid h-28 w-28 place-items-center rounded-[2rem] bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40">
          <Upload className="h-12 w-12 text-primary-foreground" strokeWidth={2} />
        </div>
        <h2 className="text-display text-3xl">Drop a file</h2>
        <p className="mt-2 max-w-xs text-center text-sm text-muted-foreground">
          Photos, videos, audio, documents — OFFDROP turns them into a private QR stream.
        </p>
        <button
          onClick={() => inputRef.current?.click()}
          className="mt-8 flex items-center gap-2 rounded-full bg-gradient-to-br from-primary to-accent px-7 py-3.5 text-sm font-semibold text-primary-foreground shadow-xl shadow-primary/30 transition-transform active:scale-95"
        >
          <Upload className="h-4 w-4" />
          Choose file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*,audio/*,*/*"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
        />
        <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground">
          <span className="block">Keep the receiving camera steady.</span>
          <span className="block">Until it reaches 100%.</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col px-5 pb-2 animate-fade-up">
      <div className="glass mx-auto mb-3 flex w-full max-w-md items-center gap-3 rounded-2xl p-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {preview && file.type.startsWith("image/") ? (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="h-14 w-14 shrink-0 overflow-hidden rounded-lg shadow-sm transition-transform active:scale-95"
              aria-label="Open image preview"
            >
              <img src={preview} alt={file.name} className="h-full w-full object-cover" />
            </button>
          ) : preview && file.type.startsWith("video/") ? (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-secondary shadow-sm transition-transform active:scale-95"
              aria-label="Open video preview"
            >
              <video src={preview} muted playsInline className="h-full w-full object-cover" />
            </button>
          ) : preview && file.type.startsWith("audio/") ? (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="audio-tile grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg shadow-sm transition-transform active:scale-95"
              aria-label="Open audio preview"
            >
              <Music2 className="h-5 w-5" />
            </button>
          ) : (
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-secondary shadow-sm">
              {file.type.startsWith("audio/") ? (
                <Music2 className="h-5 w-5" />
              ) : (
                <FileText className="h-5 w-5" />
              )}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-bold leading-tight">
              <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate">{file.name}</span>
            </h3>
            <div className="mt-1 grid grid-cols-[auto_auto] items-center justify-start gap-x-3 gap-y-1 text-[10px] font-medium text-muted-foreground">
              <span className="flex items-center gap-1">
                <HardDrive className="h-3 w-3 text-primary" />
                {formatBytes(file.size)}
              </span>
              <span className="flex items-center gap-1">
                <Layers3 className="h-3 w-3 text-primary" />
                {playing && totalData ? `${currentDataIndex + 1} / ${totalData}` : totalData} frames
              </span>
              <span className="col-span-2 flex items-center gap-1">
                <Clock className="h-3 w-3 text-primary" />
                {playing
                  ? `${formatDuration(remainingSeconds)} left`
                  : `${formatDuration(cycleSeconds)} capture`}
              </span>
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
      </div>

      <div className="glass-strong relative mx-auto flex aspect-square w-full max-w-sm items-center justify-center overflow-hidden rounded-lg p-4">
        {qrImage && chunks.length > 0 && (
          <img src={qrImage} alt="OFFDROP transfer QR frame" className="h-full w-full object-contain" />
        )}
        {(!qrImage || chunks.length === 0) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm font-medium text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            Loading…
          </div>
        )}
      </div>

      <div className="mx-auto mt-2 h-2.5 w-full max-w-sm overflow-hidden rounded-full bg-secondary p-[1px]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {qrError && (
        <div className="glass mx-auto mt-3 w-full max-w-sm rounded-2xl border border-destructive/40 p-3 text-center text-xs text-destructive">
          {qrError}
        </div>
      )}

      <div className="mt-3 mx-auto flex w-full max-w-md items-center justify-center gap-2">
        <button
          onClick={togglePlaying}
          disabled={chunks.length === 0}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold transition-all active:scale-[0.97] disabled:opacity-60",
            playing
              ? "glass text-foreground"
              : "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/30",
          )}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={toggleLoop}
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-2xl transition-all active:scale-95",
            loop ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30" : "glass text-muted-foreground",
          )}
          aria-label={loop ? "Loop on" : "Loop off"}
          aria-pressed={loop}
        >
          <Repeat2 className="h-4 w-4" />
        </button>
        <button
          onClick={resetPlayback}
          className="glass flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold active:scale-95"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
      </div>

      <div className="glass mt-3 mx-auto w-full max-w-md rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Speed
          </span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={fps}
            onChange={(e) => handleFpsChange(Number(e.target.value))}
            className="ios-range flex-1"
            aria-label="Transfer speed"
          />
          <span className="min-w-[3.2rem] text-right text-[11px] font-bold uppercase tracking-wider text-primary">
            {tierForFps(fps)}
          </span>
        </div>
      </div>


      {previewOpen && preview && canOpenPreview && (
        <div
          className="fixed inset-0 z-[80] bg-background/45 backdrop-blur-[56px] animate-fade-up"
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-background/20" />
          <div className="absolute inset-0 flex items-center justify-center px-4 py-20 sm:px-8">
            {file.type.startsWith("image/") && (
              <img
                src={preview}
                alt={file.name}
                className="block max-h-[calc(100dvh-6rem)] max-w-[calc(100vw-2rem)] rounded-xl object-contain shadow-2xl shadow-foreground/20"
              />
            )}

            {file.type.startsWith("video/") && (
              <div className="glass-strong flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl p-2">
                <video
                  ref={videoPreviewRef}
                  src={preview}
                  playsInline
                  className="max-h-[calc(100dvh-15rem)] w-full rounded-lg object-contain"
                  onLoadedMetadata={(event) => syncPreviewMedia(event.currentTarget)}
                  onTimeUpdate={(event) => syncPreviewMedia(event.currentTarget)}
                  onPlay={(event) => syncPreviewMedia(event.currentTarget)}
                  onPause={(event) => syncPreviewMedia(event.currentTarget)}
                />
                <div className="flex items-center gap-3 px-2 py-3">
                  <button
                    type="button"
                    onClick={() => void togglePreviewPlayback()}
                    className="glass grid h-11 w-11 shrink-0 place-items-center rounded-full active:scale-90"
                    aria-label={mediaPlaying ? "Pause video" : "Play video"}
                  >
                    {mediaPlaying ? (
                      <Pause className="h-4.5 w-4.5" />
                    ) : (
                      <Play className="h-4.5 w-4.5" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={mediaDuration || 0}
                    step="0.1"
                    value={Math.min(mediaTime, mediaDuration || 0)}
                    onChange={(event) => seekPreview(Number(event.target.value))}
                    className="ios-range flex-1"
                  />
                  <span className="w-20 text-right text-[10px] font-semibold tabular-nums text-muted-foreground">
                    {formatDuration(mediaTime)} / {formatDuration(mediaDuration)}
                  </span>
                </div>
              </div>
            )}

            {file.type.startsWith("audio/") && (
              <div className="glass-strong w-full max-w-md rounded-xl p-5">
                <div className="audio-tile mx-auto grid h-20 w-20 place-items-center rounded-lg shadow-xl">
                  <Music2 className="h-8 w-8 text-primary" />
                </div>
                <p className="mt-4 truncate text-center text-sm font-bold">{file.name}</p>
                <audio
                  ref={audioPreviewRef}
                  src={preview}
                  onLoadedMetadata={(event) => syncPreviewMedia(event.currentTarget)}
                  onTimeUpdate={(event) => syncPreviewMedia(event.currentTarget)}
                  onPlay={(event) => syncPreviewMedia(event.currentTarget)}
                  onPause={(event) => syncPreviewMedia(event.currentTarget)}
                />
                <div className="mt-5 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void togglePreviewPlayback()}
                    className="glass grid h-12 w-12 shrink-0 place-items-center rounded-full active:scale-90"
                    aria-label={mediaPlaying ? "Pause audio" : "Play audio"}
                  >
                    {mediaPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={mediaDuration || 0}
                    step="0.1"
                    value={Math.min(mediaTime, mediaDuration || 0)}
                    onChange={(event) => seekPreview(Number(event.target.value))}
                    className="ios-range flex-1"
                  />
                </div>
                <div className="mt-1 flex justify-between text-[10px] font-semibold tabular-nums text-muted-foreground">
                  <span>{formatDuration(mediaTime)}</span>
                  <span>{formatDuration(mediaDuration)}</span>
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={closePreview}
            className="glass absolute right-3 z-[81] grid h-9 w-9 place-items-center rounded-full text-foreground active:scale-90 sm:right-4 sm:h-10 sm:w-10"
            style={{ top: "max(env(safe-area-inset-top), 0.75rem)" }}
            aria-label="Close preview"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  );
}
