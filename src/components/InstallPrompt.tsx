import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { cn } from "@/lib/utils";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  );
}

export function InstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone() || sessionStorage.getItem("offdrop-install-dismissed") === "1") return;
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isiOS) {
      setIosHint(true);
      setVisible(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", dismiss);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", dismiss);
    };
  }, []);

  function dismiss() {
    sessionStorage.setItem("offdrop-install-dismissed", "1");
    setVisible(false);
  }

  async function install() {
    if (!promptEvent) {
      setIosHint(true);
      return;
    }
    await promptEvent.prompt();
    await promptEvent.userChoice.catch(() => null);
    setPromptEvent(null);
    dismiss();
  }

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-4 z-[65] flex justify-center" style={{ bottom: "max(env(safe-area-inset-bottom), 5.75rem)" }}>
      <div className="glass pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl px-3 py-2.5 animate-fade-up">
        <button
          type="button"
          onClick={install}
          className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-primary to-accent px-3 py-2.5 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 active:scale-[0.97]"
        >
          {iosHint && !promptEvent ? <Share className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          <span className={cn("truncate", iosHint && !promptEvent && "whitespace-normal leading-tight")}>Install OFFDROP{iosHint && !promptEvent ? " from Share → Add to Home Screen" : ""}</span>
        </button>
        <button type="button" onClick={dismiss} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary active:scale-95" aria-label="Dismiss install prompt">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}