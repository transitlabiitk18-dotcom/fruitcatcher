import { useState, type FormEvent } from "react";
import type { Group } from "../engine/types";
import type { PatientInput } from "../data/types";
import { GROUP_LABEL, SIDE_LABEL } from "../app/format";
import { Alert, Button, Field, Input, Select, Textarea } from "./ui";

export const emptyPatient = (): PatientInput => ({
  code: "", group: "S", affectedSide: "right", birthYear: null, sex: "", strokeDate: "", notes: "",
});

export function PatientForm({ initial, onSubmit, onCancel, submitLabel = "Save" }: {
  initial: PatientInput; onSubmit(v: PatientInput): Promise<void>; onCancel(): void; submitLabel?: string;
}) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<PatientInput>) => setV((o) => ({ ...o, ...p }));
  const thisYear = new Date().getFullYear();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await onSubmit({ ...v, code: v.code.trim().toUpperCase() });
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {err && <Alert tone="error">{err}</Alert>}
      <Field label="Patient code" hint="A coded ID such as P01. Avoid names, to protect patient privacy.">
        <Input required maxLength={24} value={v.code} onChange={(e) => set({ code: e.target.value })} placeholder="P01" />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Group">
          <Select value={v.group} onChange={(e) => set({ group: e.target.value as Group })}>
            {(Object.keys(GROUP_LABEL) as Group[]).map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
          </Select>
        </Field>
        <Field label="Affected side">
          <Select value={v.affectedSide} onChange={(e) => set({ affectedSide: e.target.value as PatientInput["affectedSide"] })}>
            {Object.entries(SIDE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Year of birth">
          <Input type="number" min={1900} max={thisYear} value={v.birthYear ?? ""} placeholder="e.g. 1958"
            onChange={(e) => set({ birthYear: e.target.value ? Number(e.target.value) : null })} />
        </Field>
        <Field label="Sex">
          <Select value={v.sex} onChange={(e) => set({ sex: e.target.value as PatientInput["sex"] })}>
            <option value="">Not recorded</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      </div>
      {v.group === "S" && (
        <Field label="Date of stroke (optional)">
          <Input type="date" value={v.strokeDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ strokeDate: e.target.value })} />
        </Field>
      )}
      <Field label="Notes (optional)">
        <Textarea value={v.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Clinical notes, precautions…" />
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}
