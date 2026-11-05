// OFFDROP sound + haptics.
//
// Everything is synthesised (no audio files). One shared signal chain keeps it
// polished and loud-safe:
//   voices -> dry bus ------------------------\
//          -> reverb send -> convolver ------- master -> compressor -> out
// Notes come from a C-major pentatonic palette so any sequence of sounds stays
// consonant, and the scan tick rises in pitch with transfer progress so the
// receiver can *hear* how close it is to done.

import { haptics } from "./haptics";

const MUTE_KEY = "paperdrop.muted";

type VoiceOpts = {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** Seconds the note rings after attack. */
  decay?: number;
  /** Low-pass cutoff in Hz (sweeps down over the note when `sweep` is set). */
  cutoff?: number;
  sweep?: number;
  /** Pitch glide target in Hz (exponential). */
  glideTo?: number;
  detune?: number;
  reverb?: number;
  pan?: number;
};

let muted = readMuted();
haptics.setEnabled(!muted);
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let reverbSend: GainNode | null = null;

// C major pentatonic across two octaves (Hz).
const N = {
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  G4: 392.0,
  A4: 440.0,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
  A5: 880.0,
  C6: 1046.5,
  D6: 1174.66,
  E6: 1318.51,
  G6: 1567.98,
};

function readMuted() {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function impulseResponse(audio: AudioContext, seconds = 1.4, decay = 3.2) {
  const rate = audio.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = audio.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}

function getCtx(): AudioContext | null {
  if (muted || typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(compressor).connect(ctx.destination);

    const convolver = ctx.createConvolver();
    convolver.buffer = impulseResponse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    reverbSend.connect(convolver).connect(wet).connect(master);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** One enveloped, filtered oscillator voice. */
function voice(freq: number, at: number, duration: number, o: VoiceOpts = {}) {
  const audio = getCtx();
  if (!audio || !master || !reverbSend) return;
  const t0 = audio.currentTime + at;
  const peak = o.gain ?? 0.12;
  const attack = o.attack ?? 0.006;
  const osc = audio.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t0 + duration);
  if (o.detune) osc.detune.value = o.detune;

  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  const cutoff = o.cutoff ?? 6000;
  filter.frequency.setValueAtTime(cutoff, t0);
  if (o.sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(120, o.sweep), t0 + duration);
  filter.Q.value = 0.7;

  const env = audio.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + (o.decay ?? duration));

  let tail: AudioNode = env;
  if (o.pan && audio.createStereoPanner) {
    const panner = audio.createStereoPanner();
    panner.pan.value = o.pan;
    env.connect(panner);
    tail = panner;
  }
  osc.connect(filter).connect(env);
  tail.connect(master);
  if (o.reverb) {
    const send = audio.createGain();
    send.gain.value = o.reverb;
    tail.connect(send).connect(reverbSend);
  }
  osc.start(t0);
  osc.stop(t0 + attack + (o.decay ?? duration) + 0.05);
}

/** Glassy FM bell: carrier + inharmonic modulator, long reverb tail. */
function bell(freq: number, at: number, o: { gain?: number; decay?: number; reverb?: number; pan?: number } = {}) {
  const audio = getCtx();
  if (!audio || !master || !reverbSend) return;
  const t0 = audio.currentTime + at;
  const decay = o.decay ?? 0.9;
  const carrier = audio.createOscillator();
  const mod = audio.createOscillator();
  const modGain = audio.createGain();
  carrier.type = "sine";
  mod.type = "sine";
  carrier.frequency.value = freq;
  mod.frequency.value = freq * 3.51;
  modGain.gain.setValueAtTime(freq * 1.6, t0);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t0 + decay * 0.6);
  mod.connect(modGain).connect(carrier.frequency);

  const env = audio.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(o.gain ?? 0.1, t0 + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  carrier.connect(env);
  let tail: AudioNode = env;
  if (o.pan && audio.createStereoPanner) {
    const panner = audio.createStereoPanner();
    panner.pan.value = o.pan;
    env.connect(panner);
    tail = panner;
  }
  tail.connect(master);
  const send = audio.createGain();
  send.gain.value = o.reverb ?? 0.6;
  tail.connect(send).connect(reverbSend);
  carrier.start(t0);
  mod.start(t0);
  carrier.stop(t0 + decay + 0.05);
  mod.stop(t0 + decay + 0.05);
}

/** Band-passed noise burst: swooshes and soft clicks. */
function noise(at: number, duration: number, o: { gain?: number; from?: number; to?: number; q?: number; reverb?: number } = {}) {
  const audio = getCtx();
  if (!audio || !master || !reverbSend) return;
  const t0 = audio.currentTime + at;
  const length = Math.max(1, Math.floor(audio.sampleRate * duration));
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = audio.createBufferSource();
  src.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = o.q ?? 1.2;
  filter.frequency.setValueAtTime(o.from ?? 800, t0);
  filter.frequency.exponentialRampToValueAtTime(o.to ?? 3200, t0 + duration);
  const env = audio.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(o.gain ?? 0.06, t0 + duration * 0.25);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter).connect(env).connect(master);
  if (o.reverb) {
    const send = audio.createGain();
    send.gain.value = o.reverb;
    env.connect(send).connect(reverbSend);
  }
  src.start(t0);
}

