// OFFDROP haptics.
//
// A small semantic layer over the Vibration API, with an iOS fallback.
//   - Android / Chromium: navigator.vibrate with carefully shaped pulse trains. The API has no
//     amplitude control, so "soft" vs "firm" is expressed with pulse length and spacing
//     (3-6 ms = a light tick, 12-18 ms = a click, 30 ms+ = a thump).
//   - iOS Safari 17.4+: has no vibrate(), but toggling a native <input switch> produces the system
//     haptic. A hidden switch is clicked for each tap (best-effort; needs a user gesture).
// Everything respects a single on/off switch (tied to the app's mute button).

type Pattern = number | number[];

const STORAGE_KEY = "offdrop.haptics";
let enabled = readEnabled();
let lastAt = 0;
let iosLabel: HTMLLabelElement | null = null;

function readEnabled() {
  try {
    return typeof localStorage === "undefined" ? true : localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1));

function hasVibrate() {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

function ensureIosSwitch(): HTMLLabelElement | null {
  if (typeof document === "undefined") return null;
  if (iosLabel?.isConnected) return iosLabel;
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  iosLabel = label;
  return label;
}

function fire(pattern: Pattern, force = false) {
  if (!enabled) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  // Very fast repeats blur into one buzz; keep them distinct.
  if (!force && now - lastAt < 14) return;
  lastAt = now;
  try {
    if (hasVibrate()) navigator.vibrate(pattern);
    else if (isIOS()) ensureIosSwitch()?.click();
  } catch {
    /* haptics are best-effort */
  }
}

export const haptics = {
  get enabled() {
    return enabled;
  },
  setEnabled(next: boolean) {
    enabled = next;
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!next && hasVibrate()) navigator.vibrate(0);
  },

  /** Raw pattern (used by the sound layer). */
  play(pattern: Pattern) {
    fire(pattern);
  },

  /** Any button press: a crisp, very short click. */
  tap() {
    fire(7);
  },
  /** Barely-there tick for continuous controls (sliders, scrubbing). */
  tick() {
    fire(3);
  },
  light() {
    fire(5);
  },
  heavy() {
    fire(34, true);
  },
  /** A choice was made (tab changed, density picked). */
  select() {
    fire([9, 26, 6]);
  },
  toggle(on: boolean) {
    fire(on ? [6, 24, 14] : [14, 24, 6]);
  },
  start() {
    fire([8, 28, 16, 28, 26], true);
  },
  stop() {
    fire([26, 28, 16, 28, 8], true);
  },
  /** Hit the end of something (rubber band at the first/last tab). */
  edge() {
    fire([4, 34, 4]);
  },
  /** A QR code just got locked on. */
  lock() {
    fire([6, 26, 18], true);
  },
  /** Progress milestones while receiving: each one a little richer than the last. */
  milestone(step: 1 | 2 | 3) {
    if (step === 1) fire([10], true);
    else if (step === 2) fire([10, 36, 10], true);
    else fire([10, 30, 10, 30, 14], true);
  },
  warning() {
    fire([28, 70, 28], true);
  },
  error() {
    fire([46, 56, 46, 56, 96], true);
  },
  /** File fully received and verified: a rising, satisfying flourish. */
  success() {
    fire([10, 34, 12, 34, 16, 34, 22, 40, 50, 60, 90], true);
  },
  /** File prepared and ready to send. */
  confirm() {
    fire([12, 40, 22], true);
  },
};
