import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { cn } from "@/lib/utils";

/** Best (cols, rows, tile size) to fit `count` squares in w x h. */
function bestLayout(count: number, w: number, h: number, gap: number) {
  let best = { cols: 1, size: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const size = Math.min((w - gap * (cols - 1)) / cols, (h - gap * (rows - 1)) / rows);
    if (size > best.size) best = { cols, size };
  }
  return { cols: best.cols, size: Math.max(0, Math.floor(best.size)) };
}

/**
 * Shows `count` QR tiles (white squares holding a canvas each), automatically arranged
 * in whatever grid makes them as large as possible for the space available. One code
 * fills the area; 2 stack or sit side by side depending on the area's shape; 4 and 6 tile.
 * Canvases are exposed through `refs` so the playback loop can paint into them.
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

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setLayout(bestLayout(count, w, h, gap));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, gap]);

  return (
    <div ref={wrapRef} className={cn("relative flex h-full w-full items-center justify-center", className)}>
      <div
        className="grid transition-[gap] duration-300"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, ${layout.size}px)`,
          gap,
          visibility: layout.size > 0 ? "visible" : "hidden",
        }}
      >
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            style={{ width: layout.size, height: layout.size }}
            className={cn(
              "lane-pop lane-anim relative rounded-[1.25rem] bg-white p-1.5 shadow-xl",
              live && "qr-stage-live",
              switching && "lane-switching",
              tileClassName,
            )}
          >
            <canvas
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="h-full w-full rounded-xl object-contain [image-rendering:pixelated]"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
