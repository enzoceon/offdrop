import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Upload, Play, Pause, RotateCcw, ImageIcon, X, Music2, Film } from "lucide-react";
import { fileToChunks } from "@/lib/qr-protocol";
import { cn } from "@/lib/utils";

export function Sender() {
  const [file, setFile] = useState<File | null>(null);
  const [chunks, setChunks] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(12);
  const [preview, setPreview] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(f: File) {
    setFile(f);
    setIdx(0);
    setPlaying(false);
    setPreview(URL.createObjectURL(f));
    const { chunks } = await fileToChunks(f);
    setChunks(chunks);
    setPlaying(true);
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
        <p className="mt-6 text-[11px] text-muted-foreground">
          Keep the receiving camera steady until it reaches 100%.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col px-5 pb-2 animate-fade-up">
      <div className="glass mb-3 flex items-center gap-3 rounded-2xl p-3">
        {preview && file.type.startsWith("image/") ? (
          <img src={preview} alt="" className="h-12 w-12 rounded-xl object-cover" />
        ) : file.type.startsWith("video/") ? (
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-secondary">
            <Film className="h-5 w-5" />
          </div>
        ) : file.type.startsWith("audio/") ? (
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-secondary">
            <Music2 className="h-5 w-5" />
          </div>
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-secondary">
            <ImageIcon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{file.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {(file.size / 1024).toFixed(1)} KB · {chunks.length} frames
          </div>
        </div>
        <button
          onClick={reset}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary"
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

      <div className="mt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all"
            style={{ width: `${chunks.length ? ((idx + 1) / chunks.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          onClick={() => setPlaying((p) => !p)}
          className={cn(
            "flex w-full max-w-[17rem] items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold transition-all active:scale-[0.97]",
            playing
              ? "glass text-foreground"
              : "bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-lg shadow-primary/30",
          )}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => setIdx(0)}
          className="glass grid h-12 w-12 place-items-center rounded-2xl active:scale-95"
        >
          <RotateCcw className="h-4 w-4" />
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
