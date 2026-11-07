// Adaptive fruit placement: pheromone heat map + Sobel frontier + UCB1 (MCTS) + catch-chance model.
import {
  ANTIC_STAGES, BLEND_END, COLD_START, GRID, H, MCTS_C, MCTS_TOPK, MODEL_L2, MODEL_LR,
  MODEL_MIN_EVENTS, PHER_EVAP, PHER_SEED, RECENCY, SURPRISE_P, W, zoneOf,
  type Note, type RoundKind, type RoundOpt,
} from "./config";
import { choice, randInt, randUniform } from "./math";
import type { Cell, Features } from "./types";

// ================================================================ pheromone grid
/** 20x20 memory of where the patient has succeeded. High = comfortable;
 *  the Sobel edge between high and low is the therapeutic frontier. */
export class Pheromone {
  g: Float32Array;

  constructor(saved?: number[] | null, carry = 1) {
    this.g = new Float32Array(GRID * GRID);
    if (saved && saved.length === GRID * GRID && carry > 0) {
      for (let i = 0; i < saved.length; i++) this.g[i] = saved[i] * carry;
    } else {
      const c = GRID / 2;
      for (let r = c - 1; r <= c + 1; r++) for (let k = c - 1; k <= c + 1; k++) this.g[r * GRID + k] = PHER_SEED;
    }
  }

  static cellOf(x: number, y: number): Cell {
    return [
      Math.min(Math.max(Math.floor((x / W) * GRID), 0), GRID - 1),
      Math.min(Math.max(Math.floor((y / H) * GRID), 0), GRID - 1),
    ];
  }

  static center(c: number, r: number): [number, number] {
    return [((c + 0.5) * W) / GRID, ((r + 0.5) * H) / GRID];
  }

  at(c: number, r: number) {
    return this.g[r * GRID + c];
  }

  evaporate(dt: number) {
    const f = Math.exp(-PHER_EVAP * Math.max(dt, 0));
    for (let i = 0; i < this.g.length; i++) this.g[i] *= f;
  }

  deposit(x: number, y: number, amount: number) {
    const [c, r] = Pheromone.cellOf(x, y);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < GRID && cc >= 0 && cc < GRID) {
          this.g[rr * GRID + cc] += amount * (dr === 0 && dc === 0 ? 1.0 : 0.35);
        }
      }
    }
  }

  /** Normalised Sobel edge strength and the frontier mask (as cv2.Sobel, ksize 3, reflect-101 border). */
  frontier(): { norm: Float32Array; mask: Uint8Array } {
    const n = GRID;
    const idx = (i: number) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
    const v = (r: number, c: number) => this.g[idx(r) * n + idx(c)];
    const mag = new Float32Array(n * n);
    let mx = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const gx = v(r - 1, c + 1) + 2 * v(r, c + 1) + v(r + 1, c + 1) - v(r - 1, c - 1) - 2 * v(r, c - 1) - v(r + 1, c - 1);
        const gy = v(r + 1, c - 1) + 2 * v(r + 1, c) + v(r + 1, c + 1) - v(r - 1, c - 1) - 2 * v(r - 1, c) - v(r - 1, c + 1);
        const m = Math.hypot(gx, gy);
        mag[r * n + c] = m;
        if (m > mx) mx = m;
      }
    }
    const norm = mx > 1e-6 ? mag.map((m) => m / mx) : mag;
    let gmax = 0;
    for (const x of this.g) gmax = Math.max(gmax, x);
    const mask = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) mask[i] = norm[i] > 0.25 && this.g[i] < 0.5 * gmax + 1e-6 ? 1 : 0;
    return { norm, mask };
  }

  /** [coverage, frontier cells, mean value] */
  stats(): [number, number, number] {
    const { mask } = this.frontier();
    let cov = 0, sum = 0, fr = 0;
    for (let i = 0; i < this.g.length; i++) {
      if (this.g[i] > 0.15) cov++;
      sum += this.g[i];
      fr += mask[i];
    }
    return [cov / this.g.length, fr, sum / this.g.length];
  }

  toArray(): number[] {
    return Array.from(this.g, (x) => Math.round(x * 10000) / 10000);
  }
}

// ================================================================ catch-chance model
/** Online logistic regression: features of a spawn cell -> chance of a catch.
 *  Pre-trained on this patient's past still trials (recent ones weigh more), then
 *  updated after every catch or miss. Switched on after the cold start. */
export class CatchModel {
  w = new Float64Array(6);
  events = 0;
  classes = new Set<number>();

  static x(f: Features) {
    return [1, f.x, f.y, f.dist, f.pher, f.recent];
  }

