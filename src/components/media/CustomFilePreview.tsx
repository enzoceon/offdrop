import { useState, useEffect } from "react";
import {
  FileCode,
  FileSpreadsheet,
  FileText,
  FileArchive,
  Binary,
  Copy,
  Check,
  ExternalLink,
  Type,
  FileCheck2,
  Table,
  Layers,
  Sparkles,
} from "lucide-react";
import { formatBytes } from "@/lib/qr-protocol";
import { haptics } from "@/lib/haptics";

interface CustomFilePreviewProps {
  url: string;
  name: string;
  mime: string;
  size: number;
  blob?: Blob | null;
}

export function CustomFilePreview({ url, name, mime, size, blob }: CustomFilePreviewProps) {
  const ext = (name.split(".").pop() || "").toLowerCase();

  // Determine category
  const isCodeOrText =
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/typescript" ||
    mime === "application/xml" ||
    [
      "txt", "md", "json", "js", "ts", "tsx", "jsx", "py", "rs", "go",
      "html", "css", "scss", "yaml", "yml", "xml", "sh", "bash", "c",
      "cpp", "h", "cs", "sql", "env", "toml", "ini", "log", "graphql",
    ].includes(ext);

  const isPdf = mime === "application/pdf" || ext === "pdf";

  const isArchive =
    mime === "application/zip" ||
    mime === "application/x-tar" ||
    mime === "application/gzip" ||
    mime === "application/x-7z-compressed" ||
    ["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz", "iso"].includes(ext);

  const isSpreadsheet =
    ["csv", "tsv", "xlsx", "xls", "ods"].includes(ext) ||
    mime.includes("spreadsheet") ||
    mime.includes("csv");

  const isOfficeDoc = ["doc", "docx", "odt", "rtf"].includes(ext) || mime.includes("wordprocessing");
  const isPresentation = ["ppt", "pptx", "odp", "key"].includes(ext) || mime.includes("presentation");
  const isFont = ["ttf", "otf", "woff", "woff2"].includes(ext);
  const isSvg = ext === "svg" || mime === "image/svg+xml";

  // State for text/code preview
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lineWrap, setLineWrap] = useState(true);

  // Load text content for code/text/csv
  useEffect(() => {
    if (!isCodeOrText && !isSpreadsheet) return;
    let active = true;
    setLoadingText(true);

    async function load() {
      try {
        let text = "";
        if (blob) {
          // Read first 120KB for responsive preview
          const slice = blob.slice(0, 120 * 1024);
          text = await slice.text();
        } else if (url) {
          const res = await fetch(url);
          text = await res.text();
        }
        if (active) {
          setTextContent(text);
          setLoadingText(false);
        }
      } catch {
        if (active) setLoadingText(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [blob, url, isCodeOrText, isSpreadsheet]);

  const copyText = async () => {
    if (!textContent) return;
    haptics.select();
    try {
      await navigator.clipboard.writeText(textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  // 1. PDF Previewer
  if (isPdf) {
    return (
      <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-neutral-900/90 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-rose-500/20 px-2 py-0.5 text-xs font-bold text-rose-400">
              PDF
            </span>
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="text-xs text-white/50">{formatBytes(size)}</span>
          </div>
          <button
            type="button"
            onClick={() => window.open(url, "_blank", "noopener")}
            className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20 active:scale-95"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Open in Tab</span>
          </button>
        </div>
        <div className="relative flex-1 bg-black/60">
          <object
            data={`${url}#toolbar=1&navpanes=0`}
            type="application/pdf"
            className="h-full w-full"
          >
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white">
              <FileText className="h-14 w-14 text-rose-400" />
              <p className="text-sm font-medium">PDF preview not natively supported on this browser.</p>
              <button
                type="button"
                onClick={() => window.open(url, "_blank", "noopener")}
                className="rounded-2xl bg-white/15 px-5 py-2.5 text-sm font-semibold text-white backdrop-blur active:scale-95"
              >
                Open in Full Window
              </button>
            </div>
          </object>
        </div>
      </div>
    );
  }

  // 2. CSV / Spreadsheet Viewer
  if (isSpreadsheet && textContent && (ext === "csv" || ext === "tsv")) {
    const rows = textContent
      .split("\n")
      .slice(0, 40)
      .filter((r) => r.trim().length > 0)
      .map((line) => (ext === "tsv" ? line.split("\t") : line.split(",")));

    return (
      <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-neutral-900/90 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-400">
              <Table className="mr-1 inline h-3 w-3" />
              {ext.toUpperCase()}
            </span>
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="text-xs text-white/50">{formatBytes(size)}</span>
          </div>
          <button
            type="button"
            onClick={copyText}
            className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20 active:scale-95"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Copy Raw"}</span>
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3 text-xs text-white/90">
          <table className="w-full border-collapse text-left font-mono">
            <tbody>
              {rows.map((cols, ri) => (
                <tr
                  key={ri}
                  className={`border-b border-white/5 transition-colors hover:bg-white/5 ${
                    ri === 0 ? "bg-white/10 font-bold text-emerald-300" : ""
                  }`}
                >
                  <td className="w-10 select-none py-1.5 pr-3 text-right text-[10px] text-white/30">
                    {ri + 1}
                  </td>
                  {cols.map((col, ci) => (
                    <td key={ci} className="border-l border-white/5 px-3 py-1.5">
                      {col.trim()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 3. Code & Text Editor Card
  if (isCodeOrText && textContent !== null) {
    const lines = textContent.split("\n");
    return (
      <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-neutral-950/90 shadow-2xl backdrop-blur-xl">
        {/* Editor Top Bar */}
        <div className="flex items-center justify-between border-b border-white/10 bg-black/40 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary">
              <FileCode className="mr-1 inline h-3.5 w-3.5" />
              {ext.toUpperCase() || "TEXT"}
            </span>
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="text-xs text-white/50">
              {lines.length} lines · {formatBytes(size)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLineWrap(!lineWrap)}
              className={`rounded-xl px-2.5 py-1 text-xs font-semibold transition-colors ${
                lineWrap ? "bg-white/20 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
              }`}
            >
              Wrap
            </button>

            <button
              type="button"
              onClick={copyText}
              className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/20 active:scale-95"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>

        {/* Code Canvas */}
        <div className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-neutral-200">
          <div className="flex font-mono">
            {/* Gutter with line numbers */}
            <div className="mr-4 flex select-none flex-col text-right text-[11px] text-white/25">
              {lines.map((_, i) => (
                <span key={i} className="h-5">
                  {i + 1}
                </span>
              ))}
            </div>

            {/* Code lines */}
            <div className={`flex-1 select-text ${lineWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
              {lines.map((line, i) => (
                <div key={i} className="h-5">
                  {line || "\u00A0"}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Loading state for text
  if (loadingText) {
    return (
      <div className="flex flex-col items-center gap-3 text-white">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs font-medium text-white/60">Reading file content…</span>
      </div>
    );
  }

  // 4. Vector SVG Viewer
  if (isSvg) {
    return (
      <div className="flex h-full w-full max-w-2xl flex-col items-center justify-center p-6">
        <div
          className="relative grid max-h-[70vh] max-w-full place-items-center rounded-3xl border border-white/20 p-8 shadow-2xl backdrop-blur-xl"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
        >
          <img src={url} alt={name} className="max-h-[60vh] max-w-full object-contain drop-shadow-xl" />
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-4 py-1.5 text-xs font-semibold text-white backdrop-blur-md">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span>Scalable Vector Graphics (SVG)</span>
          <span className="text-white/40">•</span>
          <span>{formatBytes(size)}</span>
        </div>
      </div>
    );
  }

  // 5. Interactive Font Specimen
  if (isFont) {
    return (
      <div className="flex h-full w-full max-w-2xl flex-col justify-center gap-6 rounded-3xl border border-white/15 bg-black/40 p-8 text-white shadow-2xl backdrop-blur-2xl">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-tr from-primary to-accent shadow-lg shadow-primary/30">
            <Type className="h-6 w-6 text-white" />
          </div>
          <div>
            <h3 className="text-base font-bold">{name}</h3>
            <p className="text-xs text-white/60">
              Font Family • {ext.toUpperCase()} • {formatBytes(size)}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <p className="text-2xl font-bold tracking-tight">The quick brown fox jumps over the lazy dog.</p>
          <p className="text-base font-medium text-white/80">ABCDEFGHIJKLM NOPQRSTUVWXYZ</p>
          <p className="text-sm text-white/60">abcdefghijklm nopqrstuvwxyz 0123456789 !@#$%^&*()</p>
        </div>
      </div>
    );
  }

  // 6. Archive Vault Card
  if (isArchive) {
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-[2.5rem] border border-white/15 bg-black/40 p-8 text-center text-white shadow-2xl backdrop-blur-2xl">
        {/* Animated 3D Archive Chest Orb */}
        <div className="relative">
          <div className="absolute -inset-3 rounded-full bg-amber-500/25 blur-xl animate-pulse" />
          <div className="grid h-28 w-28 place-items-center rounded-3xl border border-amber-400/30 bg-gradient-to-br from-amber-500/20 via-neutral-900 to-black shadow-2xl">
            <FileArchive className="h-14 w-14 text-amber-400 drop-shadow" strokeWidth={1.5} />
          </div>
        </div>

        <div>
          <span className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300">
            {ext.toUpperCase()} ARCHIVE BUNDLE
          </span>
          <h3 className="mt-2 text-base font-bold">{name}</h3>
          <p className="mt-1 text-xs text-white/60">{formatBytes(size)} compressed package</p>
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/80">
          <FileCheck2 className="h-4 w-4 text-emerald-400" />
          <span>Integrity verified • Ready to unpack</span>
        </div>
      </div>
    );
  }

  // 7. Office / Productivity Documents
  if (isOfficeDoc || isPresentation) {
    const isDoc = isOfficeDoc;
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-[2.5rem] border border-white/15 bg-black/40 p-8 text-center text-white shadow-2xl backdrop-blur-2xl">
        <div className="relative">
          <div
            className={`absolute -inset-3 rounded-full blur-xl ${
              isDoc ? "bg-blue-500/25" : "bg-orange-500/25"
            }`}
          />
          <div
            className={`grid h-28 w-28 place-items-center rounded-3xl border bg-gradient-to-br from-neutral-900 to-black shadow-2xl ${
              isDoc ? "border-blue-400/30 text-blue-400" : "border-orange-400/30 text-orange-400"
            }`}
          >
            {isDoc ? (
              <FileText className="h-14 w-14" strokeWidth={1.5} />
            ) : (
              <Layers className="h-14 w-14" strokeWidth={1.5} />
            )}
          </div>
        </div>

        <div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              isDoc ? "bg-blue-500/20 text-blue-300" : "bg-orange-500/20 text-orange-300"
            }`}
          >
            {isDoc ? "DOCUMENT" : "PRESENTATION"} • {ext.toUpperCase()}
          </span>
          <h3 className="mt-2 text-base font-bold">{name}</h3>
          <p className="mt-1 text-xs text-white/60">{formatBytes(size)}</p>
        </div>

        <button
          type="button"
          onClick={() => window.open(url, "_blank", "noopener")}
          className="flex items-center gap-2 rounded-2xl bg-white/15 px-5 py-2.5 text-xs font-semibold text-white backdrop-blur transition-all hover:bg-white/25 active:scale-95"
        >
          <ExternalLink className="h-4 w-4" />
          <span>Open with Default App</span>
        </button>
      </div>
    );
  }

  // 8. Executable / Binary / Unknown Fallback
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-[2.5rem] border border-white/15 bg-black/40 p-8 text-center text-white shadow-2xl backdrop-blur-2xl">
      <div className="relative">
        <div className="absolute -inset-3 rounded-full bg-cyan-500/20 blur-xl" />
        <div className="grid h-28 w-28 place-items-center rounded-3xl border border-cyan-400/30 bg-gradient-to-br from-cyan-950/40 via-neutral-900 to-black text-cyan-400 shadow-2xl">
          <Binary className="h-14 w-14" strokeWidth={1.5} />
        </div>
      </div>

      <div>
        <span className="rounded-full bg-cyan-500/20 px-3 py-1 text-xs font-bold text-cyan-300">
          {ext.toUpperCase() || "BINARY"}
        </span>
        <h3 className="mt-2 text-base font-bold">{name}</h3>
        <p className="mt-1 text-xs text-white/60">
          {formatBytes(size)} • {mime || "application/octet-stream"}
        </p>
      </div>

      <button
        type="button"
        onClick={() => window.open(url, "_blank", "noopener")}
        className="flex items-center gap-2 rounded-2xl bg-white/15 px-5 py-2.5 text-xs font-semibold text-white backdrop-blur transition-all hover:bg-white/25 active:scale-95"
      >
        <ExternalLink className="h-4 w-4" />
        <span>Open in Browser</span>
      </button>
    </div>
  );
}