function vibrate(pattern: VibratePattern) {
  if (!muted) haptics.play(pattern);
}

let lastTickAt = 0;

export const sfx = {
  get muted() {
    muted = readMuted();
    return muted;
  },
  setMuted(next: boolean) {
    muted = next;
    haptics.setEnabled(!next);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(MUTE_KEY, next ? "1" : "0");
    } catch {
      /* private mode */
    }
    if (!next) {
      // Confirm un-mute with a tiny chime.
      bell(N.E5, 0, { gain: 0.07, decay: 0.5, reverb: 0.4 });
    }
  },

  /** Call once from a user gesture so iOS lets later sounds play. */
  unlock() {
    getCtx();
  },

  /** A transfer header was recognised. */
  fileFound() {
    bell(N.G5, 0, { gain: 0.1, decay: 0.7, pan: -0.15 });
    bell(N.C6, 0.09, { gain: 0.09, decay: 0.9, pan: 0.15 });
    vibrate(18);
  },

  /** A new frame landed. `frac` (0..1) raises the pitch as the transfer nears completion. */
  scan(frac = 0) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastTickAt < 70) return;
    lastTickAt = now;
    const steps = [N.C5, N.D5, N.E5, N.G5, N.A5, N.C6, N.D6, N.E6];
    const idx = Math.min(steps.length - 1, Math.floor(Math.max(0, Math.min(1, frac)) * steps.length));
    voice(steps[idx], 0, 0.07, { type: "triangle", gain: 0.05, attack: 0.002, decay: 0.06, cutoff: 3500, reverb: 0.25 });
  },

  /** Playback begins / resumes: rising soft pluck. */
  start() {
    voice(N.G4, 0, 0.14, { type: "triangle", gain: 0.1, decay: 0.16, cutoff: 2800, reverb: 0.3 });
    voice(N.C5, 0.07, 0.2, { type: "triangle", gain: 0.1, decay: 0.22, cutoff: 3200, reverb: 0.35 });
    noise(0, 0.14, { gain: 0.025, from: 500, to: 2600, reverb: 0.2 });
    vibrate(12);
  },

  pause() {
    voice(N.C5, 0, 0.14, { type: "triangle", gain: 0.09, decay: 0.16, cutoff: 2600, reverb: 0.3 });
    voice(N.G4, 0.07, 0.22, { type: "triangle", gain: 0.09, decay: 0.24, cutoff: 2200, reverb: 0.35 });
    vibrate(10);
  },

  toggleOn() {
    voice(N.E5, 0, 0.1, { type: "sine", gain: 0.1, decay: 0.12, reverb: 0.3 });
    voice(N.A5, 0.05, 0.14, { type: "sine", gain: 0.09, decay: 0.16, reverb: 0.3 });
    vibrate(12);
  },

  toggleOff() {
    voice(N.A5, 0, 0.1, { type: "sine", gain: 0.09, decay: 0.12, reverb: 0.3 });
    voice(N.E5, 0.05, 0.14, { type: "sine", gain: 0.08, decay: 0.16, reverb: 0.3 });
    vibrate(10);
  },

  reset() {
    noise(0, 0.28, { gain: 0.06, from: 3200, to: 500, q: 0.9, reverb: 0.3 });
    voice(N.G5, 0, 0.26, { type: "sine", gain: 0.07, decay: 0.26, glideTo: N.C4, reverb: 0.4 });
    vibrate(16);
  },

  /** Transfer finished and verified: bright arpeggio over a bell. */
  success() {
    const notes = [N.C5, N.E5, N.G5, N.C6, N.E6];
    notes.forEach((f, i) => bell(f, i * 0.075, { gain: 0.085, decay: 1.1, reverb: 0.7, pan: (i - 2) * 0.12 }));
    voice(N.C4, 0, 0.5, { type: "sine", gain: 0.1, decay: 0.7, cutoff: 900, reverb: 0.5 });
    noise(0.28, 0.5, { gain: 0.03, from: 2500, to: 9000, q: 0.6, reverb: 0.6 });
    vibrate([22, 30, 22, 30, 60]);
  },

  /** Soft, non-harsh failure: two falling muted notes. */
  error() {
    voice(N.E4, 0, 0.22, { type: "triangle", gain: 0.12, decay: 0.24, cutoff: 1400, sweep: 500, reverb: 0.3 });
    voice(N.C4, 0.14, 0.34, { type: "triangle", gain: 0.12, decay: 0.38, cutoff: 1200, sweep: 380, reverb: 0.35 });
    vibrate([60, 40, 60]);
  },

  tick() {
    voice(N.A5, 0, 0.04, { type: "sine", gain: 0.05, attack: 0.002, decay: 0.04, reverb: 0.15 });
    vibrate(4);
  },

  /** Opening a viewer / sheet. */
  open() {
    noise(0, 0.18, { gain: 0.035, from: 600, to: 3000, reverb: 0.25 });
    voice(N.E5, 0.02, 0.18, { type: "sine", gain: 0.07, decay: 0.2, reverb: 0.35 });
    vibrate(8);
  },

  close() {
    noise(0, 0.16, { gain: 0.03, from: 3000, to: 600, reverb: 0.25 });
    voice(N.C5, 0, 0.16, { type: "sine", gain: 0.06, decay: 0.18, reverb: 0.3 });
    vibrate(6);
  },

  /** Tab change. `direction` pans the whoosh left/right. */
  swipe(direction: -1 | 0 | 1 = 0) {
    noise(0, 0.2, { gain: 0.035, from: direction >= 0 ? 700 : 2600, to: direction >= 0 ? 2600 : 700, reverb: 0.2 });
    voice(N.D5, 0.02, 0.12, { type: "sine", gain: 0.05, decay: 0.12, pan: direction * 0.4, reverb: 0.2 });
    vibrate(6);
  },

  speedTier(tier: "Gentle" | "Normal" | "Fast" | "Turbo" | "Ultra") {
    const ladder: Record<typeof tier, number[]> = {
      Gentle: [N.C5],
      Normal: [N.C5, N.E5],
      Fast: [N.C5, N.E5, N.G5],
      Turbo: [N.C5, N.E5, N.G5, N.C6],
      Ultra: [N.C5, N.E5, N.G5, N.C6, N.E6],
    };
    ladder[tier].forEach((f, i) => voice(f, i * 0.05, 0.1, { type: "triangle", gain: 0.08, decay: 0.12, cutoff: 3600, reverb: 0.3 }));
    const patterns: Record<typeof tier, VibratePattern> = {
      Gentle: 8,
      Normal: 12,
      Fast: [10, 18, 10],
      Turbo: [14, 14, 18],
      Ultra: [16, 12, 16, 12, 22],
    };
    vibrate(patterns[tier]);
  },
};
