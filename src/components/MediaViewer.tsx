import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Download, FileText, Music2, Share2, X, ZoomIn } from "lucide-react";
import { Portal } from "@/components/Portal";
import { formatBytes } from "@/lib/qr-protocol";
import { sfx } from "@/lib/feedback";

export interface ViewerItem {
  url: string;
  name: string;
  mime: string;
  size: number;
  blob?: Blob | null;
}

const MAX_SCALE = 6;

/**
 * Full-screen viewer for received/sent files.
 * Images: pinch, double-tap, wheel-zoom, pan, drag-down-to-dismiss.
 * Video/audio: native controls, autoplay. Other files: info card + open/download.
 */
export function MediaViewer({ item, onClose }: { item: ViewerItem | null; onClose: () => void }) {
  const [shown, setShown] = useState<ViewerItem | null>(item);
  const [closing, setClosing] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startDist: number;
    startScale: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dismissing: boolean;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef({ t: 0, x: 0, y: 0 });

  // Keep rendering the old item while the close animation runs.
  useEffect(() => {
    if (item) {
      setShown(item);
      setClosing(false);
      view.current = { scale: 1, x: 0, y: 0 };
      setZoomed(false);
      sfx.open();
    }
  }, [item]);

  function requestClose() {
    if (closing) return;
    sfx.close();
    setClosing(true);
    window.setTimeout(() => {
      onClose();
      setClosing(false);
      setShown(null);
    }, 240);
  }

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, closing]);

  function apply(animate = false) {
    const img = imgRef.current;
    if (!img) return;
    const { scale, x, y } = view.current;
    img.style.transition = animate ? "transform 320ms cubic-bezier(0.22,1,0.36,1)" : "none";
    img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    setZoomed(scale > 1.02);
  }

  function clampPan() {
    const img = imgRef.current;
    if (!img) return;
    const v = view.current;
    const w = img.clientWidth * v.scale;
    const h = img.clientHeight * v.scale;
    const maxX = Math.max(0, (w - window.innerWidth) / 2);
    const maxY = Math.max(0, (h - window.innerHeight) / 2);
    v.x = Math.max(-maxX, Math.min(maxX, v.x));
    v.y = Math.max(-maxY, Math.min(maxY, v.y));
  }

  function zoomAt(nextScale: number, cx: number, cy: number, animate = true) {
    const v = view.current;
    const s = Math.max(1, Math.min(MAX_SCALE, nextScale));
    const ox = cx - window.innerWidth / 2;
    const oy = cy - window.innerHeight / 2;
    const ratio = s / v.scale;
    v.x = ox - (ox - v.x) * ratio;
    v.y = oy - (oy - v.y) * ratio;
    v.scale = s;
    if (s === 1) {
      v.x = 0;
      v.y = 0;
    }
    clampPan();
    apply(animate);
  }

  function onPointerDown(e: ReactPointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const v = view.current;
    gesture.current = {
      startDist: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
      startScale: v.scale,
      startX: e.clientX,
      startY: e.clientY,
      originX: v.x,
      originY: v.y,
      dismissing: false,
      moved: false,
    };
  }

  function onPointerMove(e: ReactPointerEvent) {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const v = view.current;
    if (pts.length >= 2 && g.startDist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      zoomAt(g.startScale * (dist / g.startDist), cx, cy, false);
      g.moved = true;
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (v.scale > 1.02) {
      v.x = g.originX + dx;
      v.y = g.originY + dy;
      clampPan();
      apply(false);
    } else if (g.moved && (g.dismissing || Math.abs(dy) > Math.abs(dx))) {
      g.dismissing = true;
      v.y = dy;
      v.x = dx * 0.4;
      apply(false);
      if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0.25, 1 - Math.abs(dy) / 420));
    }
  }

  function onPointerUp(e: ReactPointerEvent) {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (!g) return;
    const v = view.current;
    if (pointers.current.size > 0) {
      // Pinch ended with one finger left: restart pan from here.
      const [p] = [...pointers.current.values()];
      gesture.current = { ...g, startDist: 0, startX: p.x, startY: p.y, originX: v.x, originY: v.y, startScale: v.scale };
      return;
    }
    gesture.current = null;
    if (g.dismissing) {
      if (Math.abs(v.y) > 110) {
        requestClose();
      } else {
        v.x = 0;
        v.y = 0;
        apply(true);
        if (backdropRef.current) backdropRef.current.style.opacity = "1";
      }
      return;
    }
    if (!g.moved) {
      const now = performance.now();
      const dtap = now - lastTap.current.t;
      if (dtap < 300 && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 40) {
        zoomAt(v.scale > 1.05 ? 1 : 2.6, e.clientX, e.clientY);
        lastTap.current.t = 0;
      } else {
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
    if (v.scale < 1) {
      v.scale = 1;
      v.x = 0;
      v.y = 0;
      apply(true);
    }
  }

  function onWheel(e: ReactWheelEvent) {
    const v = view.current;
    zoomAt(v.scale * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY, false);
  }

  async function share() {
    if (!shown?.blob) return;
    try {
      const file = new File([shown.blob], shown.name, { type: shown.mime });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: shown.name });
      else download();
    } catch {
      /* cancelled */
    }
  }

  function download() {
    if (!shown) return;
    const a = document.createElement("a");
    a.href = shown.url;
    a.download = shown.name || "offdrop-file";
    a.click();
  }

  if (!shown) return null;
  const isImage = shown.mime.startsWith("image/");
  const isVideo = shown.mime.startsWith("video/");
  const isAudio = shown.mime.startsWith("audio/");

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[100] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={shown.name}
        style={{ animation: closing ? "viewer-out 240ms ease forwards" : "viewer-in 360ms cubic-bezier(0.22,1,0.36,1) both" }}
      >
        <div ref={backdropRef} className="absolute inset-0 bg-black/90 backdrop-blur-2xl transition-opacity" />

        <header className="safe-top relative z-10 flex items-center gap-3 px-4 pb-2 text-white">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold">{shown.name}</p>
            <p className="text-[11px] text-white/60">
              {formatBytes(shown.size)} · {shown.mime || "file"}
            </p>
          </div>
          <button
            onClick={requestClose}
            aria-label="Close viewer"
            className="grid h-10 w-10 place-items-center rounded-full bg-white/12 backdrop-blur transition-transform active:scale-90"
          >
            <X className="h-5 w-5" strokeWidth={2.4} />
          </button>
        </header>

        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          {isImage ? (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              data-no-swipe
            >
              <img
                ref={imgRef}
                src={shown.url}
                alt={shown.name}
                draggable={false}
                className="max-h-full max-w-full select-none object-contain will-change-transform"
              />
            </div>
          ) : isVideo ? (
            <video
              src={shown.url}
              controls
              autoPlay
              playsInline
              className="max-h-full max-w-full rounded-lg bg-black object-contain shadow-2xl"
            />
          ) : isAudio ? (
            <div className="flex w-full max-w-md flex-col items-center gap-6 px-6">
              <div className="viewer-orb grid h-40 w-40 place-items-center rounded-full bg-gradient-to-br from-primary to-accent shadow-2xl shadow-primary/40">
                <Music2 className="h-16 w-16 text-white" strokeWidth={1.6} />
              </div>
              <audio src={shown.url} controls autoPlay className="w-full" />
            </div>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center text-white">
              <div className="grid h-24 w-24 place-items-center rounded-3xl bg-white/10">
                <FileText className="h-12 w-12" strokeWidth={1.5} />
              </div>
              <p className="text-sm text-white/70">No inline preview for this file type. Open or save it below.</p>
              <button
                onClick={() => window.open(shown.url, "_blank", "noopener")}
                className="rounded-2xl bg-white/15 px-5 py-2.5 text-sm font-semibold backdrop-blur active:scale-95"
              >
                Open in browser
              </button>
            </div>
          )}
          {isImage && !zoomed && (
            <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[10px] font-semibold text-white/70 backdrop-blur">
              <ZoomIn className="h-3 w-3" /> Double-tap or pinch to zoom
            </div>
          )}
        </div>

        <footer className="safe-bottom relative z-10 flex items-center justify-center gap-3 px-4 pt-3">
          {shown.blob && (
            <button
              onClick={() => void share()}
              className="flex items-center gap-2 rounded-2xl bg-white/12 px-5 py-3 text-sm font-semibold text-white backdrop-blur transition-transform active:scale-95"
            >
              <Share2 className="h-4 w-4" /> Share
            </button>
          )}
          <button
            onClick={download}
            className="flex items-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent px-5 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform active:scale-95"
          >
            <Download className="h-4 w-4" /> Save
          </button>
        </footer>
      </div>
    </Portal>
  );
}
