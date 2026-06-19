import { useEffect, useState } from "react";
import { Download, Share2, Trash2, FileQuestion, Image as ImageIcon, Film } from "lucide-react";
import { listItems, deleteItem, type HistoryItem } from "@/lib/history";

export function History({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    listItems().then((items) => {
      setItems(items);
      const map: Record<string, string> = {};
      items.forEach((it) => (map[it.id] = URL.createObjectURL(it.blob)));
      setUrls(map);
    });
    return () => {
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function onDelete(id: string) {
    await deleteItem(id);
    setItems((p) => p.filter((i) => i.id !== id));
  }

  function onDownload(it: HistoryItem) {
    const a = document.createElement("a");
    a.href = urls[it.id];
    a.download = it.filename || "qrbeam-file";
    a.click();
  }

  async function onShare(it: HistoryItem) {
    try {
      const file = new File([it.blob], it.filename || "file", { type: it.mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: it.filename });
      } else {
        onDownload(it);
      }
    } catch {
      /* user cancelled */
    }
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="grid h-20 w-20 place-items-center rounded-3xl bg-secondary">
          <FileQuestion className="h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="text-display mt-5 text-2xl">No transfers yet</h2>
        <p className="mt-2 max-w-xs text-sm text-muted-foreground">
          Scanned files show up here. Everything stays on this device.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-2">
      <div className="space-y-3">
        {items.map((it) => {
          const isImg = it.mime.startsWith("image/");
          const isVid = it.mime.startsWith("video/");
          return (
            <div key={it.id} className="glass overflow-hidden rounded-2xl animate-fade-up">
              <div className="flex gap-3 p-3">
                <div className="relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-secondary">
                  {isImg ? (
                    <img src={urls[it.id]} alt="" className="h-full w-full object-cover" />
                  ) : isVid ? (
                    <>
                      <video src={urls[it.id]} className="h-full w-full object-cover" muted />
                      <Film className="absolute h-5 w-5 text-white drop-shadow" />
                    </>
                  ) : (
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{it.filename}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {(it.size / 1024).toFixed(1)} KB ·{" "}
                    {new Date(it.receivedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <button
                      onClick={() => onDownload(it)}
                      className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium active:scale-95"
                    >
                      <Download className="h-3 w-3" /> Save
                    </button>
                    <button
                      onClick={() => onShare(it)}
                      className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium active:scale-95"
                    >
                      <Share2 className="h-3 w-3" /> Share
                    </button>
                    <button
                      onClick={() => onDelete(it.id)}
                      className="ml-auto grid h-7 w-7 place-items-center rounded-full bg-secondary text-destructive active:scale-95"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
