import { describe, expect, it } from "vitest";
import { CatchModel, fixedSequence, makePath, Pheromone } from "./adaptive";
import { GRID, LAYERS } from "./config";
import { Kalman, percentile, slope } from "./math";
import { motorScore } from "./score";

describe("Kalman", () => {
  it("tracks a constant-velocity hand and predicts ahead", () => {
    const kf = new Kalman();
    for (let i = 0; i <= 60; i++) kf.update([100 + 300 * (i / 30), 200], i / 30);
    const [vx, vy] = kf.vel();
    expect(vx).toBeGreaterThan(280);
    expect(vx).toBeLessThan(320);
    expect(Math.abs(vy)).toBeLessThan(10);
    expect(kf.ahead(0.1)[0]).toBeCloseTo(700 + 30, -1);
  });
});

describe("Pheromone", () => {
  it("starts with the 3x3 seed and finds a frontier around catches", () => {
    const p = new Pheromone();
    expect(p.at(10, 10)).toBeCloseTo(0.3);
    expect(p.at(0, 0)).toBe(0);
    for (let i = 0; i < 5; i++) p.deposit(480, 360, 1);
    const { mask } = p.frontier();
    expect(mask.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(mask[10 * GRID + 10]).toBe(0); // the comfortable centre itself is not the frontier
  });

  it("carries a saved map over with the carry factor", () => {
    const saved = Array(GRID * GRID).fill(0);
    saved[5] = 2;
    expect(new Pheromone(saved, 0.5).g[5]).toBeCloseTo(1);
    expect(new Pheromone(saved, 0).at(10, 10)).toBeCloseTo(0.3); // carry 0 = fresh map
  });
});

describe("rounds", () => {
  it("scale round matches the Python order (9 fruits for 3 notes, 2 reps)", () => {
    const seq = fixedSequence("scale", { reps: 2 }, LAYERS[1].notes).map((s) => s[0]);
    expect(seq).toEqual(["Sa", "Re", "Ga", "Re", "Sa", "Re", "Ga", "Re", "Sa"]);
  });
  it("moving paths end at the landing point", () => {
    for (const stage of [1, 2, 3, 4, 5]) {
      const { pos } = makePath(stage, [400, 300], 2);
      const [x, y] = pos(2);
      expect(x).toBeCloseTo(400);
      expect(y).toBeCloseTo(300);
    }
  });
});

describe("catch model", () => {
  it("pre-trains: higher-up cells predicted harder when the patient misses them", () => {
    const rows: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const y = Math.random();
      rows.push([0.5, y, 0.3, 0.2, 0.5, y < 0.5 ? 1 : 0]);
    }
    const m = new CatchModel(rows);
    const f = (y: number) => ({ x: 0.5, y, dist: 0.3, pher: 0.2, recent: 0.5 });
    expect(m.predict(f(0.1))).toBeGreaterThan(m.predict(f(0.9)));
    expect(m.ready(15)).toBe(true);
  });
});

describe("helpers and score", () => {
  it("percentile and slope behave like numpy", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([0, 10], 5)).toBeCloseTo(0.5);
    expect(slope([0, 1, 2], [1, 3, 5])).toBeCloseTo(2);
  });
  it("motor score is 0-100 and needs enough data", () => {
    const s = motorScore({
      reachX: 0.5, reachY: 0.5, maxVerticalExt: 0.85, pathEfficiency: 0.9, correctionsPerReach: 0,
      aimingTimeS: 0.8, catchRate: 1, endpointErrorPx: 0, goodFormPct: 100,
    });
    expect(s?.total).toBe(100);
    expect(motorScore({
      reachX: null, reachY: null, maxVerticalExt: null, pathEfficiency: null, correctionsPerReach: null,
      aimingTimeS: 2, catchRate: 0.5, endpointErrorPx: null, goodFormPct: null,
    })).toBeNull();
  });
});
