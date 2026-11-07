import { describe, expect, it } from "vitest";
import { REP_FIELDS, SESSION_FIELDS, TRIAL_FIELDS, heatMapCsv, repsCsv, summaryCsv, trialsCsv } from "./export";
import type { SessionDoc } from "./types";

const s = {
  sessionId: "20261103_162007_p1", visitId: "v1", date: "2026-11-03", startedAt: 0, group: "S", layer: 1,
  nextLevel: 1, reachMap: [{ zone: "top-left", p: 0.5 }], perLine: null, score: { total: 90 },
  pheromone: Array.from({ length: 400 }, (_, i) => i / 400),
  trials: [{ round: "scale", trial: 1, fruitX: 100, fruitY: 200, caught: 1 }],
  repRows: [{ rep: 1, tStart: 1.5, peakSpeed: 300 }],
} as unknown as SessionDoc;

const header = (csv: string) => csv.split("\n")[0].split(",");

describe("CSV export matches the Python files", () => {
  it("trials.csv has the Python columns in order, with the session columns filled", () => {
    const csv = trialsCsv(s, "P01");
    expect(header(csv)).toEqual([...TRIAL_FIELDS]);
    const row = Object.fromEntries(header(csv).map((c, i) => [c, csv.split("\n")[1].split(",")[i]]));
    expect(row).toMatchObject({ session_id: s.sessionId, participant: "P01", group: "S", mode: "auto", layer: "1", fruit_x: "100" });
  });

  it("reps.csv has the Python columns in order", () => {
    expect(header(repsCsv(s, "P01"))).toEqual([...REP_FIELDS]);
  });

  it("sessions.csv starts with the Python columns and maps the level back to a layer number", () => {
    const csv = summaryCsv(s, "P01");
    const cols = header(csv);
    expect(cols.slice(0, SESSION_FIELDS.length)).toEqual([...SESSION_FIELDS]);
    expect(csv.split("\n")[1].split(",")[cols.indexOf("next_layer")]).toBe("2");
  });

  it("the heat map is 20 rows of 20 values", () => {
    const rows = heatMapCsv(s).split("\n");
    expect(rows).toHaveLength(20);
    expect(rows[0].split(",")).toHaveLength(20);
  });
});
