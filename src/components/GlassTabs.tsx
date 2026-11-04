import { useEffect, useRef, useState } from "react";
import { Send, ScanLine, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabKey = "send" | "scan" | "history";

export const TAB_ORDER: TabKey[] = ["send", "scan", "history"];

const tabs: { key: TabKey; label: string; icon: typeof Send }[] = [
  { key: "send", label: "Send", icon: Send },
  { key: "scan", label: "Receive", icon: ScanLine },
  { key: "history", label: "History", icon: Clock },
];

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Bottom (phone) / floating (tablet+desktop) tab bar, identical height on every screen.
 * The highlight pill AND each label's colour are computed from the same live pager position
 * (broadcast by <Pager>), so they can never disagree (a white label on a light background).
 * Dragging a finger across the bar scrubs between tabs.
 */
export function GlassTabs({
  value,
  onChange,
}: {
  value: TabKey;
  onChange: (k: TabKey) => void;
}) {
  const [live, setLive] = useState({ pos: TAB_ORDER.indexOf(value), dragging: false });
  const barRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ id: number; x: number; scrubbing: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const onPos = (e: Event) => setLive((e as CustomEvent<{ pos: number; dragging: boolean }>).detail);
    window.addEventListener("pager-pos", onPos);
    return () => window.removeEventListener("pager-pos", onPos);
  }, []);

  // If the pager has not reported yet (first paint) fall back to the controlled value.
  useEffect(() => {
    setLive((l) => (l.dragging ? l : { pos: TAB_ORDER.indexOf(value), dragging: false }));
  }, [value]);

  function tabAt(clientX: number): TabKey {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return value;
    const i = Math.min(TAB_ORDER.length - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * TAB_ORDER.length)));
    return TAB_ORDER[i];
  }

  const pillPos = Math.min(TAB_ORDER.length - 1, Math.max(0, live.pos));

  return (
    <nav
      aria-label="Primary"
      className="safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 pb-3 pt-2"
    >
      <div
        ref={barRef}
        className="glass-strong pointer-events-auto relative mx-auto grid h-[4.25rem] max-w-md touch-none select-none grid-cols-3 items-center rounded-full p-1.5 md:max-w-lg"
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          press.current = { id: e.pointerId, x: e.clientX, scrubbing: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p || p.id !== e.pointerId) return;
          if (!p.scrubbing && Math.abs(e.clientX - p.x) > 8) {
            p.scrubbing = true;
            suppressClick.current = true;
            try {
              barRef.current?.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
          }
          if (p.scrubbing) {
            const next = tabAt(e.clientX);
            if (next !== value) onChange(next);
          }
        }}
        onPointerUp={(e) => {
          if (press.current?.id === e.pointerId) press.current = null;
          window.setTimeout(() => (suppressClick.current = false), 0);
        }}
        onPointerCancel={() => {
          press.current = null;
          suppressClick.current = false;
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
      >
        <span
          className="absolute bottom-1.5 top-1.5 z-0 rounded-full bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/30 will-change-transform"
          style={{
            left: "0.375rem",
            width: "calc((100% - 0.75rem) / 3)",
            transform: `translateX(${pillPos * 100}%)`,
            transition: live.dragging ? "none" : `transform 480ms ${EASE}`,
          }}
        />
        {tabs.map((t, i) => {
          const Icon = t.icon;
          // 1 when the pill is exactly under this tab, fading to 0 one tab away.
          const w = Math.max(0, 1 - Math.abs(pillPos - i));
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              aria-current={value === t.key ? "page" : undefined}
              className="relative z-10 flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-full px-2 text-[11px] font-bold active:scale-90"
              style={{
                color: `color-mix(in oklab, var(--color-primary-foreground) ${Math.round(w * 100)}%, var(--color-muted-foreground))`,
                transition: live.dragging ? "none" : "color 300ms ease, transform 180ms ease",
              }}
            >
              <Icon className={cn("h-5 w-5", w > 0.5 && "scale-110")} strokeWidth={2.2} style={{ transition: "transform 400ms " + EASE }} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
