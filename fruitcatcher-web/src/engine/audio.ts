// Sound: one continuous "arm" voice whose note, instrument and loudness follow the hand
// (an AudioWorklet, so the sound reacts within one 128-sample block), plus one-shot sounds.
import { CLARINET, NOTE_HZ, SAX, VIOLIN, type Note } from "./config";

export function timbreWeights(t: number): number[] {
  t = Math.min(Math.max(t, 0), 1);
  if (t < 0.5) {
    const a = t / 0.5;
    return CLARINET.map((c, i) => (1 - a) * c + a * SAX[i]);
  }
  const a = (t - 0.5) / 0.5;
  return SAX.map((s, i) => (1 - a) * s + a * VIOLIN[i]);
}

export const instrumentName = (t: number) => (t < 0.33 ? "Clarinet" : t < 0.66 ? "Saxophone" : "Violin");

function renderTone(freq: number, dur: number, weights: number[], vol: number, sr: number, decay = 3.0) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < weights.length; k++) s += weights[k] * Math.sin(2 * Math.PI * freq * (k + 1) * t);
    s *= Math.min(1, t / 0.01) * Math.exp((-decay * t) / dur);
    out[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * vol;
  return out;
}

const WORKLET = `
class ArmVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.freq = 261.63; this.w = [1, 0.05, 0.55, 0.05, 0.3, 0.05];
    this.target = 0; this.amp = 0; this.ph = new Float64Array(6);
    this.port.onmessage = (e) => { const d = e.data; this.freq = d.freq; this.w = d.w; this.target = d.amp; };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    const a0 = this.amp;
    const a1 = a0 + (this.target - a0) * Math.min(1, n / 1100);
    this.amp = a1;
    let wsum = 0; for (let k = 0; k < 6; k++) wsum += this.w[k];
    const inc = 2 * Math.PI * this.freq / sampleRate;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < 6; k++) { this.ph[k] += inc * (k + 1); s += this.w[k] * Math.sin(this.ph[k]); }
      out[i] = (s / wsum) * (a0 + (a1 - a0) * (i + 1) / n) * 0.3;
    }
    for (let k = 0; k < 6; k++) this.ph[k] %= 2 * Math.PI;
    return true;
  }
}
registerProcessor("arm-voice", ArmVoice);
`;

export class SoundEngine {
  ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private shots = new Map<string, AudioBuffer>();
  private last = { freq: 0, t: -1, amp: -1 };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
  }

  /** Must be called after a click (browsers only allow sound after a user gesture). */
  async start() {
    await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, "arm-voice", { outputChannelCount: [1] });
    this.node.connect(this.ctx.destination);
    const sr = this.ctx.sampleRate;
    const add = (name: string, data: Float32Array) => {
      const b = this.ctx.createBuffer(1, data.length, sr);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.shots.set(name, b);
    };
    for (const [n, hz] of Object.entries(NOTE_HZ)) {
      add("hum_" + n, renderTone(hz, 0.6, [1, 0.3], 0.35, sr));
      add("ring_" + n, renderTone(hz, 0.9, SAX, 0.6, sr));
      add("song_" + n, renderTone(hz, 0.7, [1, 0.45, 0.2, 0.08], 0.75, sr, 4.0));
    }
    const parts = [523.25, 659.25, 783.99].map((f) => renderTone(f, 0.12, [1, 0.4, 0.2], 0.5, sr));
    const catchBuf = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      catchBuf.set(p, o);
      o += p.length;
    }
    add("catch", catchBuf);
    add("miss", renderTone(164.81, 0.3, [1, 0.3], 0.3, sr));
    const n = Math.floor(sr * 0.006);
    add("click", Float32Array.from({ length: n }, (_, i) => (Math.random() * 2 - 1) * Math.exp(-i / (n / 5)) * 0.4));
  }

  get outputLatencyMs() {
    return Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000);
  }

  setMotion(note: Note, timbre: number, amp: number) {
    if (!this.node) return;
    const freq = NOTE_HZ[note];
    // only message the audio thread when something audible changed
    if (freq === this.last.freq && Math.abs(timbre - this.last.t) < 0.01 && Math.abs(amp - this.last.amp) < 0.005) return;
    this.last = { freq, t: timbre, amp };
    this.node.port.postMessage({ freq, w: timbreWeights(timbre), amp });
  }

  play(name: string) {
    const b = this.shots.get(name);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.connect(this.ctx.destination);
    src.start();
  }

  async close() {
    this.node?.disconnect();
    await this.ctx.close();
  }
}
