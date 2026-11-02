import { useEffect } from "react";

type WakeLockSentinelLike = { release: () => Promise<void> };

/**
 * Keeps the screen awake while `active` (long QR transfers must not dim or lock).
 * Re-acquires after the tab returns from the background, since browsers drop the lock then.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const api = (navigator as unknown as {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
    }).wakeLock;
    if (!api) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        sentinel = await api.request("screen");
        if (cancelled) void sentinel.release().catch(() => {});
      } catch {
        /* denied (battery saver etc.) — transfers still work */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
