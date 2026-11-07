// Small numeric helpers (numpy stand-ins) and the Kalman filter.

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const r3 = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;

export const nums = (vals: (number | null | undefined)[]) =>
  vals.filter((v): v is number => v != null && Number.isFinite(v));

export function mean(vals: (number | null | undefined)[]): number | null {
  const v = nums(vals);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export const meanOf = (vals: (number | null | undefined)[]) => r3(mean(vals));

export function std(vals: number[]): number {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
}

/** numpy.percentile with linear interpolation. */
export function percentile(vals: number[], q: number): number {
  const s = [...vals].sort((a, b) => a - b);
  const pos = ((s.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (vals: number[]) => percentile(vals, 50);

/** Least-squares slope (numpy.polyfit degree 1). */
export function slope(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || new Set(xs).size < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return num / den;
}

export const maxOf = (vals: (number | null)[]) => {
  const v = nums(vals);
  return v.length ? Math.max(...v) : null;
};
export const minOf = (vals: (number | null)[]) => {
  const v = nums(vals);
  return v.length ? Math.min(...v) : null;
};

/** Angle at b between b->a and b->c, degrees. */
export function angleDeg(a: [number, number], b: [number, number], c: [number, number]): number | null {
  const v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (n < 1e-6) return null;
  return (Math.acos(clamp((v1x * v2x + v1y * v2y) / n, -1, 1)) * 180) / Math.PI;
}

export const randUniform = (a: number, b: number) => a + Math.random() * (b - a);
export const randInt = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1)); // inclusive
export const choice = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ================================================================ Kalman
/** Constant-velocity Kalman filter on the wrist (screen px). State x, y, vx, vy.
 *  x and y are independent, so each axis is a 2x2 filter (same result as the 4x4 version). */
export class Kalman {
  private x: number[] | null = null; // [x, y, vx, vy]
  private P: number[][] = []; // per axis [pp, pv, vv] (symmetric 2x2 covariance)
  private t = 0;
  constructor(private sa = 1500.0, private measPx = 6.0) {}

  reset() {
    this.x = null;
  }
  get ready() {
    return this.x !== null;
  }

  private predict(t: number) {
    const dt = clamp(t - this.t, 1e-3, 0.2);
    this.t = t;
    const x = this.x!;
    const q = this.sa ** 2;
    for (let a = 0; a < 2; a++) {
      x[a] += x[a + 2] * dt;
      const [pp, pv, vv] = this.P[a];
      // P = F P F^T + G G^T q, with F = [[1, dt], [0, 1]], G = [dt^2/2, dt]
      this.P[a] = [
        pp + 2 * dt * pv + dt * dt * vv + (q * dt ** 4) / 4,
        pv + dt * vv + (q * dt ** 3) / 2,
        vv + q * dt * dt,
      ];
    }
  }

  update(z: [number, number], t: number) {
    if (this.x === null) {
      this.x = [z[0], z[1], 0, 0];
      this.P = [[40, 0, 400], [40, 0, 400]]; // diag(40, 40, 400, 400)
      this.t = t;
      return;
    }
    this.predict(t);
    const R = this.measPx ** 2;
    const x = this.x;
    for (let a = 0; a < 2; a++) {
      const [pp, pv, vv] = this.P[a];
      const s = pp + R;
      const k0 = pp / s;
      const k1 = pv / s;
      const y = z[a] - x[a];
      x[a] += k0 * y;
      x[a + 2] += k1 * y;
      this.P[a] = [(1 - k0) * pp, (1 - k0) * pv, vv - k1 * pv];
    }
  }

  coast(t: number) {
    if (this.ready) this.predict(t);
  }
  pos(): [number, number] {
    return [this.x![0], this.x![1]];
  }
  vel(): [number, number] {
    return [this.x![2], this.x![3]];
  }
  ahead(dt: number): [number, number] {
    const x = this.x!;
    return [x[0] + x[2] * dt, x[1] + x[3] * dt];
  }
}
