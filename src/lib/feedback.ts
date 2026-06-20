const MUTE_KEY = "paperdrop.muted";

type Tone = { type: OscillatorType; frequency: number; at: number; duration: number; gain?: number };

let muted = readMuted();
let audioContext: AudioContext | null = null;

function readMuted() {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(MUTE_KEY) === "1";
}

function getAudioContext() {
  if (muted || typeof AudioContext === "undefined") return null;
  audioContext ??= new AudioContext();
  return audioContext;
}

function playToneSequence(tones: Tone[]) {
  const ctx = getAudioContext();
  if (!ctx) return;
  void ctx.resume();
  const start = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.setValueAtTime(tone.frequency, start + tone.at);
    gain.gain.setValueAtTime(0, start + tone.at);
    gain.gain.linearRampToValueAtTime(tone.gain ?? 0.035, start + tone.at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.at + tone.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + tone.at);
    osc.stop(start + tone.at + tone.duration + 0.02);
  }
}

function vibrate(pattern: VibratePattern) {
  if (!muted && typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern);
}

export const sfx = {
  get muted() {
    muted = readMuted();
    return muted;
  },
  setMuted(next: boolean) {
    muted = next;
    if (typeof localStorage !== "undefined") localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  },
  fileFound() {
    playToneSequence([{ type: "sine", frequency: 660, at: 0, duration: 0.08 }]);
    vibrate(18);
  },
  scan() {
    playToneSequence([{ type: "triangle", frequency: 880, at: 0, duration: 0.035, gain: 0.02 }]);
    vibrate(8);
  },
  start() {
    playToneSequence([{ type: "sine", frequency: 520, at: 0, duration: 0.07 }]);
    vibrate(12);
  },
  pause() {
    playToneSequence([{ type: "sine", frequency: 360, at: 0, duration: 0.07 }]);
    vibrate(10);
  },
  toggleOn() {
    playToneSequence([{ type: "triangle", frequency: 720, at: 0, duration: 0.08 }]);
    vibrate(12);
  },
  toggleOff() {
    playToneSequence([{ type: "triangle", frequency: 420, at: 0, duration: 0.08 }]);
    vibrate(10);
  },
  reset() {
    playToneSequence([{ type: "sine", frequency: 300, at: 0, duration: 0.08 }]);
    vibrate(16);
  },
  success() {
    playToneSequence([
      { type: "sine", frequency: 523, at: 0, duration: 0.08, gain: 0.04 },
      { type: "sine", frequency: 659, at: 0.08, duration: 0.08, gain: 0.04 },
      { type: "sine", frequency: 784, at: 0.16, duration: 0.14, gain: 0.045 },
    ]);
    vibrate([25, 35, 35]);
  },
  error() {
    playToneSequence([
      { type: "sawtooth", frequency: 420, at: 0, duration: 0.1, gain: 0.035 },
      { type: "sawtooth", frequency: 220, at: 0.1, duration: 0.18, gain: 0.035 },
    ]);
    vibrate([70, 40, 70]);
  },
  tick() {
    playToneSequence([{ type: "triangle", frequency: 600, at: 0, duration: 0.025, gain: 0.018 }]);
    vibrate(6);
  },
  speedTier(tier: "Gentle" | "Normal" | "Fast" | "Turbo") {
    const tones: Record<typeof tier, Tone[]> = {
      Gentle: [{ type: "sine", frequency: 440, at: 0, duration: 0.09 }],
      Normal: [{ type: "sine", frequency: 560, at: 0, duration: 0.09 }],
      Fast: [
        { type: "triangle", frequency: 680, at: 0, duration: 0.06 },
        { type: "triangle", frequency: 820, at: 0.07, duration: 0.06 },
      ],
      Turbo: [
        { type: "square", frequency: 760, at: 0, duration: 0.05, gain: 0.025 },
        { type: "square", frequency: 940, at: 0.06, duration: 0.05, gain: 0.025 },
        { type: "square", frequency: 1120, at: 0.12, duration: 0.07, gain: 0.025 },
      ],
    };
    const patterns: Record<typeof tier, VibratePattern> = {
      Gentle: 12,
      Normal: [14, 30, 14],
      Fast: [18, 24, 18, 24, 18],
      Turbo: [30, 20, 30, 20, 50],
    };
    playToneSequence(tones[tier]);
    vibrate(patterns[tier]);
  },
};