  /** rows: [x, y, dist, pher, recent, caught], oldest first. */
  constructor(rows: number[][] = []) {
    if (!rows.length) return;
    const X = rows.map((r) => [1, r[0], r[1], r[2], r[3], r[4]]);
    const y = rows.map((r) => r[5]);
    const n = y.length;
    const wts = y.map((_, i) => RECENCY ** (n - 1 - i));
    const wsum = wts.reduce((a, b) => a + b, 0);
    const w = new Float64Array(6);
    for (let it = 0; it < 600; it++) {
      const grad = new Float64Array(6);
      for (let i = 0; i < n; i++) {
        let z = 0;
        for (let k = 0; k < 6; k++) z += X[i][k] * w[k];
        const p = 1 / (1 + Math.exp(-z));
        for (let k = 0; k < 6; k++) grad[k] += (p - y[i]) * wts[i] * X[i][k];
      }
      for (let k = 0; k < 6; k++) w[k] -= 0.5 * (grad[k] / wsum + (k ? MODEL_L2 * w[k] : 0));
    }
    this.w = w;
    this.events = n;
    this.classes = new Set(y);
  }

  ready(spawnIdx: number) {
    return spawnIdx >= COLD_START && this.events >= MODEL_MIN_EVENTS && this.classes.size === 2;
  }

  predict(f: Features) {
    const x = CatchModel.x(f);
    let z = 0;
    for (let k = 0; k < 6; k++) z += x[k] * this.w[k];
    return 1 / (1 + Math.exp(-z));
  }

  update(f: Features, caught: number) {
    const x = CatchModel.x(f);
    const p = this.predict(f);
    for (let k = 0; k < 6; k++) this.w[k] += MODEL_LR * ((caught - p) * x[k] - (k ? MODEL_L2 * this.w[k] : 0));
    this.events += 1;
    this.classes.add(caught);
  }
}

// ================================================================ spawner (three tiers + MCTS + model)
export interface SpawnerHost {
  rest: [number, number];
  pher: Pheromone;
  model: CatchModel;
  targetP: number;
  zoneRecent(z: [number, number]): number;
  bandOfY(y: number): number;
  bandCenter(b: number): number;
}

export interface Spawn {
  c: number; r: number; p: number; modelOn: boolean; feats: Features; method: string;
}

export class Spawner {
  count = 0;
  cellStats = new Map<string, [number, number]>();
  constructor(private g: SpawnerHost) {}

  features(c: number, r: number): Features {
    const g = this.g;
    const [x, y] = Pheromone.center(c, r);
    const v = g.pher.at(c, r);
    return {
      x: (c + 0.5) / GRID,
      y: 1 - (r + 0.5) / GRID,
      dist: Math.hypot(x - g.rest[0], y - g.rest[1]) / Math.hypot(W, H),
      pher: v / (1 + v),
      recent: g.zoneRecent(zoneOf(x, y)),
    };
  }

  chance(c: number, r: number): [number, boolean, Features] {
    const f = this.features(c, r);
    if (this.g.model.ready(this.count)) return [this.g.model.predict(f), true, f];
    return [f.recent, false, f];
  }

  choose(band: number | null = null, restrict: Set<string> | null = null): Spawn {
    const g = this.g;
    const s = this.count;
    this.count += 1;
    const cols: number[] = [];
    for (let c = 1; c < GRID - 1; c++) cols.push(c); // edge columns stay empty (fruit fully on screen)
    let allowed: Cell[] = [];
    for (let r = 0; r < GRID; r++) {
      const y = Pheromone.center(0, r)[1];
      if (band !== null && g.bandOfY(y) !== band) continue;
      for (const c of cols) {
        if (restrict && !restrict.has(zoneOf(...Pheromone.center(c, r)).join(","))) continue;
        allowed.push([c, r]);
      }
    }
    if (!allowed.length && band !== null) {
      // band thinner than a grid row
      const r = Math.min(Math.max(Math.floor((g.bandCenter(band) / H) * GRID), 0), GRID - 1);
      allowed = cols.map((c) => [c, r]);
    }
    if (!allowed.length) for (const c of cols) for (let r = 0; r < GRID; r++) allowed.push([c, r]);

    const pick = (c: number, r: number, method: string): Spawn => {
      const [p, modelOn, feats] = this.chance(c, r);
      return { c, r, p, modelOn, feats, method };
    };

    if (s < COLD_START) {
      // tier 1: LEFT / CENTRE / RIGHT cycling
      const third = s % 3;
      const cand = allowed.filter(([c]) => Math.floor((c / GRID) * 3) === third);
      const [c, r] = choice(cand.length ? cand : allowed);
      return pick(c, r, "zone_cycle");
    }
    const blend = 0.2 + 0.4 * Math.min(1, (s - COLD_START) / (BLEND_END - COLD_START));
    if (Math.random() >= blend) {
      const [c, r] = choice(allowed);
      return pick(c, r, "uniform");
    }

    const { norm, mask } = g.pher.frontier(); // Sobel frontier
    let cand = allowed.filter(([c, r]) => mask[r * GRID + c]);
    if (!cand.length) cand = [...allowed].sort((a, b) => norm[b[1] * GRID + b[0]] - norm[a[1] * GRID + a[0]]).slice(0, 10);
    let total = 1;
    for (const [, n] of this.cellStats.values()) total += n;
    const scored = cand.map(([c, r]) => {
      // MCTS: UCB1 per cell
      const [succ, n] = this.cellStats.get(`${c},${r}`) ?? [0, 0];
      const q = 0.5 * norm[r * GRID + c] + 0.5 * ((succ + 1) / (n + 2));
      const ucb = q + MCTS_C * Math.sqrt(Math.log(total + 1) / (n + 1)) + randUniform(0, 0.01);
      return { ucb, c, r };
    });
    scored.sort((a, b) => b.ucb - a.ucb);
    const top = scored.slice(0, MCTS_TOPK);
    if (g.model.ready(s)) {
      // the catch model picks among the MCTS top-k: closest to the target chance
      let best: Spawn | null = null;
      let bestD = Infinity;
      for (const { c, r } of top) {
        const f = this.features(c, r);
        const p = g.model.predict(f);
        if (Math.abs(p - g.targetP) < bestD) {
          bestD = Math.abs(p - g.targetP);
          best = { c, r, p, modelOn: true, feats: f, method: "mcts+prediction" };
        }
      }
      return best!;
    }
    return pick(top[0].c, top[0].r, "mcts");
  }

