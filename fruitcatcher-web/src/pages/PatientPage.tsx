import clsx from "clsx";
import { Activity, ArrowLeft, ClipboardList, Download, Info, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useClinician } from "../app/auth";
import { GROUP_LABEL, SIDE_LABEL, fmtDate, fmtDateTime, pct, scoreTone } from "../app/format";
import { PatientForm } from "../components/PatientForm";
import { HeatMap, ReachMap, ScoreBreakdown, ScoreRing } from "../components/Visuals";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner, Stat, Textarea } from "../components/ui";
import { exportPatient } from "../data/export";
import { store } from "../data/store";
import type { Assessment, AssessmentInput, Patient, SessionDoc } from "../data/types";
import { ANTIC_STAGES, PART_BTN, SEQUENCE } from "../engine/config";

type Tab = "overview" | "sessions" | "fma" | "details";

export default function PatientPage() {
  const { id } = useParams();
  const { uid, profile } = useClinician();
  const nav = useNavigate();
  const [patient, setPatient] = useState<Patient | null | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionDoc[]>([]);
  const [fma, setFma] = useState<Assessment[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [err, setErr] = useState("");
  const [exporting, setExporting] = useState<string | null>(null); // progress text while exporting

  const load = useCallback(async () => {
    try {
      const [p, s, a] = await Promise.all([
        store.getPatient(uid, id!), store.listSessions(uid, id!), store.listAssessments(uid, id!),
      ]);
      setPatient(p);
      setSessions(s);
      setFma(a);
    } catch (e) {
      setErr((e as Error).message);
      setPatient(null);
    }
  }, [uid, id]);

  useEffect(() => void load(), [load]);

  if (patient === undefined) return <Spinner />;
  if (!patient) return <Alert tone="error">{err || "Patient not found."}</Alert>;

  const tabs: [Tab, string][] = [["overview", "Overview"], ["sessions", `Sessions (${sessions.length})`], ["fma", "Fugl-Meyer"], ["details", "Details"]];
  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="size-4" /> All patients</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{patient.code}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone="brand">{GROUP_LABEL[patient.group]}</Badge>
            <Badge>Affected side: {SIDE_LABEL[patient.affectedSide]}</Badge>
            {patient.birthYear && <Badge>Born {patient.birthYear}</Badge>}
            {patient.strokeDate && <Badge>Stroke {fmtDate(patient.strokeDate)}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" variant="outline" loading={exporting !== null} title="Download everything saved for this patient as CSV files (one .zip)"
            onClick={async () => {
              setErr("");
              setExporting("Preparing…");
              try {
                const zip = await exportPatient(store, uid, patient, (d, n) => setExporting(`Session ${Math.min(d + 1, n)} of ${n}…`));
                const url = URL.createObjectURL(zip);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${patient.code}_export_${new Date().toISOString().slice(0, 10)}.zip`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setErr(`Export failed: ${(e as Error).message}`);
              } finally {
                setExporting(null);
              }
            }}>
            {exporting === null && <Download className="size-5" />} {exporting ?? "Export data"}
          </Button>
          <Button size="lg" onClick={() => nav(`/patients/${patient.id}/play`)}><Play className="size-5" /> Start session</Button>
        </div>
      </div>
      {err && <Alert tone="error">{err}</Alert>}

      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)}
            className={clsx("-mb-px border-b-2 px-4 py-2.5 text-sm font-medium",
              tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800")}>
            {l}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview patient={patient} sessions={sessions} fma={fma} dailyGoal={profile.settings.dailyGoal} />}
      {tab === "sessions" && <Sessions patient={patient} sessions={sessions} />}
      {tab === "fma" && <Fma uid={uid} patient={patient} fma={fma} sessions={sessions} reload={load} />}
      {tab === "details" && <Details uid={uid} patient={patient} reload={load} />}
    </div>
  );
}

function Overview({ patient, sessions, fma, dailyGoal }: { patient: Patient; sessions: SessionDoc[]; fma: Assessment[]; dailyGoal: number }) {
  const scored = sessions.filter((s) => s.score);
  const last = scored[scored.length - 1];
  const lastAny = sessions[sessions.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const repsToday = patient.progress?.repsByDate?.[today] ?? 0;
  const prev = scored.length >= 2 ? scored[scored.length - 2].score!.total : null;
  const trend = last && prev != null ? last.score!.total - prev : null;

  const chart = useMemo(() => {
    const points = sessions.map((s) => ({
      t: s.startedAt, label: fmtDate(s.startedAt), score: s.score?.total ?? null,
      catchRate: s.catchRate == null ? null : Math.round(s.catchRate * 100), fma: null as number | null,
    }));
    for (const a of fma) {
      const t = new Date(a.date).getTime();
      points.push({ t, label: fmtDate(a.date), score: null, catchRate: null, fma: Math.round((a.fmaTotal / 66) * 100) });
    }
    return points.sort((a, b) => a.t - b.t);
  }, [sessions, fma]);

  if (!sessions.length) {
    return (
      <Card>
        <EmptyState icon={<Activity className="size-6" />} title="No sessions yet">
          Start the first session to calibrate {patient.code}'s reach and begin tracking progress.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Performance score" value={last ? `${last.score!.total} / 100` : "—"} tone={scoreTone(last?.score?.total)}
          sub={trend == null ? "Latest part played" : `${trend >= 0 ? "▲" : "▼"} ${Math.abs(trend)} since the previous part`} />
        <Stat label="Reps today" value={`${repsToday} / ${dailyGoal}`} tone={repsToday >= dailyGoal ? "good" : undefined} sub="Daily goal" />
        <Stat label="Current level" value={PART_BTN[SEQUENCE[patient.progress?.level ?? 0]].split(":")[0]} sub={PART_BTN[SEQUENCE[patient.progress?.level ?? 0]].split(": ")[1]} />
        <Stat label="Moving fruits" value={`Stage ${patient.progress?.anticStage ?? 1}`} sub={ANTIC_STAGES[patient.progress?.anticStage ?? 1][0]} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Latest performance score" className="lg:col-span-1">
          <div className="flex flex-col items-center gap-4">
            <ScoreRing value={last?.score?.total} />
            <div className="w-full"><ScoreBreakdown score={last?.score} /></div>
            <p className="flex gap-1.5 text-xs text-slate-500">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              An estimate built from game measures, not a clinical score. Enter Fugl-Meyer results in the Fugl-Meyer tab to compare.
            </p>
          </div>
        </Card>
        <Card title="Progress over time" className="lg:col-span-2">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line name="Performance score" dataKey="score" stroke="#0d9488" strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
                <Line name="Catch rate %" dataKey="catchRate" stroke="#f97316" strokeWidth={1.5} dot={{ r: 2 }} connectNulls />
                <Line name="Fugl-Meyer (% of 66)" dataKey="fma" stroke="#6366f1" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 4 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Ability map: where the patient succeeds">
          <HeatMap grid={patient.progress?.pheromone ?? lastAny?.pheromone} />
          <p className="mt-2 text-xs text-slate-500">Warm = caught often. White outlines = the edge of comfortable reach, where new fruits are placed.</p>
        </Card>
        <Card title="Chance to catch a fruit, by screen area">
          <ReachMap map={lastAny?.reachMap} />
          <p className="mt-3 text-xs text-slate-500">From the catch-prediction model at the end of the last part played ({fmtDateTime(lastAny.startedAt)}).</p>
        </Card>
      </div>
    </div>
  );
}

function Sessions({ patient, sessions }: { patient: Patient; sessions: SessionDoc[] }) {
  const nav = useNavigate();
  if (!sessions.length) {
    return <Card><EmptyState icon={<Activity className="size-6" />} title="No sessions yet">Sessions appear here after each part is played.</EmptyState></Card>;
  }
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-5 py-2.5 font-medium">Date</th><th className="px-5 py-2.5 font-medium">Part</th>
              <th className="px-5 py-2.5 font-medium">Status</th><th className="px-5 py-2.5 font-medium">Caught</th>
              <th className="px-5 py-2.5 font-medium">Score</th><th className="px-5 py-2.5 font-medium">Reps</th>
              <th className="px-5 py-2.5 font-medium">Good form</th><th className="px-5 py-2.5 font-medium">Pain before → after</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...sessions].reverse().map((s) => (
              <tr key={s.sessionId} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/patients/${patient.id}/sessions/${s.sessionId}`)}>
                <td className="px-5 py-3 whitespace-nowrap">{fmtDateTime(s.startedAt)}</td>
                <td className="px-5 py-3">{s.layerName}</td>
                <td className="px-5 py-3">{s.completed ? <Badge tone="green">Completed</Badge> : <Badge tone="amber">Stopped early</Badge>}</td>
                <td className="px-5 py-3 tabular-nums">{s.catches}/{s.trialsDone} <span className="text-slate-400">({pct(s.catchRate)})</span></td>
                <td className="px-5 py-3 tabular-nums">{s.score ? s.score.total : "—"}</td>
                <td className="px-5 py-3 tabular-nums">{s.reps}</td>
                <td className="px-5 py-3 tabular-nums">{s.goodFormPct == null ? "—" : `${s.goodFormPct}%`}</td>
                <td className="px-5 py-3 tabular-nums">{s.painBefore ?? "—"} → {s.painAfter ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const FMA_PARTS: [keyof AssessmentInput, string, number][] = [
  ["fmaA", "A. Shoulder / elbow / forearm", 36], ["fmaB", "B. Wrist", 10], ["fmaC", "C. Hand", 14], ["fmaD", "D. Coordination / speed", 6],
];

function Fma({ uid, patient, fma, sessions, reload }: { uid: string; patient: Patient; fma: Assessment[]; sessions: SessionDoc[]; reload(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const blank: AssessmentInput = { date: new Date().toISOString().slice(0, 10), fmaTotal: 0, fmaA: null, fmaB: null, fmaC: null, fmaD: null, notes: "" };
  const [v, setV] = useState<AssessmentInput>(blank);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const subSum = FMA_PARTS.reduce((a, [k]) => a + ((v[k] as number | null) ?? 0), 0);
  const anySub = FMA_PARTS.some(([k]) => v[k] != null);

  /** Game score nearest in time to each assessment (within 14 days). */
  const nearest = (date: string) => {
    const t = new Date(date).getTime();
    let best: SessionDoc | null = null;
    for (const s of sessions) {
      if (!s.score || Math.abs(s.startedAt - t) > 14 * 86400000) continue;
      if (!best || Math.abs(s.startedAt - t) < Math.abs(best.startedAt - t)) best = s;
    }
    return best;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const total = anySub ? subSum : v.fmaTotal;
    if (total < 0 || total > 66) return setErr("The FMA-UE total must be between 0 and 66.");
    setBusy(true);
    try {
      await store.addAssessment(uid, patient.id, { ...v, fmaTotal: total });
      setOpen(false);
      setV(blank);
      await reload();
    } catch (x) {
      setErr((x as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <Alert tone="info">
        Record Fugl-Meyer Upper Extremity (FMA-UE, 0–66) assessments here, ideally every 2–4 weeks. They are shown next to the
        game's performance score and will be used to train and validate a recovery-prediction model.
      </Alert>
      <Card title="Fugl-Meyer assessments" action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" /> Add assessment</Button>} padded={false}>
        {!fma.length ? (
          <EmptyState icon={<ClipboardList className="size-6" />} title="No assessments yet">Add the patient's first FMA-UE score.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-2.5 font-medium">Date</th><th className="px-5 py-2.5 font-medium">FMA-UE total</th>
                <th className="px-5 py-2.5 font-medium">A / B / C / D</th><th className="px-5 py-2.5 font-medium">Game score near this date</th>
                <th className="px-5 py-2.5 font-medium">Notes</th><th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...fma].reverse().map((a) => {
                const s = nearest(a.date);
                return (
                  <tr key={a.id}>
                    <td className="px-5 py-3">{fmtDate(a.date)}</td>
                    <td className="px-5 py-3 font-semibold tabular-nums">{a.fmaTotal} / 66</td>
                    <td className="px-5 py-3 tabular-nums text-slate-600">{[a.fmaA, a.fmaB, a.fmaC, a.fmaD].map((x) => x ?? "–").join(" / ")}</td>
                    <td className="px-5 py-3 tabular-nums">{s ? `${s.score!.total} / 100 (${fmtDate(s.startedAt)})` : "—"}</td>
                    <td className="max-w-xs truncate px-5 py-3 text-slate-600">{a.notes}</td>
                    <td className="px-5 py-3 text-right">
                      <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete"
                        onClick={async () => { if (confirm("Delete this assessment?")) { await store.deleteAssessment(uid, patient.id, a.id); await reload(); } }}>
                        <Trash2 className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Add Fugl-Meyer assessment">
        <form onSubmit={submit} className="space-y-4">
          {err && <Alert tone="error">{err}</Alert>}
          <Field label="Assessment date">
            <Input type="date" required value={v.date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setV({ ...v, date: e.target.value })} />
          </Field>
          <p className="text-xs text-slate-500">Enter the sub-scores (the total is added up for you), or only the total.</p>
          <div className="grid grid-cols-2 gap-3">
            {FMA_PARTS.map(([k, l, max]) => (
              <Field key={k} label={`${l} (0–${max})`}>
                <Input type="number" min={0} max={max} value={(v[k] as number | null) ?? ""}
                  onChange={(e) => setV({ ...v, [k]: e.target.value === "" ? null : Number(e.target.value) })} />
              </Field>
            ))}
          </div>
          <Field label="FMA-UE total (0–66)">
            <Input type="number" min={0} max={66} required disabled={anySub} value={anySub ? subSum : v.fmaTotal}
              onChange={(e) => setV({ ...v, fmaTotal: Number(e.target.value) })} />
          </Field>
          <Field label="Notes (optional)"><Textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save assessment</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Details({ uid, patient, reload }: { uid: string; patient: Patient; reload(): Promise<void> }) {
  const nav = useNavigate();
  const [saved, setSaved] = useState(false);
  const { id: _i, createdAt: _c, lastSessionAt: _l, latestScore: _s, progress: _p, ...initial } = patient;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Patient details" className="lg:col-span-2">
        {saved && <div className="mb-4"><Alert tone="success">Saved.</Alert></div>}
        <PatientForm initial={initial} onCancel={() => nav(`/patients/${patient.id}`)}
          onSubmit={async (v) => { await store.updatePatient(uid, patient.id, v); setSaved(true); await reload(); }} />
      </Card>
      <Card title="Delete patient">
        <p className="text-sm text-slate-600">Removes {patient.code} from your patient list. This cannot be undone from the app.</p>
        <Button variant="danger" className="mt-4" onClick={async () => {
          if (!confirm(`Delete patient ${patient.code}? This cannot be undone.`)) return;
          await store.deletePatient(uid, patient.id);
          nav("/");
        }}><Trash2 className="size-4" /> Delete patient</Button>
      </Card>
    </div>
  );
}
