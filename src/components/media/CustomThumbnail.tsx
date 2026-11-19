import {
  Film,
  Music2,
  FileCode,
  FileText,
  FileArchive,
  FileSpreadsheet,
  Binary,
  Layers,
  Sparkles,
  Type,
  Play,
  Disc3,
} from "lucide-react";

interface CustomThumbnailProps {
  url?: string | null;
  name: string;
  mime?: string;
  className?: string;
  variant?: "thumb" | "card"; // "thumb" for small 44px rows, "card" for large panel
}

export function CustomThumbnail({
  url,
  name,
  mime = "",
  className = "",
  variant = "card",
}: CustomThumbnailProps) {
  const ext = (name.split(".").pop() || "").toLowerCase();

  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isAudio = mime.startsWith("audio/");
  const isPdf = mime === "application/pdf" || ext === "pdf";
  const isArchive =
    mime.includes("zip") ||
    mime.includes("tar") ||
    mime.includes("compressed") ||
    ["zip", "tar", "gz", "tgz", "7z", "rar", "bz2"].includes(ext);
  const isCode =
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    [
      "txt", "md", "json", "js", "ts", "tsx", "jsx", "py", "rs", "go",
      "html", "css", "yaml", "yml", "sh", "c", "cpp", "sql", "env",
    ].includes(ext);
  const isSpreadsheet =
    ["csv", "tsv", "xlsx", "xls"].includes(ext) || mime.includes("spreadsheet") || mime.includes("csv");
  const isPresentation = ["ppt", "pptx", "key"].includes(ext) || mime.includes("presentation");
  const isDoc = ["doc", "docx", "rtf", "odt"].includes(ext) || mime.includes("wordprocessing");
  const isFont = ["ttf", "otf", "woff", "woff2"].includes(ext);
  const isSvg = ext === "svg" || mime === "image/svg+xml";

  // 1. Small row thumbnail variant (for mobile list, history rows, etc.)
  if (variant === "thumb") {
    if (url && isImage) {
      return <img src={url} alt={name} className={`h-full w-full object-cover ${className}`} />;
    }
    if (url && isVideo) {
      return (
        <div className={`relative h-full w-full overflow-hidden bg-neutral-900 ${className}`}>
          <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
          <span className="absolute inset-0 grid place-items-center bg-black/30">
            <Film className="h-3.5 w-3.5 text-white drop-shadow" />
          </span>
        </div>
      );
    }
    if (isAudio) {
      return (
        <div className={`grid h-full w-full place-items-center bg-gradient-to-br from-primary/30 to-accent/30 text-primary ${className}`}>
          <Music2 className="h-4 w-4" />
        </div>
      );
    }
    if (isPdf) {
      return (
        <div className={`grid h-full w-full place-items-center bg-rose-500/20 text-rose-400 font-bold text-[9px] ${className}`}>
          PDF
        </div>
      );
    }
    if (isArchive) {
      return (
        <div className={`grid h-full w-full place-items-center bg-amber-500/20 text-amber-400 ${className}`}>
          <FileArchive className="h-4 w-4" />
        </div>
      );
    }
    if (isCode) {
      return (
        <div className={`grid h-full w-full place-items-center bg-primary/20 text-primary ${className}`}>
          <FileCode className="h-4 w-4" />
        </div>
      );
    }
    if (isSpreadsheet) {
      return (
        <div className={`grid h-full w-full place-items-center bg-emerald-500/20 text-emerald-400 ${className}`}>
          <FileSpreadsheet className="h-4 w-4" />
        </div>
      );
    }
    return (
      <div className={`grid h-full w-full place-items-center bg-white/10 text-white/70 ${className}`}>
        <FileText className="h-4 w-4" />
      </div>
    );
  }

  // 2. Large card variant (Desktop sender panel, scanner completed card)
  if (url && isImage) {
    return (
      <div className={`relative h-full w-full overflow-hidden ${className}`}>
        <img src={url} alt={name} className="absolute inset-0 h-full w-full object-contain p-3" />
      </div>
    );
  }

  if (url && isVideo) {
    return (
      <div className={`relative h-full w-full overflow-hidden bg-black/50 ${className}`}>
        <video src={url} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-contain p-2" />
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid h-16 w-16 place-items-center rounded-full border border-white/20 bg-white/25 shadow-xl backdrop-blur-md transition-transform duration-300 group-hover:scale-110">
            <Play className="ml-1 h-7 w-7 text-white fill-current" />
          </span>
        </span>
        <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
          <Film className="h-3 w-3 text-primary" />
          <span>VIDEO</span>
        </div>
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-4 p-6 ${className}`}>
        <div className="relative">
          <div className="absolute -inset-2 rounded-full bg-primary/30 blur-xl animate-pulse" />
          <div className="grid h-28 w-28 place-items-center rounded-full border border-white/20 bg-gradient-to-br from-neutral-900 to-black shadow-2xl">
            <Disc3 className="h-12 w-12 text-primary" />
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-3 py-1 text-xs font-bold text-white backdrop-blur">
          <Music2 className="h-3.5 w-3.5 text-primary" />
          <span>{ext.toUpperCase() || "AUDIO"} TRACK</span>
        </div>
      </div>
    );
  }

  if (isPdf) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-rose-500/30 bg-rose-500/10 text-rose-400 shadow-xl">
          <FileText className="h-12 w-12" strokeWidth={1.5} />
        </div>
        <span className="rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300">
          PDF DOCUMENT
        </span>
      </div>
    );
  }

  if (isArchive) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-amber-500/30 bg-amber-500/10 text-amber-400 shadow-xl">
          <FileArchive className="h-12 w-12" strokeWidth={1.5} />
        </div>
        <span className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300">
          {ext.toUpperCase()} ARCHIVE
        </span>
      </div>
    );
  }

  if (isCode) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-primary/30 bg-primary/10 text-primary shadow-xl">
          <FileCode className="h-12 w-12" strokeWidth={1.5} />
        </div>
        <span className="rounded-full bg-primary/20 px-3 py-1 text-xs font-bold text-primary">
          {ext.toUpperCase() || "CODE"} SOURCE
        </span>
      </div>
    );
  }

  if (isSpreadsheet) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shadow-xl">
          <FileSpreadsheet className="h-12 w-12" strokeWidth={1.5} />
        </div>
        <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300">
          {ext.toUpperCase()} SPREADSHEET
        </span>
      </div>
    );
  }

  if (isDoc || isPresentation) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-blue-500/30 bg-blue-500/10 text-blue-400 shadow-xl">
          {isDoc ? <FileText className="h-12 w-12" strokeWidth={1.5} /> : <Layers className="h-12 w-12" strokeWidth={1.5} />}
        </div>
        <span className="rounded-full bg-blue-500/20 px-3 py-1 text-xs font-bold text-blue-300">
          {ext.toUpperCase()} DOCUMENT
        </span>
      </div>
    );
  }

  if (isFont) {
    return (
      <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-purple-500/30 bg-purple-500/10 text-purple-400 shadow-xl">
          <Type className="h-12 w-12" strokeWidth={1.5} />
        </div>
        <span className="rounded-full bg-purple-500/20 px-3 py-1 text-xs font-bold text-purple-300">
          {ext.toUpperCase()} FONT
        </span>
      </div>
    );
  }

  if (isSvg && url) {
    return (
      <div className={`relative flex h-full w-full items-center justify-center p-4 ${className}`}>
        <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
        <span className="absolute top-3 right-3 rounded-full bg-black/50 px-2.5 py-0.5 text-[10px] font-bold text-white">
          SVG
        </span>
      </div>
    );
  }

  return (
    <div className={`relative flex h-full w-full flex-col items-center justify-center gap-3 p-6 ${className}`}>
      <div className="grid h-24 w-24 place-items-center rounded-3xl border border-white/20 bg-white/5 text-muted-foreground shadow-xl">
        <Binary className="h-12 w-12" strokeWidth={1.5} />
      </div>
      <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white/70">
        {ext.toUpperCase() || "FILE"}
      </span>
    </div>
  );
}
