import { useEffect, useRef, useState, type CSSProperties } from "react";
import QRCode from "qrcode";
import { Upload, Play, Pause, RotateCcw, ImageIcon, X, Music2, Film } from "lucide-react";
import { fileToChunks } from "@/lib/qr-protocol";
import { cn } from "@/lib/utils";

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const whole = Math.ceil(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return mins ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;
}

export function Sender() {
  const [file, setFile] = useState<File | null>(null);
  const [chunks, setChunks] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(30);
  const [preview, setPreview] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(f: File) {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setIdx(0);
    setPlaying(false);
    setPreview(URL.createObjectURL(f));
    const { chunks } = await fileToChunks(f);
    setChunks(chunks);
  }

  // Render current QR
  useEffect(() => {
    if (!canvasRef.current || chunks.length === 0) return;
    QRCode.toCanvas(canvasRef.current, chunks[idx], {
      errorCorrectionLevel: "L",
      margin: 1,
      width: 520,
      color: { dark: "#0a0a14", light: "#ffffff" },
    }).catch(() => {});
  }, [idx, chunks]);

  // Animate
  useEffect(() => {
    if (!playing || chunks.length === 0) return;
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % chunks.length);
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [playing, fps, chunks.length]);

  function reset() {
    setFile(null);
    setChunks([]);
    setIdx(0);
    setPlaying(false);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const cycleSeconds = chunks.length / fps;
  const remainingSeconds = chunks.length ? Math.max(0, (chunks.length - idx - 1) / fps) : 0;
  const progress = chunks.length ? ((idx + 1) / chunks.length) * 100 : 0;

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
      <div className="glass relative mb-3 flex items-center gap-3 overflow-hidden rounded-2xl p-3">
        <div className="edge-progress" style={{ "--p": `${progress}%` } as CSSProperties} />
        {preview && file.type.startsWith("image/") ? (
          <img src={preview} alt="" className="h-12 w-12 rounded-lg object-cover" />
        ) : file.type.startsWith("video/") ? (
          <div className="grid h-12 w-12 place-items-center rounded-lg bg-secondary">
            <Film className="h-5 w-5" />
          </div>
        ) : file.type.startsWith("audio/") ? (
          <div className="grid h-12 w-12 place-items-center rounded-lg bg-secondary">
            <Music2 className="h-5 w-5" />
          </div>
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-lg bg-secondary">
            <ImageIcon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{file.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {(file.size / 1024).toFixed(1)} KB · {chunks.length} frames ·{" "}
            {playing ? `${formatDuration(remainingSeconds)} left` : `${formatDuration(cycleSeconds)} capture`}
          </div>
        </div>
        <button
          onClick={reset}
          className="glass grid h-9 w-9 shrink-0 place-items-center rounded-full text-foreground active:scale-95"
          aria-label="Remove file"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="glass-strong relative mx-auto flex aspect-square w-full max-w-sm items-center justify-center overflow-hidden rounded-[2rem] p-4">
        <canvas ref={canvasRef} className="h-full w-full" />
        <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
          {chunks.length ? `${idx + 1} / ${chunks.length}` : ""}
        </div>
      </div>

      <div className="mt-3 mx-auto flex w-full max-w-md items-center justify-center gap-2">
        <button
          onClick={() => setPlaying((p) => !p)}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold transition-all active:scale-[0.97]",
            playing
              ? "glass text-foreground"
              : "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/30",
          )}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => {
            setIdx(0);
            setPlaying(false);
          }}
          className="glass flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold active:scale-95"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
      </div>

      <div className="glass mt-3 mx-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-4 py-3">
        <span className="text-xs font-bold text-muted-foreground">Speed</span>
        <input
          type="range"
          min={2}
          max={60}
          value={fps}
          onChange={(e) => setFps(+e.target.value)}
          className="ios-range flex-1"
        />
        <span className="w-10 text-right text-xs font-semibold tabular-nums">{fps} fps</span>
      </div>
    </div>
  );
}
