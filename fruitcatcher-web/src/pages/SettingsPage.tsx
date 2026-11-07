import { useState, type FormEvent } from "react";
import { useClinician } from "../app/auth";
import { fmtDate } from "../app/format";
import { ProfileFields } from "./AuthPages";
import { Alert, Badge, Button, Card, Field, Input } from "../components/ui";
import { store } from "../data/store";
import { daysLeft } from "../data/types";
import { ADMIN_CONTACT } from "../data/util";
import { DEFAULT_SETTINGS, type Settings } from "../engine/config";

export default function SettingsPage() {
  const { uid, profile, refresh } = useClinician();
  const [p, setP] = useState({ name: profile.name, countryCode: profile.phone.countryCode || "+91", phone: profile.phone.number });
  const [s, setS] = useState<Settings>(profile.settings);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await store.updateProfile(uid, { name: p.name.trim(), phone: { countryCode: p.countryCode, number: p.phone.replace(/\s+/g, "") }, settings: s });
      await refresh();
      setMsg({ tone: "success", text: "Settings saved." });
    } catch (x) {
      setMsg({ tone: "error", text: (x as Error).message });
    }
    setBusy(false);
  };

  const n = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });

  return (
    <form onSubmit={save} className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Your account and how the game adapts for your patients.</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Account" className="lg:col-span-2">
          <div className="grid gap-4">
            <ProfileFields v={p} set={(x) => setP((o) => ({ ...o, ...x }))} />
            <Field label="Email"><Input value={profile.email} disabled /></Field>
          </div>
        </Card>
        <Card title="Plan">
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span className="text-slate-500">Status</span>
              <Badge tone={profile.status === "trial" ? "brand" : profile.status === "active" ? "green" : "red"}>
                {profile.status === "trial" ? "Free trial" : profile.status === "active" ? "Active" : "Paused"}
              </Badge>
            </div>
            <div className="flex justify-between"><span className="text-slate-500">Access until</span><span className="font-medium">{fmtDate(profile.accessUntil)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Days left</span><span className="font-medium">{daysLeft(profile)}</span></div>
            <p className="pt-2 text-xs text-slate-500">To extend access, contact {ADMIN_CONTACT}.</p>
          </div>
        </Card>
      </div>

      <Card title="Game settings" action={<Button type="button" variant="ghost" size="sm" onClick={() => setS(DEFAULT_SETTINGS)}>Reset to defaults</Button>}>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={`Target catch chance: ${Math.round(s.targetP * 100)}%`} hint="Fruits are placed where the patient has about this chance of catching them. Default 65%.">
            <input type="range" min={0.4} max={0.9} step={0.05} value={s.targetP} onChange={n("targetP")} className="w-full accent-brand-600" />
          </Field>
          <Field label="Leaning limit (% of shoulder width)" hint="Above this a reach counts as leaning. Default 15.">
            <Input type="number" min={5} max={40} step={1} value={s.leanLimit} onChange={n("leanLimit")} />
          </Field>
          <Field label="Shoulder lift limit (% of shoulder width)" hint="Above this a reach counts as shoulder hiking. Default 10.">
            <Input type="number" min={3} max={30} step={1} value={s.hikeLimit} onChange={n("hikeLimit")} />
          </Field>
          <Field label="Daily reps goal" hint="Reaches per day. Default 200.">
            <Input type="number" min={10} max={2000} step={10} value={s.dailyGoal} onChange={n("dailyGoal")} />
          </Field>
          <Field label={`Ability map carry-over: ${Math.round(s.heatCarry * 100)}%`} hint="How much of the ability map is kept from one part or session to the next. 0% = start fresh each time.">
            <input type="range" min={0} max={1} step={0.1} value={s.heatCarry} onChange={n("heatCarry")} className="w-full accent-brand-600" />
          </Field>
          <Field label="Stroke assist" hint="Stroke group: the catch zone grows 15% once a clear reach towards the fruit is seen.">
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" checked={s.strokeAssist} onChange={(e) => setS({ ...s, strokeAssist: e.target.checked })} className="size-4 accent-brand-600" />
              Enabled
            </label>
          </Field>
        </div>
      </Card>

      <div className="flex justify-end"><Button type="submit" loading={busy}>Save settings</Button></div>
    </form>
  );
}
