import type { Group } from "../engine/types";
import type { Patient } from "../data/types";

export const GROUP_LABEL: Record<Group, string> = { S: "Stroke", O: "Healthy older adult", Y: "Healthy young adult" };
export const SIDE_LABEL: Record<Patient["affectedSide"], string> = {
  left: "Left", right: "Right", both: "Both", none: "None",
};

export const fmtDate = (ms: number | string | null | undefined) =>
  ms == null || ms === "" ? "—" : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export const fmtDateTime = (ms: number | string) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export const num = (v: number | null | undefined, nd = 2, suffix = "") =>
  v == null ? "—" : `${Number(v.toFixed(nd))}${suffix}`;

export function scoreTone(s: number | null | undefined): "good" | "warn" | "bad" | undefined {
  if (s == null) return undefined;
  return s >= 70 ? "good" : s >= 40 ? "warn" : "bad";
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