  record(c: number, r: number, caught: number) {
    const k = `${c},${r}`;
    const [s, n] = this.cellStats.get(k) ?? [0, 0];
    this.cellStats.set(k, [s + caught, n + 1]);
  }
}

// ================================================================ fixed-sequence rounds
/** [target, expected, broken] list for scale / pattern / surprise / song rounds. */
export function fixedSequence(rnd: RoundKind, opt: RoundOpt, notes: Note[]): [Note, Note, number][] {
  if (rnd === "scale") {
    const seq: Note[] = [];
    for (let r = 0; r < (opt.reps ?? 1); r++) {
      seq.push(...(r === 0 ? notes : notes.slice(1)), ...notes.slice(0, -1).reverse());
    }
    return seq.map((n) => [n, n, 0]);
  }
  if (rnd === "pattern") {
    const out: [Note, Note, number][] = [];
    for (let r = 0; r < (opt.reps ?? 1); r++) for (const n of notes) out.push([n, n, 0]);
    return out;
  }
  if (rnd === "surprise") {
    const out: [Note, Note, number][] = [];
    for (let k = 0; k < (opt.reps ?? 1); k++) {
      const rep: [Note, Note, number][] = notes.map((n) => [n, n, 0]);
      if (Math.random() < SURPRISE_P) {
        const i = randInt(2, notes.length - 1);
        const far = i >= notes.length / 2 ? notes[0] : notes[notes.length - 1];
        rep[i] = [far, notes[i], 1];
      }
      out.push(...rep);
    }
    return out;
  }
  if (rnd.startsWith("song_")) return (opt.song ?? []).map((n) => [n, n, 0]);
  return [];
}

// ================================================================ moving-fruit paths
export function makePath(stage: number, landing: [number, number], dur: number) {
  const [lx, ly] = landing;
  const side = choice([-1, 1]);
  type P = [number, number];
  let kind: "line" | "arc" | "turn";
  let pts: P[];
  if (stage === 1 || stage === 2) {
    pts = [[lx, -40], landing];
    kind = "line";
  } else if (stage === 3) {
    pts = [[Math.min(Math.max(lx + side * 260, 40), W - 40), -40], landing];
    kind = "line";
  } else if (stage === 4) {
    const sx = side < 0 ? -40 : W + 40;
    const sy = Math.max(40, ly - 200);
    pts = [[sx, sy], [(sx + lx) / 2, Math.min(sy, ly) - 220], landing];
    kind = "arc";
  } else {
    const start: P = [Math.min(Math.max(lx + side * 260, 40), W - 40), -40];
    const mid: P = [start[0] + 0.6 * (lx - start[0]) - side * 140, start[1] + 0.6 * (ly - start[1])];
    pts = [start, mid, landing];
    kind = "turn";
  }
  const lerp = (a: P, b: P, u: number): P => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const at = (u: number): P => {
    if (kind === "line") return lerp(pts[0], pts[1], u);
    if (kind === "arc") {
      const [a, c, b] = pts;
      if (u <= 1) {
        return [
          (1 - u) ** 2 * a[0] + 2 * (1 - u) * u * c[0] + u * u * b[0],
          (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * c[1] + u * u * b[1],
        ];
      }
      return [b[0] + 2 * (b[0] - c[0]) * (u - 1), b[1] + 2 * (b[1] - c[1]) * (u - 1)];
    }
    const [a, m, b] = pts;
    return u < 0.6 ? lerp(a, m, u / 0.6) : lerp(m, b, (u - 0.6) / 0.4);
  };
  return { pos: (t: number) => at(t / dur), name: ANTIC_STAGES[stage][0] };
}
