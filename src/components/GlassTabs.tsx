import { Send, ScanLine, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabKey = "send" | "scan" | "history";

const tabs: { key: TabKey; label: string; icon: typeof Send }[] = [
  { key: "send", label: "Send", icon: Send },
  { key: "scan", label: "Receive", icon: ScanLine },
  { key: "history", label: "History", icon: Clock },
];

export function GlassTabs({ value, onChange }: { value: TabKey; onChange: (k: TabKey) => void }) {
  const activeIndex = tabs.findIndex((t) => t.key === value);

  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-50 px-4 pb-3 pt-2">
      <div className="glass-strong relative mx-auto grid max-w-md grid-cols-3 items-center rounded-full p-1.5">
        <span
          className="absolute bottom-1.5 top-1.5 z-0 rounded-full bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/25 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ left: "0.375rem", width: "calc((100% - 0.75rem) / 3)", transform: `translateX(${activeIndex * 100}%)` }}
        />
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = value === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              className={cn(
                "relative z-10 flex min-w-0 flex-col items-center gap-0.5 rounded-full px-2 py-2 text-[11px] font-bold transition-colors duration-300",
                active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="relative z-10 h-5 w-5" strokeWidth={2.2} />
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
