// Measures real transfer speed the way a benchmark would: whole-transfer ("sustained") goodput and
// the best 1-second window ("peak"), from (time, completed bytes) samples.

export interface RateReport {
  seconds: number;
  /** Bytes per second over the whole transfer. */
  sustained: number;
  /** Best bytes per second over any window of at least `windowMs`. */
  peak: number;
}

export class RateMeter {
  private samples: Array<{ t: number; b: number }> = [];
  private start = 0;

  reset() {
    this.samples = [];
    this.start = 0;
  }

  /** `t` in ms (any monotonic clock), `bytes` = completed payload bytes so far. */
  add(t: number, bytes: number) {
    if (!this.samples.length) this.start = t;
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < 50) {
      last.b = Math.max(last.b, bytes); // coalesce bursts
      return;
    }
    this.samples.push({ t, b: bytes });
  }

  report(totalBytes: number, endT: number, windowMs = 1000): RateReport {
    const seconds = Math.max(0.001, (endT - this.start) / 1000);
    const s = this.samples;
    let peak = 0;
    let j = 0;
    for (let i = 0; i < s.length; i++) {
      while (s[i].t - s[j].t > windowMs * 3) j++; // bound the scan
      for (let k = j; k < i; k++) {
        const dt = s[i].t - s[k].t;
        if (dt >= windowMs) peak = Math.max(peak, (s[i].b - s[k].b) / (dt / 1000));
      }
    }
    return { seconds, sustained: totalBytes / seconds, peak: Math.max(peak, totalBytes / seconds) };
  }
}
