import { ArrowLeft, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useClinician } from "../app/auth";
import { download, fmtDateTime, num, pct } from "../app/format";
import { HeatMap, ReachMap, ScoreBreakdown, ScoreRing } from "../components/Visuals";
import { Alert, Badge, Button, Card, Spinner } from "../components/ui";
import { heatMapCsv, repsCsv, summaryCsv, trialsCsv } from "../data/export";
import { framesToCsv } from "../data/frames";
import { store } from "../data/store";
import type { SessionDoc } from "../data/types";

/** Every saved measure of one part, in plain words (the Python clinician view). */
function groups(s: SessionDoc): [string, [string, string][]][] {
  const two = (a: number | null, b: number | null, suf = "") => `${num(a)} / ${num(b)}${suf}`;
  return [
    ["Performance", [
      ["Fruits tried", String(s.trialsDone)], ["Fruits caught", `${s.catches} (${pct(s.catchRate)})`],
      ["Catch rate, silent tries", pct(s.silentCatchRate)],
      ["Top note", `${s.topNote}: ${s.topNoteCatches} of ${s.topNoteAttempts}`], ["Per note", s.perNote || "—"],
    ]],
    ["Reps and posture", [
      ["Reps this part", String(s.reps)], ["Reps today / goal", `${s.repsToday} / ${s.dailyGoal}`],
      ["Good form", num(s.goodFormPct, 0, "%")], ["Lean mean / max (%)", two(s.leanMeanPct, s.leanMaxPct)],
      ["Shoulder lift max (%)", num(s.hikeMaxPct)], ["Elbow angle min / max", two(s.elbowMinDeg, s.elbowMaxDeg, " deg")],
      ["Shoulder angle max", num(s.shoulderMaxDeg, 0, " deg")],
    ]],
    ["Movement", [
      ["Aiming time", num(s.aimingTimeS, 2, " s")], ["Intent time", num(s.intentTimeS, 2, " s")],
      ["Max speed", num(s.maxSpeedPxS, 0, " px/s")], ["Average speed", num(s.avgSpeedPxS, 0, " px/s")],
      ["Speed variation", num(s.vVariation, 0)], ["Path efficiency", num(s.pathEfficiency)],
      ["Endpoint error", num(s.endpointErrorPx, 0, " px")], ["Note error", num(s.noteError)],
      ["Corrections per reach", num(s.correctionsPerReach)], ["Velocity peaks", num(s.velocityPeaks)],
      ["Max vertical reach", num(s.maxVerticalExt)], ["In / out of target", num(s.inOutCount)],
    ]],
    ["Prediction", [
      ["Catch model on", num(s.modelOnPct, 0, "% of fruits")], ["Mean predicted catch", pct(s.meanPredCatch)],
      ["Brier model / baseline", two(s.brierModel, s.brierBaseline)], ["Hand prediction error", num(s.predErrorPx, 1, " px")],
    ]],
    ["Moving fruit", [
      ["Stage", String(s.anticipationStage)], ["Moving fruits tried", String(s.movingTrials)],
      ["Moving catch rate", pct(s.movingCatchRate)], ["Interception error", num(s.interceptionErrorPx, 0, " px")],
      ["Anticipating", num(s.anticipatingPct, 0, "%")], ["Movement start", num(s.movingOnsetS, 2, " s")],
      ["Still vs moving gap", num(s.staticMovingGap)], ["Sound-first anticipation", pct(s.soundFirstAnticipationRate)],
      ["Reaction normal / surprise", two(s.rtNormalS, s.rtSurpriseS, " s")],
      ["First direction on surprise", pct(s.firstDirCorrectOnSurprise)],
    ]],
    ["Learning and map", [
      ["Catch change per 10 fruits", num(s.learningRateCatchPer10)], ["Aim time change per 10", num(s.learningRateAimPer10)],
      ["Learning across sessions", num(s.learningRateSessions)], ["Map covered", pct(s.pheromoneCoverage)],
      ["Edge cells", String(s.frontierCells)], ["Reach x / y", two(s.reachX, s.reachY)],
      ["Depth range", num(s.depthRange)], ["Tracking lost", num(s.trackingLossPct, 1, "%")],
    ]],
    ["Pain and result", [
      ["Pain before / after", `${s.painBefore ?? "—"} / ${s.painAfter ?? "—"} (0-10)`], ["Result", s.decision || "—"],
    ]],
  ];
}

export default function SessionPage() {
  const { id, sid } = useParams();
  const { uid } = useClinician();
  const [s, setS] = useState<SessionDoc | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(""); // patient code (P01), the "participant" column of the CSVs

  useEffect(() => {
    store.getSession(uid, id!, sid!).then(setS).catch(() => setS(null));
    store.getPatient(uid, id!).then((p) => setCode(p?.code ?? "")).catch(() => {});
  }, [uid, id, sid]);

  if (s === undefined) return <Spinner />;
  if (!s) return <Alert tone="error">Session not found.</Alert>;

  const base = `${s.sessionId}`;
  const { trials, repRows } = s;
  return (
    <div className="space-y-6">
      <Link to={`/patients/${id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="size-4" /> Back to patient</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{s.layerName}</h1>
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
            {fmtDateTime(s.startedAt)} {s.completed ? <Badge tone="green">Completed</Badge> : <Badge tone="amber">Stopped early</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => download(`${base}_summary.csv`, summaryCsv(s, code))}><Download className="size-4" /> Summary</Button>
          <Button variant="outline" size="sm" disabled={!trials?.length} onClick={() => download(`${base}_trials.csv`, trialsCsv(s, code))}><Download className="size-4" /> Trials</Button>
          <Button variant="outline" size="sm" disabled={!repRows?.length} onClick={() => download(`${base}_reps.csv`, repsCsv(s, code))}><Download className="size-4" /> Reps</Button>
          <Button variant="outline" size="sm" loading={busy} onClick={async () => {
            setBusy(true);
            try { download(`${base}_frames.csv`, framesToCsv(await store.getFrames(uid, id!, sid!))); } finally { setBusy(false); }
          }}><Download className="size-4" /> Frames</Button>
          <Button variant="outline" size="sm" disabled={!s.pheromone?.length} onClick={() => download(`${base}_pheromone.csv`, heatMapCsv(s))}><Download className="size-4" /> Heat map</Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Performance score">
          <div className="flex flex-col items-center gap-4">
            <ScoreRing value={s.score?.total} />
            <div className="w-full"><ScoreBreakdown score={s.score} /></div>
          </div>
        </Card>
        <Card title="Ability map at the end of this part">
          <HeatMap grid={s.pheromone} />
          <p className="mt-2 text-xs text-slate-500">Warm = caught often. White outlines = edge, where new fruits go.</p>
        </Card>
        <Card title="Chance to catch a fruit">
          <ReachMap map={s.reachMap} />
          {s.perLine.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Song lines (caught / tries)</h3>
              <ul className="space-y-1 text-sm">
                {s.perLine.map((l, i) => (
                  <li key={i} className="flex justify-between gap-2"><span className="truncate">{i + 1}. {l.text}</span><span className="tabular-nums text-slate-600">{l.caught}/{l.tries}</span></li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {groups(s).map(([title, items]) => (
          <Card key={title} title={title}>
            <dl className="divide-y divide-slate-100 text-sm">
              {items.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-1.5">
                  <dt className="text-slate-500">{k}</dt><dd className="text-right font-medium tabular-nums text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
    </div>
  );
}
