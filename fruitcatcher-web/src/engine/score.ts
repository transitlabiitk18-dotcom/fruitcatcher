// Motor performance score (0-100): a transparent ESTIMATE built from the game's own measures.
// It is not a Fugl-Meyer score. Therapist-entered FMA scores are stored separately so that a
// proper prediction model can be trained and validated later.
import { clamp } from "./math";
import type { MotorScore, ScoreParts, SessionSummary } from "./types";

export const SCORE_WEIGHTS: Record<keyof ScoreParts, number> = {
  reach: 0.25, smoothness: 0.2, speed: 0.2, accuracy: 0.15, posture: 0.2,
};

export const SCORE_HELP: Record<keyof ScoreParts, string> = {
  reach: "How far the arm reaches: calibrated reach range and highest point reached.",
  smoothness: "Straight, smooth reaches: path efficiency and few corrections per reach.",
  speed: "Time from fruit appearing to catching it (0.8 s or less = full marks, 4 s = none).",
  accuracy: "Fruits caught and how close the hand stops to the fruit.",
  posture: "Share of reaches made without trunk lean or shoulder hike.",
};

const u = (v: number) => clamp(v, 0, 1);

export function motorScore(s: Pick<SessionSummary,
  "reachX" | "reachY" | "maxVerticalExt" | "pathEfficiency" | "correctionsPerReach" | "aimingTimeS" |
  "catchRate" | "endpointErrorPx" | "goodFormPct">): MotorScore | null {
  const parts: Partial<Record<keyof ScoreParts, number>> = {};
  if (s.reachX != null && s.reachY != null) {
    const ext = s.maxVerticalExt ?? 0;
    parts.reach = 100 * (0.6 * u((s.reachX + s.reachY) / 2 / 0.5) + 0.4 * u(ext / 0.85));
  }
  if (s.pathEfficiency != null) {
    parts.smoothness = 100 * (0.6 * u(s.pathEfficiency / 0.9) + 0.4 * u(1 - (s.correctionsPerReach ?? 0) / 3));
  }
  if (s.aimingTimeS != null) parts.speed = 100 * u((4 - s.aimingTimeS) / 3.2);
  if (s.catchRate != null) {
    const err = s.endpointErrorPx == null ? 0.5 : u(1 - s.endpointErrorPx / 240);
    parts.accuracy = 100 * (0.5 * s.catchRate + 0.5 * err);
  }
  if (s.goodFormPct != null) parts.posture = s.goodFormPct;

  const keys = Object.keys(parts) as (keyof ScoreParts)[];
  if (keys.length < 3) return null; // too little data for a fair score
  const wsum = keys.reduce((a, k) => a + SCORE_WEIGHTS[k], 0);
  const total = keys.reduce((a, k) => a + SCORE_WEIGHTS[k] * parts[k]!, 0) / wsum;
  const round = (v: number | undefined) => (v == null ? null : Math.round(v));
  return {
    total: Math.round(total),
    parts: {
      reach: round(parts.reach), smoothness: round(parts.smoothness), speed: round(parts.speed),
      accuracy: round(parts.accuracy), posture: round(parts.posture),
    },
  };
}
