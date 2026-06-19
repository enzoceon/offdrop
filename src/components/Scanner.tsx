import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Camera, CameraOff, CheckCircle2, Loader2, ScanLine } from "lucide-react";
import {
  parseChunkPayload,
  transferComplete,
  assembleTransfer,
  type Transfer,
} from "@/lib/qr-protocol";
import { saveItem } from "@/lib/history";

export function Scanner({ onSaved }: { onSaved: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const transferRef = useRef<Transfer | null>(null);
  const lastPayloadRef = useRef<string>("");
  const finishingRef = useRef(false);

  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ have: 0, total: 0 });
  const [done, setDone] = useState<{ name: string } | null>(null);

  async function start() {
    setError(null);
    setDone(null);
    transferRef.current = null;
    finishingRef.current = false;
    setProgress({ have: 0, total: 0 });
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
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setActive(true);
      tick();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Camera unavailable. Grant camera permission and retry.",
      );
    }
  }

  function stop() {
    setActive(false);
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function tick() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
        if (code?.data) handleScan(code.data);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function handleScan(payload: string) {
    if (finishingRef.current || payload === lastPayloadRef.current) return;
    lastPayloadRef.current = payload;
    const parsed = parseChunkPayload(payload);
    if (!parsed) return;
    const { meta, data } = parsed;
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
    }
    if (!t.chunks.has(meta.n)) {
      t.chunks.set(meta.n, data);
      setProgress({ have: t.chunks.size, total: t.total });
      if (navigator.vibrate) navigator.vibrate(8);
    }
    if (transferComplete(t)) finish();
  }

  async function finish() {
    const t = transferRef.current;
    if (!t || finishingRef.current) return;
    finishingRef.current = true;
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
    setProgress({ have: 0, total: 0 });
    onSaved();
    stop();
    finishingRef.current = false;
  }

  useEffect(() => () => stop(), []);

  const pct = progress.total ? (progress.have / progress.total) * 100 : 0;

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
          <div className="flex flex-col items-center px-6 text-center">
            <div className="relative mb-4">
              <span className="absolute inset-0 rounded-full bg-primary/40 animate-pulse-ring" />
              <div className="relative grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40">
                <ScanLine className="h-8 w-8 text-primary-foreground" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">Aim at the OFFDROP QR stream</p>
          </div>
        )}

        {done && (
          <div className="flex flex-col items-center text-center animate-fade-up">
            <CheckCircle2 className="h-16 w-16 text-primary" strokeWidth={1.8} />
            <p className="mt-3 text-display text-xl">Received</p>
            <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">{done.name}</p>
          </div>
        )}

        {/* Reticle */}
        {active && (
          <>
            <div className="pointer-events-none absolute inset-6 rounded-[1.5rem] border-2 border-primary/80 shadow-[0_0_0_9999px_oklch(0_0_0/0.22)]" />
            <div className="scan-sweep pointer-events-none absolute left-8 right-8 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent" />
          </>
        )}
      </div>

      {progress.total > 0 && (
        <div className="glass mt-3 rounded-2xl p-3 animate-fade-up">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="font-medium">Receiving…</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {progress.have} / {progress.total}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="glass mt-3 rounded-2xl border border-destructive/40 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="mt-3 flex justify-center gap-2">
        {!active ? (
          <button
            onClick={start}
            className="flex w-full max-w-[17rem] items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent py-3.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 active:scale-[0.97]"
          >
            <Camera className="h-4 w-4" />
            Start camera
          </button>
        ) : (
          <button
            onClick={stop}
            className="glass flex w-full max-w-[17rem] items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold active:scale-[0.97]"
          >
            <CameraOff className="h-4 w-4" />
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
