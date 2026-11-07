import { ChevronRight, Plus, Search, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useClinician } from "../app/auth";
import { GROUP_LABEL, SIDE_LABEL, fmtDate, scoreTone } from "../app/format";
import { PatientForm, emptyPatient } from "../components/PatientForm";
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, Spinner } from "../components/ui";
import { store } from "../data/store";
import type { Patient } from "../data/types";
import { PART_BTN, SEQUENCE } from "../engine/config";

export function PatientsPage() {
  const { uid, profile } = useClinician();
  const nav = useNavigate();
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    store.listPatients(uid).then(setPatients).catch((e) => setErr((e as Error).message));
  }, [uid]);

  const shown = useMemo(
    () => (patients ?? []).filter((p) => p.code.toLowerCase().includes(q.trim().toLowerCase())),
    [patients, q],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Patients</h1>
          <p className="mt-1 text-sm text-slate-500">Hello {profile.name || "there"}. Choose a patient to see progress or start a session.</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add patient</Button>
      </div>

      {err && <Alert tone="error">{err}</Alert>}

      <Card padded={false}>
        <div className="border-b border-slate-100 p-3">
          <div className="relative max-w-xs">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <Input className="pl-9" placeholder="Search by patient code" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {patients === null ? (
          <Spinner />
        ) : patients.length === 0 ? (
          <EmptyState icon={<UserRound className="size-6" />} title="No patients yet">
            Add your first patient to start a session. Use a coded ID (like P01) instead of names.
            <div className="mt-4"><Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add patient</Button></div>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Patient</th>
                  <th className="px-5 py-2.5 font-medium">Group</th>
                  <th className="px-5 py-2.5 font-medium">Affected side</th>
                  <th className="px-5 py-2.5 font-medium">Current level</th>
                  <th className="px-5 py-2.5 font-medium">Performance score</th>
                  <th className="px-5 py-2.5 font-medium">Last session</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((p) => {
                  const tone = scoreTone(p.latestScore);
                  return (
                    <tr key={p.id} onClick={() => nav(`/patients/${p.id}`)} className="cursor-pointer hover:bg-slate-50">
                      <td className="px-5 py-3 font-semibold text-slate-900">{p.code}</td>
                      <td className="px-5 py-3"><Badge tone={p.group === "S" ? "brand" : "slate"}>{GROUP_LABEL[p.group]}</Badge></td>
                      <td className="px-5 py-3 text-slate-600">{SIDE_LABEL[p.affectedSide]}</td>
                      <td className="px-5 py-3 text-slate-600">{PART_BTN[SEQUENCE[p.progress?.level ?? 0]]}</td>
                      <td className="px-5 py-3">
                        {p.latestScore == null ? <span className="text-slate-400">—</span> : (
                          <Badge tone={tone === "good" ? "green" : tone === "warn" ? "amber" : "red"}>{p.latestScore} / 100</Badge>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-600">{fmtDate(p.lastSessionAt)}</td>
                      <td className="px-5 py-3 text-right"><ChevronRight className="inline size-4 text-slate-400" /></td>
                    </tr>
                  );
                })}
                {!shown.length && (
                  <tr><td colSpan={7} className="px-5 py-8 text-center text-slate-500">No patient matches "{q}".</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add patient">
        <PatientForm
          initial={emptyPatient()}
          submitLabel="Add patient"
          onCancel={() => setAdding(false)}
          onSubmit={async (v) => {
            if (patients?.some((p) => p.code === v.code)) throw new Error(`A patient with code ${v.code} already exists.`);
            const p = await store.addPatient(uid, v);
            setAdding(false);
            nav(`/patients/${p.id}`);
          }}
        />
      </Modal>
    </div>
  );
}
