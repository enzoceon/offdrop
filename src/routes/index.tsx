import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { GlassTabs, TAB_ORDER, type TabKey } from "@/components/GlassTabs";
import { Pager } from "@/components/Pager";
import { sfx } from "@/lib/feedback";
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

const TAB_STORAGE_KEY = "offdrop:active-tab";

function readStoredTab(): TabKey {
  if (typeof window === "undefined") return "send";
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (v === "send" || v === "scan" || v === "history") return v;
  } catch {
    /* ignore */
  }
  return "send";
}

function Index() {
  // Always start as "send" so the first client render matches the server HTML (a mismatch breaks the
  // layout after a refresh). The saved tab is restored right after mount, before anything is shown.
  const [tab, setTab] = useState<TabKey>("send");
  const [hydrated, setHydrated] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [pendingTab, setPendingTab] = useState<TabKey | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopRequestKey, setStopRequestKey] = useState(0);

  useEffect(() => {
    setTab(readStoredTab());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab, hydrated]);


  function requestTab(nextTab: TabKey) {
    if (nextTab === tab) return;
    if (tab === "scan" && scannerBusy) {
      setPendingTab(nextTab);
      setConfirmOpen(true);
      return;
    }
    sfx.swipe(TAB_ORDER.indexOf(nextTab) > TAB_ORDER.indexOf(tab) ? 1 : -1);
    setTab(nextTab);
  }

  const onPagerIndex = useCallback(
    (i: number) => requestTab(TAB_ORDER[i]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, scannerBusy],
  );

  // iOS/Safari only allow audio after a user gesture: prime it on the first touch.
  useEffect(() => {
    const unlock = () => sfx.unlock();
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);


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
      if ((event.target as Element | null)?.closest?.("[data-camera-gesture-zone='true']")) return;
      if (event.touches.length > 1) event.preventDefault();
    };
    const preventGesture = (event: Event) => event.preventDefault();
    const preventCtrlWheel = (event: WheelEvent) => {
      if ((event.target as Element | null)?.closest?.("[data-camera-gesture-zone='true']")) return;
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

  const panelPad = "flex min-h-0 flex-1 flex-col";
  const bottomPad = "pb-[5.75rem] md:pb-24";

  return (
    <div
      className="app-bg group/app fixed inset-0 flex flex-col overflow-hidden"
    >
      <div className="ambient-orbs pointer-events-none absolute inset-0 -z-0" aria-hidden="true">
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
      </div>

      <header className="safe-top relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between px-5 pb-2 md:px-8 md:pb-3">
        <div className="flex items-center gap-2.5">
          <div className="logo-mark grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/30 md:h-10 md:w-10">
            <QrCode className="h-4.5 w-4.5 text-primary-foreground" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-display text-lg leading-none md:text-xl">OFFDROP</h1>
            <p className="text-[10px] text-muted-foreground md:text-xs">Offline file transfer</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <MuteToggle />
          <ThemeToggle />
          <RefreshButton />
        </div>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col">
        {hydrated ? (
        <Pager index={TAB_ORDER.indexOf(tab)} onIndexChange={onPagerIndex}>
          {[
            <div key="send" className={`${panelPad} ${bottomPad}`}>
              <Sender active={tab === "send"} />
            </div>,
            <div key="scan" className={`${panelPad} ${bottomPad}`}>
              <Scanner
                stopRequestKey={stopRequestKey}
                onStopRequestComplete={completeScannerStopRequest}
                onBusyChange={setScannerBusy}
                visible={tab === "scan"}
                onSaved={() => {
                  setHistoryKey((k) => k + 1);
                }}
                onCompleteAction={() => {}}
              />
            </div>,
            <div key="history" className={`${panelPad} ${bottomPad}`}>
              <History refreshKey={historyKey} />
            </div>,
          ]}
        </Pager>
        ) : (
          <div className="flex-1" />
        )}
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
