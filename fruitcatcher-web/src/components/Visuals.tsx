import clsx from "clsx";
import { useMemo } from "react";
import { Pheromone } from "../engine/adaptive";
import { GRID } from "../engine/config";
import { jet } from "../engine/draw";
import { SCORE_HELP, SCORE_WEIGHTS } from "../engine/score";
import type { MotorScore, ScoreParts } from "../engine/types";

/** 20x20 ability map: warm = caught often, white outline = the edge where new fruits go. */
export function HeatMap({ grid, className }: { grid: number[] | null | undefined; className?: string }) {
  const cells = useMemo(() => {
    if (!grid || grid.length !== GRID * GRID) return null;
    const { mask } = new Pheromone(grid, 1).frontier();
    const mx = Math.max(1e-6, ...grid);
    return grid.map((v, i) => ({ v: v / mx, edge: mask[i] === 1 }));
  }, [grid]);
  if (!cells) return <div className={clsx("flex aspect-[4/3] items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-400", className)}>No map yet</div>;
  return (
    <div className={clsx("grid aspect-[4/3] overflow-hidden rounded-lg bg-slate-900", className)} style={{ gridTemplateColumns: `repeat(${GRID}, 1fr)` }}>
      {cells.map(({ v, edge }, i) => {
        const [r, g, b] = jet(v);
        return (
          <div key={i} title={`${Math.round(v * 100)}%`}
            style={{ backgroundColor: `rgba(${r},${g},${b},${0.2 + 0.8 * v})`, outline: edge ? "1.5px solid white" : undefined, outlineOffset: -1.5 }} />
        );
      })}
    </div>
  );
}

const ZONE_POS = ["UL", "UC", "UR", "ML", "MC", "MR", "LL", "LC", "LR"];

/** 3x3 chance of catching a fruit in each part of the screen. */
export function ReachMap({ map }: { map: { zone: string; p: number }[] | undefined }) {
  const by = Object.fromEntries((map ?? []).map((m) => [m.zone, m.p]));
  return (
    <div>
      <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-1.5 text-xs">
        <span />
        {["Left", "Centre", "Right"].map((h) => <span key={h} className="text-center text-slate-400">{h}</span>)}
        {["Top", "Mid", "Low"].map((row, ri) => (
          <div key={row} className="contents">
            <span className="flex items-center pr-1 text-slate-400">{row}</span>
            {ZONE_POS.slice(ri * 3, ri * 3 + 3).map((z) => {
              const p = by[z];
              return (
                <div key={z} className={clsx("flex h-12 items-center justify-center rounded-lg border-2 text-sm font-semibold tabular-nums",
                  p == null ? "border-slate-200 text-slate-300" : p >= 0.7 ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                    : p >= 0.4 ? "border-amber-400 bg-amber-50 text-amber-700" : "border-red-300 bg-red-50 text-red-700")}>
                  {p == null ? "—" : `${Math.round(p * 100)}%`}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const PART_LABEL: Record<keyof ScoreParts, string> = {
  reach: "Reach", smoothness: "Smoothness", speed: "Speed", accuracy: "Accuracy", posture: "Posture",
};

export function ScoreBreakdown({ score }: { score: MotorScore | null | undefined }) {
  if (!score) return <p className="text-sm text-slate-500">Not enough data in this part for a score.</p>;
  return (
    <div className="space-y-3">
      {(Object.keys(PART_LABEL) as (keyof ScoreParts)[]).map((k) => {
        const v = score.parts[k];
        return (
          <div key={k} title={SCORE_HELP[k]}>
            <div className="flex justify-between text-xs">
              <span className="font-medium text-slate-700">{PART_LABEL[k]} <span className="text-slate-400">· {Math.round(SCORE_WEIGHTS[k] * 100)}%</span></span>
              <span className="tabular-nums text-slate-600">{v == null ? "no data" : v}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={clsx("h-full rounded-full", v == null ? "" : v >= 70 ? "bg-emerald-500" : v >= 40 ? "bg-amber-500" : "bg-red-500")}
                style={{ width: `${v ?? 0}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ScoreRing({ value, size = 120 }: { value: number | null | undefined; size?: number }) {
  const r = 52, c = 2 * Math.PI * r;
  const v = value ?? 0;
  const color = value == null ? "#cbd5e1" : v >= 70 ? "#10b981" : v >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <svg viewBox="0 0 120 120" width={size} height={size}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="#f1f5f9" strokeWidth="10" />
      <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${(c * v) / 100} ${c}`} transform="rotate(-90 60 60)" />
      <text x="60" y="62" textAnchor="middle" fontSize="30" fontWeight="700" fill="#0f172a">{value ?? "—"}</text>
      <text x="60" y="82" textAnchor="middle" fontSize="11" fill="#64748b">out of 100</text>
    </svg>
  );
}
