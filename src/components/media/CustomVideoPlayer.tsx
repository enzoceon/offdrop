import { useState, useRef, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  Maximize2,
  Minimize2,
  RotateCcw,
  RotateCw,
  PictureInPicture2,
  Check,
  Gauge,
} from "lucide-react";
import { sfx } from "@/lib/feedback";
import { haptics } from "@/lib/haptics";

interface CustomVideoPlayerProps {
  src: string;
  name?: string;
  poster?: string;
  className?: string;
  autoPlay?: boolean;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CustomVideoPlayer({
  src,
  name,
  poster,
  className = "",
  autoPlay = true,
}: CustomVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supportsPiP, setSupportsPiP] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number>(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [centerAnimation, setCenterAnimation] = useState<"play" | "pause" | null>(null);
  const [skipFeedback, setSkipFeedback] = useState<{ side: "left" | "right"; text: string } | null>(null);

  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });

  // Check PiP support
  useEffect(() => {
    if (typeof document !== "undefined" && "pictureInPictureEnabled" in document) {
      setSupportsPiP(Boolean(document.pictureInPictureEnabled));
    }
  }, []);

  // Update buffered range
  const updateBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.buffered.length === 0) return;
    try {
      const end = video.buffered.end(video.buffered.length - 1);
      setBufferedEnd(end);
    } catch {
      // ignore
    }
  }, []);

  // Attach video listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (!isScrubbing) {
        setCurrentTime(video.currentTime);
      }
      updateBuffered();
    };

    const onDurationChange = () => {
      setDuration(video.duration || 0);
      updateBuffered();
    };

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setControlsVisible(true);
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("progress", updateBuffered);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("volumechange", onVolumeChange);

    // Initial check
    if (video.duration) setDuration(video.duration);
    if (video.currentTime) setCurrentTime(video.currentTime);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("progress", updateBuffered);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [isScrubbing, updateBuffered]);

  // Fullscreen change listener
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // Controls auto-hide timer
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (!playing) {
      setControlsVisible(true);
      return;
    }
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      setShowSpeedMenu(false);
    }, 2400);
  }, [playing]);

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (!playing) {
      setControlsVisible(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    } else {
      scheduleHide();
    }
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [playing, scheduleHide]);

  // Toggle play/pause
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    haptics.tap();
    if (video.paused) {
      video.play().catch(() => {});
      setCenterAnimation("play");
    } else {
      video.pause();
      setCenterAnimation("pause");
    }
    window.setTimeout(() => setCenterAnimation(null), 600);
  }, []);

  // Skip time
  const skip = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      haptics.select();
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
      wakeControls();
      setSkipFeedback({
        side: seconds < 0 ? "left" : "right",
        text: seconds > 0 ? `+${seconds}s` : `${seconds}s`,
      });
      window.setTimeout(() => setSkipFeedback(null), 650);
    },
    [wakeControls]
  );

  // Volume & Mute
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    haptics.select();
    video.muted = !video.muted;
  }, []);

  const changeVolume = (newVol: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, newVol));
    if (video.muted && newVol > 0) video.muted = false;
  };

  // Speed
  const selectRate = (rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    haptics.select();
    video.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSpeedMenu(false);
  };

  // Fullscreen
  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;
    haptics.tap();
    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fallback: request on video element if container fails
      const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
  };

  // Picture in picture
  const togglePiP = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // ignore
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }
      switch (e.code) {
        case "Space":
        case "KeyK":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
        case "KeyJ":
          e.preventDefault();
          skip(-5);
          break;
        case "ArrowRight":
        case "KeyL":
          e.preventDefault();
          skip(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          changeVolume(volume + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(volume - 0.1);
          break;
        case "KeyM":
          e.preventDefault();
          toggleMute();
          break;
        case "KeyF":
          e.preventDefault();
          void toggleFullscreen();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, skip, volume, toggleMute]);

  // Scrubbing logic
  const handleSeekFromPointer = (clientX: number) => {
    const track = progressTrackRef.current;
    const video = videoRef.current;
    if (!track || !video || !duration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = ratio * duration;
    setCurrentTime(targetTime);
    video.currentTime = targetTime;
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

  const handleMouseLeaveTrack = () => {
    setHoverTime(null);
  };

  // Double tap to skip on mobile
  const handleContainerTap = (e: ReactMouseEvent<HTMLDivElement>) => {
    const now = performance.now();
    const dt = now - lastTapRef.current.time;
    const container = containerRef.current;
    if (container && dt < 300) {
      const rect = container.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      if (clickX < rect.width * 0.38) {
        skip(-10);
      } else if (clickX > rect.width * 0.62) {
        skip(10);
      } else {
        togglePlay();
      }
      lastTapRef.current = { time: 0, x: 0 };
    } else {
      lastTapRef.current = { time: now, x: e.clientX };
      wakeControls();
    }
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      onMouseMove={wakeControls}
      onClick={handleContainerTap}
      className={`group relative flex h-full w-full select-none items-center justify-center overflow-hidden bg-black/95 ${className}`}
    >
      {/* Native video element with custom presentation */}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay={autoPlay}
        playsInline
        className="max-h-full max-w-full object-contain"
      />

      {/* Skip feedback ripple animation (left / right double-tap) */}
      {skipFeedback && (
        <div
          className={`pointer-events-none absolute inset-y-0 flex items-center justify-center ${
            skipFeedback.side === "left" ? "left-0 w-1/3" : "right-0 w-1/3"
          } bg-white/10 backdrop-blur-sm animate-in fade-in zoom-in-75 duration-200`}
        >
          <div className="flex flex-col items-center gap-1 rounded-2xl bg-black/60 px-4 py-2 text-white">
            {skipFeedback.side === "left" ? (
              <RotateCcw className="h-6 w-6 animate-spin" style={{ animationIterationCount: 1 }} />
            ) : (
              <RotateCw className="h-6 w-6 animate-spin" style={{ animationIterationCount: 1 }} />
            )}
            <span className="text-xs font-bold">{skipFeedback.text}</span>
          </div>
        </div>
      )}

      {/* Central Play/Pause pop icon animation */}
      {centerAnimation && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md transition-all duration-300 animate-in zoom-in-50 fade-out-0">
            {centerAnimation === "play" ? (
              <Play className="ml-1 h-10 w-10 fill-current text-white" />
            ) : (
              <Pause className="h-10 w-10 fill-current text-white" />
            )}
          </div>
        </div>
      )}

      {/* Liquid Glassmorphic Controls Bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 p-3 pb-4 transition-all duration-300 md:p-5 ${
          controlsVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col rounded-3xl border border-white/15 bg-black/45 p-3.5 shadow-2xl backdrop-blur-xl md:p-4">
          {/* Timeline scrub track */}
          <div
            ref={progressTrackRef}
            onPointerDown={handlePointerDownTrack}
            onPointerMove={handlePointerMoveTrack}
            onPointerUp={handlePointerUpTrack}
            onPointerCancel={handlePointerUpTrack}
            onMouseMove={handleMouseMoveTrack}
            onMouseLeave={handleMouseLeaveTrack}
            className="group/track relative flex h-6 w-full cursor-pointer items-center"
          >
            {/* Background rail */}
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20 transition-all group-hover/track:h-2.5">
              {/* Buffered progress */}
              <div
                className="absolute inset-y-0 left-0 bg-white/30 transition-all"
                style={{ width: `${bufferedPercent}%` }}
              />
              {/* Played progress */}
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary via-accent to-primary transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {/* Glowing scrubber thumb */}
            <div
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-lg shadow-primary/50 transition-transform duration-75"
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
                className="pointer-events-none absolute bottom-7 -translate-x-1/2 rounded-lg border border-white/20 bg-black/80 px-2 py-1 text-[11px] font-bold tabular-nums text-white backdrop-blur-md shadow-md"
                style={{ left: `${hoverPosition}px` }}
              >
                {formatTime(hoverTime)}
              </div>
            )}
          </div>

          {/* Lower action controls row */}
          <div className="mt-1 flex items-center justify-between gap-2 text-white">
            {/* Left group: Play/Pause, Skips, Time */}
            <div className="flex items-center gap-2 md:gap-3">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition-all hover:bg-white/25 active:scale-95"
              >
                {playing ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                )}
              </button>

              <button
                type="button"
                onClick={() => skip(-10)}
                aria-label="Rewind 10 seconds"
                className="grid h-8 w-8 place-items-center rounded-full text-white/80 transition-transform hover:bg-white/10 hover:text-white active:scale-95"
              >
                <RotateCcw className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => skip(10)}
                aria-label="Forward 10 seconds"
                className="grid h-8 w-8 place-items-center rounded-full text-white/80 transition-transform hover:bg-white/10 hover:text-white active:scale-95"
              >
                <RotateCw className="h-4 w-4" />
              </button>

              {/* Time display */}
              <div className="text-[12px] font-semibold tabular-nums text-white/90">
                <span>{formatTime(currentTime)}</span>
                <span className="mx-1 text-white/40">/</span>
                <span className="text-white/60">{formatTime(duration)}</span>
              </div>
            </div>

            {/* Center: File Title if provided */}
            {name && (
              <span className="hidden max-w-[12rem] truncate text-center text-xs font-semibold text-white/70 lg:inline-block">
                {name}
              </span>
            )}

            {/* Right group: Volume, Speed, PiP, Fullscreen */}
            <div className="relative flex items-center gap-1.5 md:gap-2">
              {/* Volume & Slider */}
              <div className="group/vol flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                  className="grid h-8 w-8 place-items-center rounded-full text-white/80 transition-all hover:bg-white/10 hover:text-white"
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="h-4 w-4 text-rose-400" />
                  ) : volume < 0.5 ? (
                    <Volume1 className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  onChange={(e) => changeVolume(parseFloat(e.target.value))}
                  className="hidden h-1.5 w-14 cursor-pointer accent-primary transition-all md:block lg:w-20"
                />
              </div>

              {/* Playback speed selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                  aria-label="Playback speed"
                  className="flex h-8 items-center gap-1 rounded-xl px-2 text-xs font-bold text-white/80 transition-all hover:bg-white/15 hover:text-white"
                >
                  <Gauge className="h-3.5 w-3.5" />
                  <span>{playbackRate}x</span>
                </button>

                {showSpeedMenu && (
                  <div className="absolute bottom-10 right-0 z-30 flex flex-col gap-1 rounded-2xl border border-white/15 bg-black/85 p-1.5 shadow-2xl backdrop-blur-xl animate-in zoom-in-90 duration-150">
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

              {/* Picture-in-Picture */}
              {supportsPiP && (
                <button
                  type="button"
                  onClick={() => void togglePiP()}
                  aria-label="Picture in picture"
                  className="grid h-8 w-8 place-items-center rounded-full text-white/80 transition-all hover:bg-white/10 hover:text-white"
                >
                  <PictureInPicture2 className="h-4 w-4" />
                </button>
              )}

              {/* Fullscreen */}
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                className="grid h-8 w-8 place-items-center rounded-full text-white/80 transition-all hover:bg-white/10 hover:text-white"
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
