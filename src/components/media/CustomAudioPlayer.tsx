import { useState, useRef, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Repeat,
  Repeat1,
  Volume2,
  Volume1,
  VolumeX,
  Gauge,
  Check,
  Disc3,
  Music,
} from "lucide-react";
import { formatBytes } from "@/lib/qr-protocol";
import { haptics } from "@/lib/haptics";

interface CustomAudioPlayerProps {
  src: string;
  name: string;
  size?: number;
  mime?: string;
  className?: string;
  autoPlay?: boolean;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CustomAudioPlayer({
  src,
  name,
  size,
  mime,
  className = "",
  autoPlay = true,
}: CustomAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loopMode, setLoopMode] = useState<"off" | "one">("off");
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number>(0);

  // Audio extension extraction
  const ext = name.split(".").pop()?.toUpperCase() || (mime ? mime.split("/")[1]?.toUpperCase() : "AUDIO");

  // Audio element listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      if (!isScrubbing) setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      if (loopMode === "off") {
        setPlaying(false);
      }
    };
    const onVolumeChange = () => {
      setVolume(audio.volume);
      setMuted(audio.muted);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("volumechange", onVolumeChange);

    if (audio.duration) setDuration(audio.duration);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("volumechange", onVolumeChange);
    };
  }, [isScrubbing, loopMode]);

  // Handle loop mode change
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.loop = loopMode === "one";
    }
  }, [loopMode]);

  // Play / Pause toggle
  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    haptics.tap();
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, []);

  // Skip
  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    haptics.select();
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
  }, []);

  // Volume
  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    haptics.select();
    audio.muted = !audio.muted;
  };

  const changeVolume = (newVol: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1, newVol));
    if (audio.muted && newVol > 0) audio.muted = false;
  };

  // Speed
  const selectRate = (rate: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    haptics.select();
    audio.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSpeedMenu(false);
  };

  // Loop toggle
  const toggleLoop = () => {
    haptics.select();
    setLoopMode((prev) => (prev === "off" ? "one" : "off"));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        skip(-5);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        skip(5);
      } else if (e.code === "KeyM") {
        e.preventDefault();
        toggleMute();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, skip]);

  // Scrubbing logic
  const handleSeekFromPointer = (clientX: number) => {
    const track = progressTrackRef.current;
    const audio = audioRef.current;
    if (!track || !audio || !duration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = ratio * duration;
    setCurrentTime(targetTime);
    audio.currentTime = targetTime;
  };

  const handlePointerDownTrack = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsScrubbing(true);
    handleSeekFromPointer(e.clientX);
  };

  const handlePointerMoveTrack = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isScrubbing) {
      handleSeekFromPointer(e.clientX);
    }
  };

  const handlePointerUpTrack = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isScrubbing) {
      handleSeekFromPointer(e.clientX);
      setIsScrubbing(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  };

  const handleMouseMoveTrack = (e: ReactMouseEvent<HTMLDivElement>) => {
    const track = progressTrackRef.current;
    if (!track || !duration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime(ratio * duration);
    setHoverPosition(e.clientX - rect.left);
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={`relative flex w-full max-w-lg flex-col items-center gap-6 rounded-[2.5rem] border border-white/15 bg-black/40 p-6 shadow-2xl backdrop-blur-2xl md:p-8 ${className}`}
    >
      <audio ref={audioRef} src={src} autoPlay={autoPlay} playsInline />

      {/* Hero Visualizer Stage: Glowing Liquid Vinyl Record */}
      <div className="relative mt-2 flex items-center justify-center">
        {/* Pulsing neon halo */}
        <div
          className={`absolute -inset-4 rounded-full bg-gradient-to-tr from-primary/30 via-accent/25 to-primary/30 blur-2xl transition-all duration-700 ${
            playing ? "scale-110 opacity-100" : "scale-90 opacity-40"
          }`}
        />

        {/* Vinyl Disc Body */}
        <div
          className={`relative grid h-48 w-48 place-items-center rounded-full border border-white/20 bg-gradient-to-br from-neutral-900 via-neutral-950 to-black shadow-2xl transition-transform md:h-56 md:w-56 ${
            playing ? "animate-[spin_12s_linear_infinite]" : ""
          }`}
          style={{
            boxShadow: "0 20px 50px rgba(0,0,0,0.8), inset 0 0 0 8px rgba(255,255,255,0.04), inset 0 0 0 24px rgba(255,255,255,0.02)",
          }}
        >
          {/* Subtle concentric sound grooves */}
          <div className="pointer-events-none absolute inset-6 rounded-full border border-white/10" />
          <div className="pointer-events-none absolute inset-12 rounded-full border border-white/5" />
          <div className="pointer-events-none absolute inset-16 rounded-full border border-white/10" />

          {/* Vinyl light sheen reflection */}
          <div className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-tr from-transparent via-white/10 to-transparent" />

          {/* Center Hub Label */}
          <div className="grid h-18 w-18 place-items-center rounded-full bg-gradient-to-br from-primary via-accent to-primary p-1 shadow-inner md:h-20 md:w-20">
            <div className="grid h-full w-full place-items-center rounded-full bg-black/40 backdrop-blur-sm">
              <Disc3 className="h-8 w-8 text-white drop-shadow" />
            </div>
          </div>
        </div>
      </div>

      {/* Reactive Frequency Spectrum Bars */}
      <div className="flex h-8 items-end justify-center gap-1.5 px-4">
        {[
          40, 65, 90, 45, 80, 100, 75, 50, 95, 60, 85, 40, 70, 95, 80, 60, 90, 75, 50, 85, 45, 70,
        ].map((h, i) => (
          <span
            key={i}
            className={`w-1 rounded-full bg-gradient-to-t from-primary to-accent transition-all duration-200 ${
              playing ? "animate-pulse" : "opacity-40"
            }`}
            style={{
              height: playing ? `${Math.max(15, (h * ((i % 3) + 1)) % 100)}%` : "15%",
              animationDelay: `${(i * 65) % 800}ms`,
              animationDuration: `${400 + ((i * 70) % 600)}ms`,
            }}
          />
        ))}
      </div>

      {/* Title & Metadata */}
      <div className="flex w-full flex-col items-center gap-1.5 text-center">
        <h3 className="line-clamp-1 max-w-full text-base font-bold text-white md:text-lg">
          {name}
        </h3>
        <div className="flex items-center gap-2 text-xs font-semibold text-white/60">
          <span className="rounded-lg bg-primary/20 px-2 py-0.5 text-[11px] font-bold text-primary">
            {ext}
          </span>
          {size !== undefined && <span>{formatBytes(size)}</span>}
          <span>•</span>
          <span className="flex items-center gap-1">
            <Music className="h-3 w-3" /> Stereo
          </span>
        </div>
      </div>

      {/* Interactive Timeline Scrubber */}
      <div className="flex w-full flex-col gap-1.5">
        <div
          ref={progressTrackRef}
          onPointerDown={handlePointerDownTrack}
          onPointerMove={handlePointerMoveTrack}
          onPointerUp={handlePointerUpTrack}
          onPointerCancel={handlePointerUpTrack}
          onMouseMove={handleMouseMoveTrack}
          onMouseLeave={() => setHoverTime(null)}
          className="group/track relative flex h-6 w-full cursor-pointer items-center"
        >
          {/* Background rail */}
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20 transition-all group-hover/track:h-2.5">
            {/* Played progress */}
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary via-accent to-primary"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Scrubber thumb */}
          <div
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-lg shadow-primary/60 transition-transform duration-75"
            style={{
              left: `${progressPercent}%`,
              width: isScrubbing ? "18px" : "14px",
              height: isScrubbing ? "18px" : "14px",
              transform: `translate(-50%, -50%) scale(${isScrubbing ? 1.25 : 1})`,
            }}
          />

          {/* Hover timestamp tooltip */}
          {hoverTime !== null && (
            <div
              className="pointer-events-none absolute bottom-7 -translate-x-1/2 rounded-lg border border-white/20 bg-black/80 px-2 py-0.5 text-[11px] font-bold tabular-nums text-white backdrop-blur-md shadow-md"
              style={{ left: `${hoverPosition}px` }}
            >
              {formatTime(hoverTime)}
            </div>
          )}
        </div>

        {/* Timestamps */}
        <div className="flex items-center justify-between text-xs font-semibold tabular-nums text-white/60">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Bottom Control Deck */}
      <div className="flex w-full items-center justify-between gap-2 pt-1 text-white">
        {/* Loop toggle */}
        <button
          type="button"
          onClick={toggleLoop}
          aria-label={loopMode === "one" ? "Loop: single track" : "Loop: off"}
          className={`grid h-9 w-9 place-items-center rounded-full transition-all active:scale-90 ${
            loopMode === "one"
              ? "bg-primary text-primary-foreground font-bold shadow-md shadow-primary/40"
              : "text-white/60 hover:bg-white/10 hover:text-white"
          }`}
        >
          {loopMode === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
        </button>

        {/* Rewind 10s */}
        <button
          type="button"
          onClick={() => skip(-10)}
          aria-label="Rewind 10 seconds"
          className="grid h-10 w-10 place-items-center rounded-full text-white/80 transition-transform hover:bg-white/10 hover:text-white active:scale-90"
        >
          <RotateCcw className="h-5 w-5" />
        </button>

        {/* Hero Play / Pause Button */}
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
          className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-tr from-primary via-accent to-primary text-white shadow-xl shadow-primary/40 transition-all hover:scale-105 active:scale-95"
        >
          {playing ? (
            <Pause className="h-6 w-6 fill-current text-white" />
          ) : (
            <Play className="ml-1 h-6 w-6 fill-current text-white" />
          )}
        </button>

        {/* Forward 10s */}
        <button
          type="button"
          onClick={() => skip(10)}
          aria-label="Forward 10 seconds"
          className="grid h-10 w-10 place-items-center rounded-full text-white/80 transition-transform hover:bg-white/10 hover:text-white active:scale-90"
        >
          <RotateCw className="h-5 w-5" />
        </button>

        {/* Right side controls: Volume & Speed */}
        <div className="relative flex items-center gap-1">
          {/* Volume toggle & mini slider */}
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            className="grid h-9 w-9 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            {muted || volume === 0 ? (
              <VolumeX className="h-4 w-4 text-rose-400" />
            ) : volume < 0.5 ? (
              <Volume1 className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </button>

          {/* Speed selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              aria-label="Playback speed"
              className="flex h-8 items-center gap-0.5 rounded-xl px-1.5 text-xs font-bold text-white/80 transition-all hover:bg-white/15 hover:text-white"
            >
              <Gauge className="h-3 w-3" />
              <span>{playbackRate}x</span>
            </button>

            {showSpeedMenu && (
              <div className="absolute bottom-10 right-0 z-30 flex flex-col gap-1 rounded-2xl border border-white/15 bg-black/90 p-1.5 shadow-2xl backdrop-blur-xl animate-in zoom-in-90 duration-150">
                <span className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white/50">
                  Speed
                </span>
                {SPEED_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    onClick={() => selectRate(rate)}
                    className={`flex items-center justify-between gap-3 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      playbackRate === rate
                        ? "bg-primary text-primary-foreground font-bold"
                        : "text-white/80 hover:bg-white/10"
                    }`}
                  >
                    <span>{rate}x</span>
                    {playbackRate === rate && <Check className="h-3 w-3" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
