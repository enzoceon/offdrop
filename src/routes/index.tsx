import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { GlassTabs, type TabKey } from "@/components/GlassTabs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MuteToggle } from "@/components/MuteToggle";
import { RefreshButton } from "@/components/RefreshButton";
import { Sender } from "@/components/Sender";
import { Scanner } from "@/components/Scanner";
import { History } from "@/components/History";
import { InstallPrompt } from "@/components/InstallPrompt";
import { CameraOff, Loader2, QrCode } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OFFDROP — Offline QR File Transfer" },
      {
        name: "description",
        content:
          "Send and receive photos, videos, audio, and files with animated QR codes. No network, no sign-up.",
      },
      { property: "og:title", content: "OFFDROP — Offline QR File Transfer" },
      {
        property: "og:description",
        content: "Animated QR file transfer for photos, videos, audio, and files. Fully offline.",
      },
      { property: "og:url", content: "https://offdrop.app/" },
    ],
    links: [{ rel: "canonical", href: "https://offdrop.app/" }],
  }),
  component: Index,
});

function Index() {
  const [tab, setTab] = useState<TabKey>("send");
  const [historyKey, setHistoryKey] = useState(0);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [pendingTab, setPendingTab] = useState<TabKey | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopRequestKey, setStopRequestKey] = useState(0);

  function requestTab(nextTab: TabKey) {
    if (nextTab === tab) return;
    if (tab === "scan" && scannerBusy) {
      setPendingTab(nextTab);
      setConfirmOpen(true);
      return;
    }
    setTab(nextTab);
  }

  function confirmLeaveScanner() {
    if (!pendingTab || confirming) return;
    setConfirming(true);
    setStopRequestKey((k) => k + 1);
  }

  function cancelLeaveScanner() {
    if (confirming) return;
    setConfirmOpen(false);
    setPendingTab(null);
  }

  function completeScannerStopRequest() {
    const next = pendingTab;
    setConfirming(false);
    setConfirmOpen(false);
    setPendingTab(null);
    if (next) setTab(next);
  }

  useEffect(() => {
    const preventPinch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    const preventGesture = (event: Event) => event.preventDefault();
    const preventCtrlWheel = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    document.addEventListener("touchmove", preventPinch, { passive: false });
    document.addEventListener("gesturestart", preventGesture);
    document.addEventListener("gesturechange", preventGesture);
    document.addEventListener("gestureend", preventGesture);
    document.addEventListener("wheel", preventCtrlWheel, { passive: false });
    return () => {
      document.removeEventListener("touchmove", preventPinch);
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
      document.removeEventListener("gestureend", preventGesture);
      document.removeEventListener("wheel", preventCtrlWheel);
    };
  }, []);

  return (
    <div className="app-bg fixed inset-0 flex flex-col overflow-hidden">
      <header className="safe-top flex items-center justify-between px-5 pb-3">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/30">
            <QrCode className="h-4.5 w-4.5 text-primary-foreground" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-display text-lg leading-none">OFFDROP</h1>
            <p className="text-[10px] text-muted-foreground">Offline file transfer</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <MuteToggle />
          <ThemeToggle />
          <RefreshButton />
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-hidden pb-28">
        <section className={tab === "send" ? "contents" : "hidden"} aria-hidden={tab !== "send"}>
          <Sender />
        </section>
        <section className={tab === "scan" ? "contents" : "hidden"} aria-hidden={tab !== "scan"}>
          <Scanner
            stopRequestKey={stopRequestKey}
            onStopRequestComplete={completeScannerStopRequest}
            onBusyChange={setScannerBusy}
            onSaved={() => {
              setHistoryKey((k) => k + 1);
              setTab("history");
            }}
          />
        </section>
        <section
          className={tab === "history" ? "contents" : "hidden"}
          aria-hidden={tab !== "history"}
        >
          <History refreshKey={historyKey} />
        </section>
      </main>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-background/35 px-4 pb-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={cancelLeaveScanner}
        >
          <div
            className="glass-strong safe-bottom w-full max-w-md rounded-[2rem] p-4 text-center animate-fade-up"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto flex items-center justify-center gap-2">
              <CameraOff className="h-5 w-5 text-primary" strokeWidth={2.4} />
              <h2 className="text-display text-lg leading-tight text-foreground">Stop receiving?</h2>
            </div>
            <p className="mx-auto mt-3 max-w-[19rem] text-center text-sm text-muted-foreground">
              Leaving Receive will close the camera.
            </p>
            <p className="mx-auto mt-1 max-w-[19rem] text-center text-sm text-muted-foreground">
              The current OFFDROP processing will stop.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={confirmLeaveScanner}
                disabled={confirming}
                className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent py-3 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 active:scale-[0.97] disabled:opacity-85"
              >
                {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
                Yes
              </button>
              <button
                type="button"
                onClick={cancelLeaveScanner}
                disabled={confirming}
                className="glass flex items-center justify-center rounded-2xl py-3 text-sm font-bold active:scale-[0.97] disabled:opacity-70"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      <GlassTabs value={tab} onChange={requestTab} />
      <InstallPrompt />
    </div>
  );
}
