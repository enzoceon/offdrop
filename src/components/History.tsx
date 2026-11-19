import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Share2,
  Trash2,
  FileQuestion,
  Film,
  Music2,
  FileIcon,
  Play,
  Pause,
  Search,
  X,
  LayoutGrid,
  Send,
  QrCode,
  FileText,
  HardDrive,
  Clock,
  Loader2,
} from "lucide-react";
import { listItems, deleteItem, type HistoryItem } from "@/lib/history";
import { MediaViewer } from "@/components/MediaViewer";
import { CustomThumbnail } from "@/components/media/CustomThumbnail";
import { Portal } from "@/components/Portal";
import { sfx } from "@/lib/feedback";

type FilterKey = "all" | "sent" | "received";

function MediaPreview({ item, url }: { item: HistoryItem; url?: string }) {
  return (
    <CustomThumbnail
      url={url}
      name={item.filename}
      mime={item.mime}
      variant="thumb"
      className="h-full w-full"
    />
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms?: number) {
  if (!ms || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(1, Math.round(ms / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;
}

export function History({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [pendingDelete, setPendingDelete] = useState<HistoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const urlsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    listItems().then((items) => {
      if (cancelled) return;
      setItems(items.filter((item) => item.valid !== false));
      // Revoke previous URLs and re-create
      Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u));
      const map: Record<string, string> = {};
      items.forEach((it) => {
        if (it.blob) map[it.id] = URL.createObjectURL(it.blob);
      });
      urlsRef.current = map;
      setUrls(map);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    return () => {
      Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (it.valid === false) return false;
      const dir = it.direction || "received";
      if (filter === "sent" && dir !== "sent") return false;
      if (filter === "received" && dir !== "received") return false;
      if (!q) return true;
      return (
        it.filename.toLowerCase().includes(q) || (it.mime || "").toLowerCase().includes(q)
      );
    });
  }, [items, query, filter]);

  function requestDelete(it: HistoryItem) {
    setPendingDelete(it);
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      const id = pendingDelete.id;
      const [_] = await Promise.all([
        deleteItem(id),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      void _;
      const u = urlsRef.current[id];
      if (u) URL.revokeObjectURL(u);
      delete urlsRef.current[id];
      setUrls({ ...urlsRef.current });
      setItems((p) => p.filter((i) => i.id !== id));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  function cancelDelete() {
    if (deleting) return;
    setPendingDelete(null);
  }

  function triggerDownload(it: HistoryItem) {
    if (!it.blob || !urls[it.id]) return;
    const a = document.createElement("a");
    a.href = urls[it.id];
    a.download = it.filename || "offdrop-file";
    a.click();
  }

  async function onDownload(it: HistoryItem) {
    if (!it.blob || !urls[it.id] || busyAction) return;
    setBusyAction(`download:${it.id}`);
    triggerDownload(it);
    await new Promise((resolve) => setTimeout(resolve, 350));
    setBusyAction(null);
  }

  async function onShare(it: HistoryItem) {
    if (!it.blob || busyAction) return;
    setBusyAction(`share:${it.id}`);
    try {
      const file = new File([it.blob], it.filename || "file", { type: it.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: it.filename });
      } else {
        triggerDownload(it);
      }
    } catch {
      /* user cancelled */
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 250));
      setBusyAction(null);
    }
  }

  function closePreview() {
    setPreviewItem(null);
  }

  const filterButtons: { key: FilterKey; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: "All", icon: <LayoutGrid className="h-4 w-4" /> },
    { key: "sent", label: "Sent", icon: <Send className="h-4 w-4" /> },
    { key: "received", label: "Received", icon: <QrCode className="h-4 w-4" /> },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Search + filter */}
      <div className="px-5 pb-3 sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <div className="glass flex h-12 min-w-0 flex-1 items-center gap-2 rounded-2xl px-4">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground sm:h-4 sm:w-4" strokeWidth={2.2} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              aria-label="Search files"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold placeholder:text-muted-foreground focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="glass grid h-8 w-8 shrink-0 place-items-center rounded-xl text-muted-foreground active:scale-90"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="glass relative grid h-12 shrink-0 grid-cols-3 items-center gap-1 rounded-2xl p-1">
            {/* One pill that glides between the options instead of each button flipping on/off. */}
            <span
              aria-hidden="true"
              className="absolute bottom-1 left-1 top-1 rounded-xl bg-gradient-to-br from-primary to-accent shadow-md shadow-primary/30 transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{
                width: "calc((100% - 0.5rem - 0.5rem) / 3)",
                transform: `translateX(calc(${Math.max(0, filterButtons.findIndex((f) => f.key === filter))} * (100% + 0.25rem)))`,
              }}
            />
            {filterButtons.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    if (f.key !== filter) sfx.tick();
                    setFilter(f.key);
                  }}
                  aria-label={f.label}
                  aria-pressed={active}
                  className={`relative z-10 grid h-10 w-10 place-items-center rounded-xl transition-[color,transform] duration-300 ${
                    active ? "text-primary-foreground" : "text-muted-foreground active:scale-90"
                  }`}
                >
                  {f.icon}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="grid h-20 w-20 place-items-center rounded-3xl bg-secondary">
            <FileQuestion className="h-9 w-9 text-muted-foreground" />
          </div>
          <h2 className="text-display mt-5 text-2xl">
            {items.length === 0 ? "Nothing here yet" : "No matches"}
          </h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {items.length === 0 ? (
              <>
                <span className="block">Received files will show up here.</span>
                <span className="block">Everything stays on this device locally.</span>
              </>
            ) : (
              <span className="block">Try a different search or filter.</span>
            )}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-5 pb-2 sm:px-8">
          <div className="mx-auto grid max-w-3xl gap-3 sm:gap-4 lg:max-w-6xl lg:grid-cols-2">
            {filtered.map((it, idx) => {
              const dir = it.direction || "received";
              return (
                <div
                  key={it.id}
                  className="glass overflow-hidden rounded-2xl animate-fade-up sm:rounded-3xl"
                  style={{ animationDelay: `${Math.min(idx, 10) * 45}ms` }}
                >
                  <div className="flex gap-3 p-3 sm:gap-4 sm:p-4">
                    <div
                      onClick={() => {
                        if (urls[it.id]) setPreviewItem(it);
                      }}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && urls[it.id]) setPreviewItem(it);
                      }}
                      className={`relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-secondary text-left transition-transform sm:h-24 sm:w-24 sm:rounded-2xl ${
                        urls[it.id] ? "cursor-pointer active:scale-95" : ""
                      }`}
                      role={urls[it.id] ? "button" : undefined}
                      aria-label={urls[it.id] ? `Open ${it.filename}` : undefined}
                      tabIndex={urls[it.id] ? 0 : undefined}
                    >
                      <MediaPreview item={it} url={urls[it.id]} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-bold leading-tight sm:text-base">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />
                        <span className="truncate">{it.filename}</span>
                      </h3>
                      <div className="mt-1 grid grid-cols-[auto_auto] items-center justify-start gap-x-3 gap-y-1 text-[10px] font-medium text-muted-foreground sm:text-xs">
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3 text-primary sm:h-3.5 sm:w-3.5" />
                          {formatBytes(it.size)}
                        </span>
                        <span className="flex items-center gap-1">
                          {dir === "sent" ? (
                            <Send className="h-3 w-3 text-primary sm:h-3.5 sm:w-3.5" />
                          ) : (
                            <QrCode className="h-3 w-3 text-primary sm:h-3.5 sm:w-3.5" />
                          )}
                          {dir === "sent" ? "Sent" : "Received"}
                        </span>
                        <span className="col-span-2 flex items-center gap-1">
                          <Clock className="h-3 w-3 text-primary sm:h-3.5 sm:w-3.5" />
                          {formatDuration(it.durationMs)} ·{" "}
                          {new Date(it.receivedAt).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 sm:mt-3 sm:gap-2">
                        <button
                          onClick={() => void onDownload(it)}
                          disabled={!it.blob}
                          className="flex min-w-[4.6rem] items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-primary to-accent px-3 py-1.5 text-[11px] font-semibold text-primary-foreground shadow-md shadow-primary/25 active:scale-95 disabled:opacity-50 sm:px-4 sm:py-2 sm:text-xs"
                        >
                          {busyAction === `download:${it.id}` ? <Loader2 className="h-3 w-3 animate-spin sm:h-3.5 sm:w-3.5" /> : <Download className="h-3 w-3 sm:h-3.5 sm:w-3.5" />} Save
                        </button>
                        <button
                          onClick={() => void onShare(it)}
                          disabled={!it.blob}
                          className="flex min-w-[4.9rem] items-center justify-center gap-1.5 rounded-full bg-gradient-to-br from-primary to-accent px-3 py-1.5 text-[11px] font-semibold text-primary-foreground shadow-md shadow-primary/25 active:scale-95 disabled:opacity-50 sm:px-4 sm:py-2 sm:text-xs"
                        >
                          {busyAction === `share:${it.id}` ? <Loader2 className="h-3 w-3 animate-spin sm:h-3.5 sm:w-3.5" /> : <Share2 className="h-3 w-3 sm:h-3.5 sm:w-3.5" />} Share
                        </button>
                        <button
                          onClick={() => requestDelete(it)}
                          aria-label="Delete file"
                          className="history-delete ml-auto grid h-8 w-8 place-items-center rounded-full text-destructive active:scale-90 sm:h-9 sm:w-9"
                        >
                          <Trash2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pendingDelete && (
        <Portal>
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-background/35 px-4 pb-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={cancelDelete}
        >
          <div
            className="glass-strong safe-bottom w-full max-w-md rounded-[2rem] p-4 text-center animate-fade-up"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto flex items-center justify-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" strokeWidth={2.4} />
              <h2 className="text-display text-lg leading-tight text-foreground">
                Delete this file?
              </h2>
            </div>
            <p className="mx-auto mt-3 max-w-[19rem] text-center text-sm text-muted-foreground">
              This file will be removed from this device.
            </p>
            <p className="mx-auto mt-1 max-w-[19rem] text-center text-sm text-muted-foreground">
              This action cannot be undone.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-primary to-accent py-3 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/25 active:scale-[0.97] disabled:opacity-85"
              >
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                Yes
              </button>
              <button
                type="button"
                onClick={cancelDelete}
                disabled={deleting}
                className="liquid-control flex items-center justify-center rounded-2xl py-3 text-sm font-bold active:scale-[0.97] disabled:opacity-70"
              >
                No
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <MediaViewer
        item={
          previewItem && urls[previewItem.id]
            ? {
                url: urls[previewItem.id],
                name: previewItem.filename,
                mime: previewItem.mime,
                size: previewItem.size,
                blob: previewItem.blob,
              }
            : null
        }
        onClose={closePreview}
      />
    </div>
  );
}
