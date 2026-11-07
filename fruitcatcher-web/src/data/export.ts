// CSV downloads in exactly the layout of the Python version's files (same snake_case columns, same
// order, the session_id / participant / group / mode / layer columns on every row), so web and Python
// data can be put together for research or model training.
import { toCsv } from "../app/format";
import { SEQUENCE } from "../engine/config";
import { framesToCsv } from "./frames";
import type { Assessment, DataStore, Patient, SessionDoc } from "./types";
import { makeZip } from "./zip";

// Column lists copied from fruitcatcher_1cam.py (TRIAL_FIELDS, REP_FIELDS, SESSION_FIELDS).
export const TRIAL_FIELDS = [
  "session_id", "participant", "group", "mode", "layer", "round", "trial", "round_pos", "target_note",
  "expected_note", "pattern_broken", "band", "n_bands", "silent", "moving", "antic_stage", "path_type",
  "fruit_x", "fruit_y", "cell_col", "cell_row", "zone", "spawn_method", "feat_x", "feat_y", "feat_dist",
  "feat_pher", "feat_recent", "pred_catch_prob", "model_on", "radius_px", "time_limit_s", "cue_time",
  "fruit_time", "onset_time", "intent_time", "catch_time", "caught", "caught_with_lean", "aiming_time",
  "reaction_time", "anticipated", "first_direction_correct", "max_speed", "avg_speed", "v_variation",
  "max_vertical_ext", "in_out_count", "velocity_peaks", "corrections", "path_efficiency", "endpoint_error_px",
  "note_error", "pred_error_px", "interception_error_px", "strategy", "lean_max", "hike_max", "elbow_min",
  "elbow_max", "shoulder_max", "depth_mean", "depth_max", "counted",
] as const;

export const REP_FIELDS = [
  "session_id", "participant", "rep", "t_start", "duration_s", "distance_px", "path_px", "straightness",
  "peak_speed", "target_note", "lean_max", "hike_max", "good_form", "elbow_min", "elbow_max", "shoulder_max",
] as const;

