import { Send, ScanLine, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabKey = "send" | "scan" | "history";

export const TAB_ORDER: TabKey[] = ["send", "scan", "history"];

const tabs: { key: TabKey; label: string; icon: typeof Send }[] = [
  { key: "send", label: "Send", icon: Send },
  { key: "scan", label: "Receive", icon: ScanLine },
  { key: "history", label: "History", icon: Clock },
];

/**
 * Bottom (phone) / floating (tablet+desktop) tab bar.
 * The highlight pill reads --pager-pos, which <Pager> updates while the finger
 * is still dragging, so the pill glides with the swipe and settles with it.
 */
export function GlassTabs({
  value,
  onChange,
  hidden = false,
}: {
  value: TabKey;
  onChange: (k: TabKey) => void;
  hidden?: boolean;
}) {
  const fallback = TAB_ORDER.indexOf(value);
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 pb-3 pt-2 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
        hidden ? "max-md:translate-y-[140%] max-md:opacity-0 max-md:pointer-events-none" : "translate-y-0 opacity-100",
      )}
    >
      <div className="glass-strong pointer-events-auto relative mx-auto grid max-w-md grid-cols-3 items-center rounded-full p-1.5 md:max-w-lg">
        <span
          className="tab-pill absolute bottom-1.5 top-1.5 z-0 rounded-full bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/30"
          style={{
            left: "0.375rem",
            width: "calc((100% - 0.75rem) / 3)",
            transform: `translateX(calc(var(--pager-pos, ${fallback}) * 100%))`,
          }}
        />
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = value === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative z-10 flex min-w-0 flex-col items-center gap-0.5 rounded-full px-2 py-2 text-[11px] font-bold transition-[color,transform] duration-300 active:scale-90 md:flex-row md:justify-center md:gap-2 md:text-sm",
                active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon
                className={cn("relative z-10 h-5 w-5 transition-transform duration-500", active && "scale-110")}
                strokeWidth={2.2}
              />
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
