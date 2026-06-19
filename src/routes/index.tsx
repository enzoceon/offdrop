import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { GlassTabs, type TabKey } from "@/components/GlassTabs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sender } from "@/components/Sender";
import { Scanner } from "@/components/Scanner";
import { History } from "@/components/History";
import { QrCode } from "lucide-react";

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
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col overflow-hidden pb-28">
        {tab === "send" && <Sender />}
        {tab === "scan" && <Scanner onSaved={() => setHistoryKey((k) => k + 1)} />}
        {tab === "history" && <History refreshKey={historyKey} />}
      </main>

      <GlassTabs value={tab} onChange={setTab} />
    </div>
  );
}
