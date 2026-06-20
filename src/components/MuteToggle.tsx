import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { sfx } from "@/lib/feedback";

export function MuteToggle() {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(sfx.muted);
  }, []);

  function toggle() {
    const next = !muted;
    sfx.setMuted(next);
    setMuted(next);
    if (!next && typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }

  return (
    <button
      onClick={toggle}
      className="glass grid h-10 w-10 place-items-center rounded-full transition-transform active:scale-90"
      aria-label={muted ? "Unmute feedback" : "Mute feedback"}
    >
      {muted ? <VolumeX className="h-4.5 w-4.5" /> : <Volume2 className="h-4.5 w-4.5" />}
    </button>
  );
}