export const SESSION_FIELDS = [
  "session_id", "date", "participant", "group", "mode", "layer", "layer_name", "completed", "trials_done",
  "catches", "catch_rate", "silent_catch_rate", "top_note", "top_note_catches", "top_note_attempts",
  "per_note", "reps", "reps_today", "daily_goal", "good_form_pct", "lean_mean_pct", "lean_max_pct",
  "hike_max_pct", "elbow_min_deg", "elbow_max_deg", "shoulder_max_deg", "aiming_time_s", "max_speed_px_s",
  "avg_speed_px_s", "v_variation", "max_vertical_ext", "in_out_count", "velocity_peaks", "path_efficiency",
  "endpoint_error_px", "note_error", "pred_error_px", "corrections_per_reach", "intent_time_s", "model_on_pct",
  "mean_pred_catch", "brier_model", "brier_baseline", "reachability", "anticipation_stage", "moving_trials",
  "moving_catch_rate", "interception_error_px", "anticipating_pct", "moving_onset_s", "static_moving_gap",
  "sound_first_anticipation_rate", "rt_normal_s", "rt_surprise_s", "first_dir_correct_on_surprise",
  "learning_rate_catch_per10", "learning_rate_aim_per10", "learning_rate_sessions", "pheromone_coverage",
  "frontier_cells", "mean_pheromone", "reach_x", "reach_y", "depth_range", "tracking_loss_pct", "pain_before",
  "pain_after", "decision", "next_layer",
] as const;

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const snakeKeys = (o: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
const ordered = (cols: readonly string[], row: Record<string, unknown>) =>
  Object.fromEntries(cols.map((c) => [c, row[c] ?? ""]));

const trialRows = (s: SessionDoc, participant: string) => (s.trials ?? []).map((t) => ordered(TRIAL_FIELDS, {
  ...snakeKeys(t), session_id: s.sessionId, participant, group: s.group, mode: "auto", layer: s.layer,
}));
const repRowsOf = (s: SessionDoc, participant: string) =>
  (s.repRows ?? []).map((r) => ordered(REP_FIELDS, { ...snakeKeys(r), session_id: s.sessionId, participant }));

/** trials.csv: one row per fruit. */
export const trialsCsv = (s: SessionDoc, participant: string) => toCsv(trialRows(s, participant));

/** reps.csv: one row per counted reach. */
export const repsCsv = (s: SessionDoc, participant: string) => toCsv(repRowsOf(s, participant));

/** sessions.csv: one row per part, the Python columns then the web's own (visit, start time, score, song lines). */
export const summaryCsv = (s: SessionDoc, participant: string) => toCsv([summaryRow(s, participant)]);

function summaryRow(s: SessionDoc, participant: string) {
  const d = new Date(s.date);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const row = {
    ...snakeKeys(s), participant, mode: "auto",
    // local "YYYY-MM-DD HH:MM", as datetime.now().strftime("%Y-%m-%d %H:%M") in the Python version
    date: Number.isNaN(d.getTime()) ? s.date
      : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
    reachability: (s.reachMap ?? []).map((z) => `${z.zone}:${Math.round(z.p * 100)}%`).join("; "),
    next_layer: SEQUENCE[s.nextLevel] ?? "",
  };
  return {
    ...ordered(SESSION_FIELDS, row),
    visit_id: s.visitId, started_at: new Date(s.startedAt).toISOString(),
    score: s.score?.total ?? "", per_line: s.perLine ? JSON.stringify(s.perLine) : "",
  };
}

/** pheromone/<session>.csv: the final 20 x 20 ability map, 4 decimals (numpy.savetxt "%.4f"). */
export function heatMapCsv(s: SessionDoc) {
  const g = s.pheromone ?? [];
  const rows: string[] = [];
  for (let r = 0; r * 20 < g.length; r++) rows.push(g.slice(r * 20, r * 20 + 20).map((v) => v.toFixed(4)).join(","));
  return rows.join("\n");
}

/** fugl_meyer.csv: the therapist-entered FMA-UE scores. */
export function fmaCsv(list: Assessment[], participant: string) {
  return toCsv(list.map((a) => ({
    participant, date: a.date, fma_total: a.fmaTotal, fma_a: a.fmaA, fma_b: a.fmaB, fma_c: a.fmaC, fma_d: a.fmaD,
    notes: a.notes, entered_at: new Date(a.createdAt).toISOString(),
  })));
}

/** Everything saved for one patient, as one .zip laid out like the Python data folder:
 *  sessions.csv, trials.csv, reps.csv (all parts together), frames/<session>.csv, pheromone/<session>.csv,
 *  fugl_meyer.csv, patient.csv (details) and record.json (progress: level, zone and note stats, history...). */
export async function exportPatient(store: DataStore, uid: string, p: Patient, onStep?: (done: number, total: number) => void) {
  const list = await store.listSessions(uid, p.id);
  const sessions: SessionDoc[] = [];
  const files: Record<string, string> = {};
  for (const [i, ls] of list.entries()) {
    onStep?.(i, list.length);
    const s = await store.getSession(uid, p.id, ls.sessionId);
    if (!s) continue;
    sessions.push(s);
    const frames = await store.getFrames(uid, p.id, s.sessionId);
    if (frames.length) files[`frames/${s.sessionId}.csv`] = framesToCsv(frames);
    if (s.pheromone?.length) files[`pheromone/${s.sessionId}.csv`] = heatMapCsv(s);
  }
  onStep?.(list.length, list.length);
  const fma = await store.listAssessments(uid, p.id);
  const code = p.code;
  files["sessions.csv"] = toCsv(sessions.map((s) => summaryRow(s, code)));
  files["trials.csv"] = toCsv(sessions.flatMap((s) => trialRows(s, code)));
  files["reps.csv"] = toCsv(sessions.flatMap((s) => repRowsOf(s, code)));
  files["fugl_meyer.csv"] = fmaCsv(fma, code);
  files["patient.csv"] = toCsv([{
    participant: code, group: p.group, affected_side: p.affectedSide, birth_year: p.birthYear, sex: p.sex,
    stroke_date: p.strokeDate, notes: p.notes, created_at: new Date(p.createdAt).toISOString(),
    last_session_at: p.lastSessionAt ? new Date(p.lastSessionAt).toISOString() : "", latest_score: p.latestScore,
    sessions_saved: sessions.length,
  }]);
  files["record.json"] = JSON.stringify({ id: code, group: p.group, ...p.progress }, null, 2);
  // empty CSVs (e.g. no Fugl-Meyer entered yet) are left out
  for (const k of Object.keys(files)) if (!files[k]) delete files[k];
  return makeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${code}_export/${k}`, v])));
}
