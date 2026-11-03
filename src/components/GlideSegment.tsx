import { useRef } from "react";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string | number> {
  key: T;
  label: string;
}

/**
 * Segmented control whose highlight GLIDES between options (one pill, transform-animated)
 * instead of each button flipping on/off. Also draggable: press and slide across the options.
 */
export function GlideSegment<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  tone = "light",
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  /** "dark" styles it for use on a dark HUD. */
  tone?: "light" | "dark";
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const n = options.length;
  const index = Math.max(0, options.findIndex((o) => o.key === value));

  function pick(clientX: number) {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * n)));
    if (options[i].key !== value) onChange(options[i].key);
  }

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "relative grid touch-none select-none rounded-2xl p-1",
        tone === "dark" ? "bg-white/10" : "bg-secondary/60",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      onPointerDown={(e) => {
        dragging.current = true;
        try {
          rootRef.current?.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        pick(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && pick(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <span
        aria-hidden="true"
        className="absolute bottom-1 left-1 top-1 rounded-xl bg-gradient-to-br from-primary to-accent shadow-md shadow-primary/30 transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ width: `calc((100% - 0.5rem) / ${n})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => (
        <button
          key={String(o.key)}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          className={cn(
            "relative z-10 rounded-xl px-1 py-1.5 text-[11px] font-bold transition-colors duration-300",
            i === index
              ? "text-primary-foreground"
              : tone === "dark"
                ? "text-white/70"
                : "text-muted-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
