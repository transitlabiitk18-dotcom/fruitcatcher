import clsx from "clsx";
import { ArrowLeft, Camera, CheckCircle2, CircleAlert, Map, Pause, Play, SkipForward, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useClinician } from "../app/auth";
import { pct } from "../app/format";
import { Brand } from "../components/Logo";
import { ReachMap, ScoreBreakdown, ScoreRing } from "../components/Visuals";
import { Alert, Button, Field, Modal, Select, Spinner } from "../components/ui";
import { store } from "../data/store";
import type { Patient } from "../data/types";
import { SoundEngine } from "../engine/audio";
import { H, PART_BTN, PART_NAME, SEQUENCE, W } from "../engine/config";
import { Game, KeyState, type PanelState } from "../engine/game";
import { runVisit } from "../engine/session";
import { SimTracker, Tracker, listCameras, shouldersOk } from "../engine/tracker";
import type { SessionSummary } from "../engine/types";

type Stage = "loading" | "setup" | "playing" | "done" | "error";
interface SaveState { name: string; status: "saving" | "saved" | "local" | "failed" }

const CAM_KEY = "fc.cameraId";

export default function PlayPage() {
  const { id } = useParams();
  const { uid, profile } = useClinician();
  const nav = useNavigate();
  const sim = useSearchParams()[0].get("sim") === "1"; // simulated hand: demo / testing without a camera
  const [patient, setPatient] = useState<Patient | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [error, setError] = useState("");
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string>("");
  const [startPart, setStartPart] = useState(0);
  const [pain, setPain] = useState<number | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [painAsk, setPainAsk] = useState<{ q: string; resolve(v: number | null): void } | null>(null);
  const [results, setResults] = useState<{ s: SessionSummary; canGoNext: boolean; nextName: string | null; resolve(v: "next" | "stop" | number): void } | null>(null);
  const [saves, setSaves] = useState<SaveState[]>([]);

  const tracker = useRef<Tracker | null>(null);
  const audio = useRef<SoundEngine | null>(null);
  const keys = useRef(new KeyState());
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);

  // load patient + models + camera
  useEffect(() => {
    let alive = true;
    const t = sim ? new SimTracker() : new Tracker();
    if (t instanceof SimTracker) t.aim = () => Game.current?.simAim() ?? null;
    tracker.current = t;
    (async () => {
      try {
        const p = await store.getPatient(uid, id!);
        if (!p) throw new Error("Patient not found.");
        if (!alive) return;
        setPatient(p);
        setStartPart(p.progress?.level ?? 0);
        const saved = localStorage.getItem(CAM_KEY) ?? undefined;
        await t.open(saved).catch(async (e) => {
          if (saved) await t.open(undefined); // the saved camera may be unplugged
          else throw e;
        });
        if (!alive) return t.close();
        const list = sim ? [] : await listCameras();
        setCams(list);
        setCamId(t.deviceId ?? "");
        setStage("setup");
      } catch (e) {
        const err = e as DOMException;
        setError(err.name === "NotAllowedError"
          ? "Camera access was blocked. Allow the camera in the browser's address bar, then reload this page."
          : err.name === "NotFoundError" ? "No camera found. Plug in a webcam and reload this page."
            : err.message || String(e));
        setStage("error");
      }
    })();
    return () => {
      alive = false;
      t.close();
      audio.current?.close().catch(() => {});
    };
  }, [uid, id, sim]);

  // camera check preview
  const [check, setCheck] = useState({ seen: false, palm: 0, pose: false });
  useEffect(() => {
    if (stage !== "setup") return;
    let run = true;
    const palms: number[] = [];
    (async () => {
      while (run && tracker.current) {
        const o = await tracker.current.read();
        const c = preview.current?.getContext("2d");
        if (!c) continue;
        const v = tracker.current.video;
        c.fillStyle = "#000";
        c.fillRect(0, 0, c.canvas.width, c.canvas.height);
        c.save();
        c.translate(c.canvas.width, 0);
        c.scale(-1, 1);
        if (v.readyState >= 2) c.drawImage(v, 0, 0, c.canvas.width, c.canvas.height);
        c.restore();
        const shoulders = shouldersOk(o.pose);
        if (o.pose) {
          c.strokeStyle = shoulders ? "#32eb6e" : "#ff8c00";
          c.lineWidth = 4;
          c.beginPath();
          c.moveTo(o.pose[11][0] * c.canvas.width, o.pose[11][1] * c.canvas.height);
          c.lineTo(o.pose[12][0] * c.canvas.width, o.pose[12][1] * c.canvas.height);
          c.stroke();
        }
        if (o.wrist) {
          c.fillStyle = "#00e6ff";
          c.strokeStyle = "#fff";
          c.lineWidth = 3;
          c.beginPath();
          c.arc(o.wrist[0] * c.canvas.width, o.wrist[1] * c.canvas.height, 12, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }
        if (o.palm) palms.push(o.palm);
        if (palms.length > 15) palms.shift();
        setCheck({ seen: !!o.wrist, palm: palms.length ? palms.reduce((a, b) => a + b, 0) / palms.length : 0, pose: shoulders });
      }
    })();
    return () => {
      run = false;
    };
  }, [stage]);

  const changeCamera = async (deviceId: string) => {
    setCamId(deviceId);
    localStorage.setItem(CAM_KEY, deviceId);
    await tracker.current?.setCamera(deviceId);
  };

  // keyboard
  useEffect(() => {
    if (stage !== "playing") return;
    const h = (e: KeyboardEvent) => {
      if (painAsk || results) return;
      const k = keys.current;
      if (e.code === "Space") k.space = true;
      else if (e.key === "p" || e.key === "P") k.pause = true;
      else if (e.key === "h" || e.key === "H") k.heat = true;
      else if (e.key === "q" || e.key === "Q" || e.key === "Escape") k.quit = true;
      else if (e.key >= "1" && e.key <= "4") k.jump = Number(e.key) - 1;
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [stage, painAsk, results]);

  // stop the game if the tab is hidden for long (browsers slow hidden tabs down)
  useEffect(() => {
    if (stage !== "playing") return;
    const h = () => {
      if (document.hidden && panel && !panel.paused) keys.current.pause = true;
    };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, [stage, panel]);

  const start = useCallback(async () => {
    if (!patient || !tracker.current || !canvas.current) return;
    setStage("playing");
    const a = new SoundEngine();
    audio.current = a;
    await a.start(); // inside the click: browsers only allow sound after a user gesture
    const ctx = canvas.current.getContext("2d")!;
    canvas.current.focus();
    try {
      await runVisit({
        ctx, tracker: tracker.current, audio: a, keys: keys.current,
        group: patient.group, progress: patient.progress, settings: profile.settings,
        startPart, painBefore: pain,
        ui: {
          panel: setPanel,
          askPain: (q) => new Promise((resolve) => setPainAsk({ q, resolve })),
          results: (s, o) => new Promise((resolve) => setResults({ s, ...o, resolve })),
        },
        onPartDone: async (result, progress) => {
          const name = result.summary.layerName;
          setSaves((x) => [...x, { name, status: "saving" }]);
          const mark = (status: SaveState["status"]) =>
            setSaves((x) => x.map((s, i) => (i === x.length - 1 ? { ...s, status } : s)));
          try {
            const r = await store.savePart(uid, patient.id, result, progress);
            mark(store.mode === "local" || r.uploaded ? "saved" : "local");
          } catch (e) {
            console.error(e);
            mark("failed");
          }
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
    a.setMotion("Sa", 0.5, 0);
    setStage("done");
  }, [patient, profile.settings, startPart, pain, uid]);

  const back = () => nav(`/patients/${id}`);

  if (stage === "error") {
    return (
      <Centered>
        <Alert tone="error">{error}</Alert>
        <Button variant="outline" className="mt-4" onClick={back}><ArrowLeft className="size-4" /> Back to patient</Button>
      </Centered>
    );
  }
  if (stage === "loading") return <Centered><Spinner label="Starting the camera and loading hand tracking…" /></Centered>;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {stage === "setup" && patient && (
        <div className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-6">
          <div className="mb-6 flex items-center justify-between">
            <button onClick={back} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white"><ArrowLeft className="size-4" /> {patient.code}</button>
            <Brand light />
          </div>
          <h1 className="text-2xl font-semibold">Before you start</h1>
          <p className="mt-1 text-sm text-slate-400">Check the camera, then ask about pain. The video stays on this computer.</p>
          {sim && <div className="mt-3"><Alert tone="warn">Simulated hand: no camera is used. For demos and testing only - sessions are saved like real ones.</Alert></div>}
          <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div className="overflow-hidden rounded-2xl border border-slate-800 bg-black">
              <canvas ref={preview} width={640} height={480} className="block aspect-[4/3] w-full" />
            </div>
            <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="[&_span]:text-slate-300">
                <Field label="Camera">
                  <Select value={camId} onChange={(e) => changeCamera(e.target.value)} className="border-slate-700! bg-slate-800! text-slate-100!">
                    {!cams.length && <option value="">{sim ? "Simulated hand" : "Default camera"}</option>}
                    {cams.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
                  </Select>
                </Field>
              </div>
              <ul className="space-y-2 text-sm">
                <Check ok={check.seen} label={check.seen ? "Hand seen" : "Show your hand to the camera"} />
                <Check ok={check.pose} label={check.pose ? "Shoulders seen (posture check on)" : "Sit so both shoulders are in view"} />
              </ul>
              <div>
                <div className="mb-1 text-xs text-slate-400">Hand size: should grow when the hand moves towards the camera</div>
                <div className="h-2.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${Math.min(100, (check.palm / 140) * 100)}%` }} />
                </div>
              </div>
              <div className="[&_span]:text-slate-300">
                <Field label="Start at">
                  <Select value={startPart} onChange={(e) => setStartPart(Number(e.target.value))} className="border-slate-700! bg-slate-800! text-slate-100!">
                    {SEQUENCE.map((L, i) => <option key={L} value={i}>Part {i + 1}: {PART_BTN[L]}{i === (patient.progress?.level ?? 0) ? " (current level)" : ""}</option>)}
                  </Select>
                </Field>
              </div>
              <div>
                <div className="mb-2 text-sm font-medium text-slate-300">Pain now, before the session (0 = none, 10 = worst)</div>
                <PainButtons value={pain} onPick={setPain} dark />
              </div>
              <Button size="lg" className="w-full" onClick={start}><Play className="size-5" /> Start session</Button>
              <p className="text-xs text-slate-500">Keys while playing: SPACE skip · P pause · H heat map · 1-4 jump to part · Q or Esc stop and save. Use wired speakers for the quickest sound.</p>
            </div>
          </div>
        </div>
      )}

      <div className={clsx("min-h-0 flex-1 gap-3 p-3", stage === "playing" ? "flex" : "hidden")}>
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <canvas ref={canvas} width={W} height={H} tabIndex={0} className="max-h-full max-w-full rounded-xl bg-black shadow-2xl outline-none" style={{ aspectRatio: `${W} / ${H}` }} />
        </div>
        {panel && <SidePanel p={panel} saves={saves} keys={keys.current} />}
      </div>

      {stage === "done" && (
        <Centered dark>
          <CheckCircle2 className="mx-auto size-12 text-emerald-400" />
          <h1 className="mt-3 text-2xl font-semibold">Session finished</h1>
          <ul className="mt-4 space-y-1 text-sm">
            {saves.map((s, i) => <li key={i}><SaveLine s={s} /></li>)}
          </ul>
          {error && <div className="mt-4"><Alert tone="error">{error}</Alert></div>}
          <Button className="mt-6" onClick={back}>See progress</Button>
        </Centered>
      )}

      <Modal open={!!painAsk} title="Pain check">
        <p className="mb-4 text-sm text-slate-600">{painAsk?.q} (0 = no pain, 10 = worst pain)</p>
        <PainButtons value={null} onPick={(v) => { painAsk?.resolve(v); setPainAsk(null); }} />
        <div className="mt-4 text-right">
          <Button variant="ghost" onClick={() => { painAsk?.resolve(null); setPainAsk(null); }}>Skip</Button>
        </div>
      </Modal>

      {results && (
        <Modal open title={results.s.completed ? `Part complete: ${PART_NAME[results.s.layer]}` : "Stopped"} wide>
          <ResultsBody s={results.s} />
          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
            {results.canGoNext ? (
              <>
                <Button variant="outline" onClick={() => { results.resolve("stop"); setResults(null); }}><Square className="size-4" /> Stop here</Button>
                <Button onClick={() => { results.resolve("next"); setResults(null); }}>Next: {results.nextName} <SkipForward className="size-4" /></Button>
              </>
            ) : (
              <Button onClick={() => { results.resolve("stop"); setResults(null); }}>Finish</Button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Centered({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <div className={clsx("flex min-h-full items-center justify-center p-6", dark ? "bg-slate-950 text-slate-100" : "bg-slate-50")}>
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={clsx("flex items-center gap-2", ok ? "text-emerald-400" : "text-amber-300")}>
      {ok ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />} {label}
    </li>
  );
}

function PainButtons({ value, onPick, dark }: { value: number | null; onPick(v: number): void; dark?: boolean }) {
  return (
    <div className="grid grid-cols-11 gap-1">
      {Array.from({ length: 11 }, (_, i) => (
        <button key={i} type="button" onClick={() => onPick(i)}
          className={clsx("h-10 rounded-lg text-sm font-semibold tabular-nums transition-colors",
            value === i ? "bg-brand-500 text-white"
              : dark ? "bg-slate-800 text-slate-200 hover:bg-slate-700" : "bg-slate-100 text-slate-700 hover:bg-slate-200")}>
          {i}
        </button>
      ))}
    </div>
  );
}

function SaveLine({ s }: { s: SaveState }) {
  const text = { saving: "saving…", saved: "saved", local: "saved on this computer, uploading when online", failed: "could not be saved" }[s.status];
  return <span className={clsx(s.status === "failed" ? "text-red-400" : s.status === "saving" ? "text-slate-400" : "text-emerald-400")}>{s.name}: {text}</span>;
}

function SidePanel({ p, saves, keys }: { p: PanelState; saves: SaveState[]; keys: KeyState }) {
  const goal = Math.min(100, (p.repsToday / Math.max(1, p.dailyGoal)) * 100);
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto">
      <div className="rounded-xl bg-slate-900 p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Parts</div>
        <ul className="space-y-1">
          {SEQUENCE.map((L, i) => {
            const done = p.done.includes(i), now = i === p.part;
            return (
              <li key={L}>
                <button onClick={() => { if (!now) keys.jump = i; }}
                  className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm",
                    now ? "bg-brand-600/30 text-white ring-1 ring-brand-400" : "text-slate-300 hover:bg-slate-800")}>
                  <span className={clsx("size-2.5 rounded-full", done ? "bg-emerald-400" : now ? "bg-yellow-300" : "bg-slate-600")} />
                  {i + 1}. {PART_BTN[L]}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rounded-xl bg-slate-900 p-3">
        <div className="text-sm font-semibold text-white">{p.hud[0] || "Getting ready"}</div>
        {(p.hud[1] || p.hud[2]) && <div className="mt-0.5 text-xs text-slate-400">{[p.hud[1], p.hud[2]].filter(Boolean).join(" · ")}</div>}
        {p.help.length > 0 && <ul className="mt-2 space-y-1 text-sm text-slate-300">{p.help.map((h, i) => <li key={i}>{h}</li>)}</ul>}
      </div>

      <div className="rounded-xl bg-slate-900 p-3">
        <div className="flex justify-between text-xs text-slate-400"><span>Reps today</span><span className="tabular-nums">{p.repsToday} / {p.dailyGoal}</span></div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${goal}%` }} /></div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-slate-400">Posture</dt>
          <dd className={clsx("text-right font-medium", p.goodForm == null ? "text-slate-500" : p.goodForm ? "text-emerald-400" : "text-orange-400")}>
            {p.goodForm == null ? "—" : p.goodForm ? "Good" : "Leaning / shoulder up"}
          </dd>
          <dt className="text-slate-400">Lean / shoulder lift</dt><dd className="text-right tabular-nums">{p.lean == null ? "—" : `${Math.round(p.lean)}% / ${Math.round(p.hike ?? 0)}%`}</dd>
          <dt className="text-slate-400">Elbow / shoulder</dt><dd className="text-right tabular-nums">{p.elbow == null ? "—" : `${Math.round(p.elbow)}° / ${Math.round(p.shoulder ?? 0)}°`}</dd>
          <dt className="text-slate-400">Note / instrument</dt><dd className="text-right">{[p.note, p.instrument].filter(Boolean).join(" · ") || "—"}</dd>
        </dl>
        <div className="mt-3 text-xs text-slate-400">Depth (far → near)</div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${p.depth * 100}%` }} /></div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <PanelBtn onClick={() => (keys.space = true)} icon={<SkipForward className="size-4" />} label="Skip wait" k="Space" />
        <PanelBtn onClick={() => (keys.pause = true)} icon={p.paused ? <Play className="size-4" /> : <Pause className="size-4" />} label={p.paused ? "Resume" : "Pause"} k="P" />
        <PanelBtn onClick={() => (keys.heat = true)} icon={<Map className="size-4" />} label={p.heatOn ? "Hide map" : "Heat map"} k="H" active={p.heatOn} />
        <PanelBtn onClick={() => (keys.quit = true)} icon={<Square className="size-4" />} label="Stop & save" k="Q" />
      </div>

      <div className="mt-auto space-y-1 rounded-xl bg-slate-900 p-3 text-xs text-slate-400">
        <div className="flex items-center gap-1.5"><Camera className="size-3.5" /> {p.fps} fps · {p.handSeen ? "hand seen" : "hand not seen"} · posture {p.poseOn ? "on" : "off"}</div>
        <div className="flex items-center gap-1.5"><Volume2 className="size-3.5" /> sound delay about {p.latencyMs} ms</div>
        {saves.map((s, i) => <div key={i}><SaveLine s={s} /></div>)}
      </div>
    </aside>
  );
}

function PanelBtn({ onClick, icon, label, k, active }: { onClick(): void; icon: React.ReactNode; label: string; k: string; active?: boolean }) {
  return (
    <button onClick={onClick} className={clsx("flex items-center justify-between gap-1 rounded-lg px-3 py-2 text-sm",
      active ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700")}>
      <span className="flex items-center gap-1.5">{icon} {label}</span>
      <kbd className="rounded bg-black/30 px-1.5 text-[10px] text-slate-400">{k}</kbd>
    </button>
  );
}

function ResultsBody({ s }: { s: SessionSummary }) {
  return (
    <div className="grid gap-6 md:grid-cols-[auto_1fr]">
      <div className="flex flex-col items-center">
        <ScoreRing value={s.score?.total} size={130} />
        <div className="mt-1 text-xs text-slate-500">Performance score (estimate)</div>
      </div>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xl font-semibold tabular-nums">{s.catches}/{s.trialsDone}</div><div className="text-xs text-slate-500">caught ({pct(s.catchRate)})</div></div>
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xl font-semibold tabular-nums">{s.repsToday}/{s.dailyGoal}</div><div className="text-xs text-slate-500">reps today</div></div>
          <div className="rounded-lg bg-slate-50 p-3"><div className="text-xl font-semibold tabular-nums">{s.goodFormPct == null ? "—" : `${s.goodFormPct}%`}</div><div className="text-xs text-slate-500">good posture</div></div>
        </div>
        <ScoreBreakdown score={s.score} />
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{s.perLine.length ? "Song lines (caught / tries)" : "Notes (caught / tries)"}</h3>
        <ul className="space-y-1 text-sm">
          {s.perLine.length
            ? s.perLine.map((l, i) => <li key={i} className="flex justify-between gap-3"><span className="truncate">{i + 1}. {l.text}</span><span className="tabular-nums">{l.caught}/{l.tries}</span></li>)
            : s.perNote.split("; ").filter(Boolean).map((x) => { const [n, v] = x.split(":"); return <li key={n} className="flex justify-between gap-3"><span>{n}</span><span className="tabular-nums">{v}</span></li>; })}
        </ul>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Chance to catch a fruit</h3>
        <ReachMap map={s.reachMap} />
      </div>
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 md:col-span-2">{s.decision}</p>
    </div>
  );
}
