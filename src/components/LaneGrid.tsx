import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * Best (cols, tile size) for `count` squares in w x h.
 * Candidates are scored by tile size, nudged toward near-square grids (3x3, 4x3, 2x3 ...) and
 * away from layouts with empty cells, so 9 becomes 3x3 and 12 becomes 4x3 / 3x4 whenever sensible.
 */
function bestLayout(count: number, w: number, h: number, gap: number) {
  let best = { cols: 1, size: 0, score: -1 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const size = Math.min((w - gap * (cols - 1)) / cols, (h - gap * (rows - 1)) / rows);
    if (size <= 0) continue;
    const squareness = Math.pow(Math.min(cols, rows) / Math.max(cols, rows), 0.35);
    const emptyPenalty = cols * rows === count ? 1 : 0.72;
    const score = size * squareness * emptyPenalty;
    if (score > best.score) best = { cols, size, score };
  }
  return { cols: best.cols, size: Math.max(0, Math.floor(best.size)) };
}

/**
 * Shows `count` QR tiles (white squares holding a canvas each), automatically arranged
 * in whatever grid makes them as large as possible for the space available.
 * Canvases are exposed through `refs` so the playback loop can paint into them.
 *
 * Small tiles get NO extra padding and only a tiny corner radius: every bitmap already
 * carries a 4-module quiet zone, and rounding/padding that eats into it cuts off the
 * finder patterns (the "QR is cut off" bug on phones with many codes).
 */
export function LaneGrid({
  count,
  refs,
  gap = 10,
  live = false,
  switching = false,
  className,
  tileClassName,
}: {
  count: number;
  refs: MutableRefObject<Array<HTMLCanvasElement | null>>;
  gap?: number;
  live?: boolean;
  switching?: boolean;
  className?: string;
  tileClassName?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ cols: 1, size: 0 });
  const g = count > 1 ? Math.min(gap, 6) : gap;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setLayout(bestLayout(count, w, h, g));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, g]);

  const multi = count > 1;
  const pad = multi ? 0 : Math.round(Math.min(8, layout.size * 0.02));
  const radius = Math.round(Math.min(20, Math.max(multi ? 3 : 8, layout.size * (multi ? 0.03 : 0.06))));

  return (
    <div ref={wrapRef} className={cn("relative flex h-full w-full items-center justify-center", className)}>
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, ${layout.size}px)`,
          gap: g,
          visibility: layout.size > 0 ? "visible" : "hidden",
        }}
      >
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            onContextMenu={(e) => e.preventDefault()}
            style={{ width: layout.size, height: layout.size, padding: pad, borderRadius: radius }}
            className={cn(
              "lane-pop lane-anim relative bg-white",
              multi ? "shadow-md" : "shadow-xl",
              live && "qr-stage-live",
              switching && "lane-switching",
              tileClassName,
            )}
          >
            <canvas
              ref={(el) => {
                refs.current[i] = el;
              }}
              style={{ borderRadius: Math.max(0, radius - pad) }}
              className="h-full w-full select-none object-contain [image-rendering:pixelated]"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
