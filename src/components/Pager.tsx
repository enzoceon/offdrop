import { useEffect, useRef, type ReactNode } from "react";

/**
 * Horizontal pager with finger-following drag.
 *
 * - Panels sit side by side on a single GPU-composited track.
 * - Dragging follows the finger 1:1, rubber-bands at both ends, and on release
 *   commits by distance OR flick velocity, settling with a spring-like easing.
 * - Neighbouring panels get a subtle 3D tilt/scale/fade so the motion has depth.
 * - The live position (0..n-1, fractional while dragging) is published as the CSS
 *   variable --pager-pos on <html>, so the tab bar pill can track the finger
 *   without re-rendering React on every pointer move.
 * - Off-screen panels are `inert` (no focus, no taps) and hidden from a11y.
 */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SETTLE_MS = 480;

export function Pager({
  index,
  onIndexChange,
  locked = false,
  children,
}: {
  index: number;
  onIndexChange: (next: number) => void;
  /** Disable swipe (e.g. while the camera owns touch gestures). */
  locked?: boolean;
  children: ReactNode[];
}) {
  const count = children.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const indexRef = useRef(index);
  const lockedRef = useRef(locked);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    t: number;
    lastX: number;
    lastT: number;
    vx: number;
    axis: "x" | "y" | null;
    width: number;
  } | null>(null);

  lockedRef.current = locked;

  function paint(pos: number, dragging: boolean) {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = dragging ? "none" : `transform ${SETTLE_MS}ms ${EASE}`;
    track.style.transform = `translate3d(${(-pos * 100) / count}%,0,0)`;
    panelRefs.current.forEach((panel, i) => {
      if (!panel) return;
      const delta = i - pos;
      const d = Math.min(1, Math.abs(delta));
      panel.style.transition = dragging
        ? "none"
        : `transform ${SETTLE_MS}ms ${EASE}, opacity ${SETTLE_MS}ms ${EASE}`;
      panel.style.opacity = String(1 - d * 0.6);
      panel.style.transform = `perspective(1100px) translate3d(${delta * -6}%,0,0) rotateY(${delta * -9}deg) scale(${1 - d * 0.07})`;
    });
    const root = document.documentElement;
    root.style.setProperty("--pager-pos", pos.toFixed(4));
    if (dragging) root.setAttribute("data-pager-drag", "");
    else root.removeAttribute("data-pager-drag");
  }

  // Follow the controlled index.
  useEffect(() => {
    indexRef.current = index;
    paint(index, false);
    panelRefs.current.forEach((panel, i) => {
      if (!panel) return;
      const inactive = i !== index;
      (panel as HTMLDivElement & { inert: boolean }).inert = inactive;
      panel.setAttribute("aria-hidden", inactive ? "true" : "false");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onDown = (e: PointerEvent) => {
      if (lockedRef.current || e.pointerType === "mouse" || !e.isPrimary) return;
      if ((e.target as Element | null)?.closest?.("[data-no-swipe], input[type='range'], video, audio, textarea")) return;
      drag.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
        lastX: e.clientX,
        lastT: performance.now(),
        vx: 0,
        axis: null,
        width: root.clientWidth || window.innerWidth,
      };
    };

    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        d.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
        if (d.axis === "x") {
          try {
            root.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }
      }
      if (d.axis !== "x") return;
      const now = performance.now();
      const dt = Math.max(1, now - d.lastT);
      d.vx = 0.8 * d.vx + 0.2 * ((e.clientX - d.lastX) / dt);
      d.lastX = e.clientX;
      d.lastT = now;

      let pos = indexRef.current - dx / d.width;
      // Rubber band past the first/last panel.
      if (pos < 0) pos = pos * 0.28;
      if (pos > count - 1) pos = count - 1 + (pos - (count - 1)) * 0.28;
      paint(pos, true);
    };

    const end = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      if (d.axis !== "x") return;
      try {
        root.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const dx = e.clientX - d.x;
      const travelled = dx / d.width;
      let next = indexRef.current;
      if (travelled < -0.2 || d.vx < -0.5) next += 1;
      else if (travelled > 0.2 || d.vx > 0.5) next -= 1;
      next = Math.max(0, Math.min(count - 1, next));
      if (next !== indexRef.current) onIndexChange(next);
      else paint(indexRef.current, false);
    };

    root.addEventListener("pointerdown", onDown, { passive: true });
    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerup", end, { passive: true });
    root.addEventListener("pointercancel", end, { passive: true });
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", end);
      root.removeEventListener("pointercancel", end);
    };
  }, [count, onIndexChange]);

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1 overflow-hidden" style={{ touchAction: "pan-y" }}>
      <div
        ref={trackRef}
        className="flex h-full will-change-transform"
        style={{ width: `${count * 100}%`, transform: `translate3d(${(-index * 100) / count}%,0,0)` }}
      >
        {children.map((child, i) => (
          <div
            key={i}
            ref={(el) => {
              panelRefs.current[i] = el;
            }}
            className="flex h-full min-w-0 flex-col will-change-transform"
            style={{ width: `${100 / count}%`, transformOrigin: i < index ? "right center" : "left center" }}
          >
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
