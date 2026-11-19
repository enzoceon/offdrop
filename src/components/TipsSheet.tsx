import { useState } from "react";
import { Info, X, Sun, Maximize2, Focus, Gauge, Sparkles } from "lucide-react";
import { Portal } from "@/components/Portal";
import { sfx } from "@/lib/feedback";

export function TipsSheet() {
  const [open, setOpen] = useState(false);

  function handleOpen() {
    sfx.open();
    setOpen(true);
  }

  function handleClose() {
    sfx.close();
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="glass grid h-10 w-10 place-items-center rounded-full transition-transform active:scale-90"
        aria-label="Scanning tips and information"
        title="Scanning Tips"
      >
        <Info className="h-4.5 w-4.5 text-foreground/80" strokeWidth={2.2} />
      </button>

      {open && (
        <Portal>
          <div
            className="fixed inset-0 z-[100] flex items-end justify-center bg-background/50 px-4 pb-4 backdrop-blur-md transition-opacity animate-in fade-in-0 duration-200"
            role="dialog"
            aria-modal="true"
            aria-label="Scanning tips"
            onClick={handleClose}
          >
            <div
              className="glass animate-in slide-in-from-bottom-6 duration-300 w-full max-w-md rounded-3xl p-5 shadow-2xl border border-border/40"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Drag Handle */}
              <div className="mx-auto mb-3.5 h-1.5 w-12 rounded-full bg-muted-foreground/30" />

              {/* Header */}
              <div className="flex items-center justify-between pb-3 border-b border-border/40">
                <div className="flex items-center gap-2.5">
                  <div className="grid h-8 w-8 place-items-center rounded-xl bg-primary/15 text-primary">
                    <Info className="h-4.5 w-4.5" strokeWidth={2.2} />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-foreground">Scanning & Transfer Tips</h2>
                    <p className="text-[11px] text-muted-foreground">Optimal conditions for instant pickup</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  aria-label="Close tips"
                  className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted/40 transition-transform active:scale-90"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Tips */}
              <ul className="mt-4 space-y-2.5 text-left">
                <li className="flex items-start gap-3 rounded-2xl bg-muted/20 p-2.5">
                  <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Sun className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Turn brightness all the way up</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Maximum sender screen brightness cuts through reflections and room glare.</p>
                  </div>
                </li>

                <li className="flex items-start gap-3 rounded-2xl bg-muted/20 p-2.5">
                  <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Maximize2 className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Frame the QR codes</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Move closer or back until the codes fill most of the camera view.</p>
                  </div>
                </li>

                <li className="flex items-start gap-3 rounded-2xl bg-muted/20 p-2.5">
                  <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Focus className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Hold steady & let lens focus</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Keep the phone parallel to the screen; turn on Auto focus if codes look soft.</p>
                  </div>
                </li>

                <li className="flex items-start gap-3 rounded-2xl bg-muted/20 p-2.5">
                  <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Gauge className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Adjust density if needed</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">On the sender, pick "Balanced" or "Reliable" density for smaller screens or cameras.</p>
                  </div>
                </li>

                <li className="flex items-start gap-3 rounded-2xl bg-muted/20 p-2.5">
                  <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Sparkles className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Turbo P2P auto-handoff</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">When signaling and WebRTC connectivity are available, file data can travel directly between devices. Otherwise, optical transfer continues.</p>
                  </div>
                </li>
              </ul>

              {/* Action Button */}
              <button
                type="button"
                onClick={handleClose}
                className="mt-4 w-full rounded-2xl bg-primary py-2.5 text-xs font-bold text-primary-foreground shadow-md shadow-primary/25 transition-transform active:scale-95"
              >
                Got it
              </button>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
