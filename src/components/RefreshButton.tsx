import { RefreshCw } from "lucide-react";

export function RefreshButton() {
  function refresh() {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(8);
    if (typeof window !== "undefined") window.location.reload();
  }
  return (
    <button
      onClick={refresh}
      className="glass grid h-10 w-10 place-items-center rounded-full transition-transform active:scale-90"
      aria-label="Refresh app"
    >
      <RefreshCw className="h-4.5 w-4.5" />
    </button>
  );
}
