import { Send, ScanLine, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabKey = "send" | "scan" | "history";

const tabs: { key: TabKey; label: string; icon: typeof Send }[] = [
  { key: "send", label: "Send", icon: Send },
  { key: "scan", label: "Scan", icon: ScanLine },
  { key: "history", label: "History", icon: Clock },
];

export function GlassTabs({ value, onChange }: { value: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-50 px-4 pb-3 pt-2">
      <div className="glass-strong mx-auto flex max-w-md items-center justify-around rounded-full p-1.5">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = value === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-0.5 rounded-full px-3 py-2 text-[11px] font-medium transition-all duration-300",
                active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active && (
                <span className="absolute inset-0 -z-0 rounded-full bg-gradient-to-br from-primary to-accent shadow-lg animate-fade-up" />
              )}
              <Icon className="relative z-10 h-5 w-5" strokeWidth={2.2} />
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
