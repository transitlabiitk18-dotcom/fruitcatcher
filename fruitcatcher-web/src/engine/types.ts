import type { Note, RoundKind } from "./config";

export type Group = "Y" | "O" | "S"; // young healthy, older healthy, stroke

/** The patient's memory between sessions (patients_all_layers/<ID>.json in the Python version). */
export interface Progress {
  level: number; // index into SEQUENCE: the part the next session starts at
  badStreak: number;
  sessions: number;
  stats: Record<string, [number, number]>; // "L<layer>:<note>" -> [caught, tries]
  zones: Record<string, [number, number]>; // "row,col" of the 3x3 screen zones -> [caught, tries]
  history: { sessionId: string; layer: number; catchRate: number | null; meanPred: number | null; decision: string }[];
  repsByDate: Record<string, number>;
  anticStage: number;
  aimMedian: number;
  pheromone: number[] | null; // 20x20 heat map kept between parts and sessions (row-major)
  modelRows: number[][]; // recent still trials [x, y, dist, pher, recent, caught] for pre-training
}

export const newProgress = (): Progress => ({
  level: 0, badStreak: 0, sessions: 0, stats: {}, zones: {}, history: [], repsByDate: {},
  anticStage: 1, aimMedian: 1.5, pheromone: null, modelRows: [],
});

export interface Features { x: number; y: number; dist: number; pher: number; recent: number }

export type Cell = [number, number]; // [col, row]

/** One fruit (trials.csv row). Empty values are null. */
export interface TrialRow {
  round: RoundKind; trial: number | null; roundPos: number;
  targetNote: Note; expectedNote: Note; patternBroken: number;
  band: number; nBands: number; silent: number; moving: number;
  anticStage: number | null; pathType: string;
  fruitX: number; fruitY: number; cellCol: number; cellRow: number; zone: string;
  spawnMethod: string; featX: number; featY: number; featDist: number; featPher: number; featRecent: number;
  predCatchProb: number; modelOn: number; radiusPx: number; timeLimitS: number;
  cueTime: number; fruitTime: number; onsetTime: number | null; intentTime: number | null; catchTime: number | null;
  caught: number; caughtWithLean: number; aimingTime: number | null; reactionTime: number | null;
  anticipated: number | null; firstDirectionCorrect: number | null;
  maxSpeed: number | null; avgSpeed: number | null; vVariation: number | null; maxVerticalExt: number | null;
  inOutCount: number; velocityPeaks: number; corrections: number; pathEfficiency: number | null;
  endpointErrorPx: number | null; noteError: number | null; predErrorPx: number | null;
  interceptionErrorPx: number | null; strategy: string;
  leanMax: number | null; hikeMax: number | null; elbowMin: number | null; elbowMax: number | null;
  shoulderMax: number | null; depthMean: number | null; depthMax: number | null; counted: number;
}

/** One counted reach (reps.csv row). */
export interface RepRow {
  rep: number; tStart: number; durationS: number; distancePx: number; pathPx: number;
  straightness: number | null; peakSpeed: number | null; targetNote: Note;
  leanMax: number | null; hikeMax: number | null; goodForm: number;
  elbowMin: number | null; elbowMax: number | null; shoulderMax: number | null;
}

/** frames/<session>.csv columns. */
export const FRAME_FIELDS = ["t", "seen", "raw_x", "raw_y", "x", "y", "pred_x", "pred_y", "pred_err",
  "speed", "band", "depth", "lean", "hike", "elbow", "shoulder", "fruit_x", "fruit_y"] as const;
export type FrameRow = (number | null)[];

export interface ScoreParts {
  reach: number | null; smoothness: number | null; speed: number | null; accuracy: number | null; posture: number | null;
}
export interface MotorScore { total: number; parts: ScoreParts }

/** One played part (sessions.csv row plus what the end screen needs). */
export interface SessionSummary {
  sessionId: string; visitId: string; date: string; startedAt: number;
  group: Group; layer: number; layerName: string; completed: boolean;
  trialsDone: number; catches: number; catchRate: number | null; silentCatchRate: number | null;
  topNote: string; topNoteCatches: number; topNoteAttempts: number; perNote: string;
  reps: number; repsToday: number; dailyGoal: number;
  goodFormPct: number | null; leanMeanPct: number | null; leanMaxPct: number | null; hikeMaxPct: number | null;
  elbowMinDeg: number | null; elbowMaxDeg: number | null; shoulderMaxDeg: number | null;
  aimingTimeS: number | null; maxSpeedPxS: number | null; avgSpeedPxS: number | null; vVariation: number | null;
  maxVerticalExt: number | null; inOutCount: number | null; velocityPeaks: number | null;
  pathEfficiency: number | null; endpointErrorPx: number | null; noteError: number | null;
  predErrorPx: number | null; correctionsPerReach: number | null; intentTimeS: number | null;
  modelOnPct: number | null; meanPredCatch: number | null; brierModel: number | null; brierBaseline: number | null;
  reachMap: { zone: string; p: number }[];
  anticipationStage: number; movingTrials: number; movingCatchRate: number | null;
  interceptionErrorPx: number | null; anticipatingPct: number | null; movingOnsetS: number | null;
  staticMovingGap: number | null; soundFirstAnticipationRate: number | null;
  rtNormalS: number | null; rtSurpriseS: number | null; firstDirCorrectOnSurprise: number | null;
  learningRateCatchPer10: number | null; learningRateAimPer10: number | null; learningRateSessions: number | null;
  pheromoneCoverage: number; frontierCells: number; meanPheromone: number;
  reachX: number | null; reachY: number | null; depthRange: number | null; trackingLossPct: number | null;
  painBefore: number | null; painAfter: number | null; decision: string; nextLevel: number;
  perLine: { text: string; caught: number; tries: number }[];
  pheromone: number[];
  score: MotorScore | null;
}

/** Everything one part produces, ready to save. */
export interface PartResult {
  summary: SessionSummary;
  trials: TrialRow[];
  reps: RepRow[];
  frames: FrameRow[];
}
