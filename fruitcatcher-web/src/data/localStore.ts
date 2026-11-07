// LOCAL DEMO MODE: used when no Firebase config is set. Accounts and data stay in this browser
// (IndexedDB). Same behaviour as the Firebase store, so the app can be tried and demoed offline.
import { createStore, del, get, set } from "idb-keyval";
import { DEFAULT_SETTINGS } from "../engine/config";
import { newProgress, type FrameRow, type PartResult, type Progress } from "../engine/types";
import { decodeFrames, encodeFrames } from "./frames";
import type { Assessment, AssessmentInput, Clinician, DataStore, Patient, PatientInput, SessionDoc, SignUpInput } from "./types";
import { TRIAL_DAYS, newId } from "./util";

const db = createStore("fruitcatcher-demo", "kv");
const CURRENT = "fc.currentUser";

interface Account { uid: string; email: string; pwHash: string }

async function hash(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
}

const k = {
  accounts: "accounts",
  profile: (uid: string) => `u/${uid}/profile`,
  patients: (uid: string) => `u/${uid}/patients`,
  sessions: (uid: string, pid: string) => `u/${uid}/p/${pid}/sessions`,
  session: (uid: string, sid: string) => `u/${uid}/s/${sid}`,
  frames: (uid: string, sid: string) => `u/${uid}/f/${sid}`,
  assessments: (uid: string, pid: string) => `u/${uid}/p/${pid}/assessments`,
};

export class LocalStore implements DataStore {
  readonly mode = "local" as const;
  private listeners = new Set<(uid: string | null) => void>();

  private emit() {
    const uid = localStorage.getItem(CURRENT);
    this.listeners.forEach((cb) => cb(uid));
  }

  onAuth(cb: (uid: string | null) => void) {
    this.listeners.add(cb);
    setTimeout(() => cb(localStorage.getItem(CURRENT)), 0);
    return () => void this.listeners.delete(cb);
  }

  async signUp(input: SignUpInput) {
    const accounts: Account[] = (await get(k.accounts, db)) ?? [];
    const email = input.email.trim().toLowerCase();
    if (accounts.some((a) => a.email === email)) throw new Error("auth/email-already-in-use");
    if (input.password.length < 6) throw new Error("auth/weak-password");
    const uid = newId();
    accounts.push({ uid, email, pwHash: await hash(input.password) });
    await set(k.accounts, accounts, db);
    await this.createProfile(uid, { ...input, email });
    localStorage.setItem(CURRENT, uid);
    this.emit();
  }

  async signIn(email: string, password: string) {
    const accounts: Account[] = (await get(k.accounts, db)) ?? [];
    const a = accounts.find((x) => x.email === email.trim().toLowerCase());
    if (!a || a.pwHash !== (await hash(password))) throw new Error("auth/invalid-credential");
    localStorage.setItem(CURRENT, a.uid);
    this.emit();
  }

  async signOut() {
    localStorage.removeItem(CURRENT);
    this.emit();
  }

  async resetPassword() {
    throw new Error("Password reset by email needs the Firebase connection (not available in local demo mode).");
  }

  async getProfile(uid: string) {
    return ((await get(k.profile(uid), db)) as Clinician | undefined) ?? null;
  }

  async createProfile(uid: string, input: Omit<SignUpInput, "password">) {
    const c: Clinician = {
      uid, name: input.name.trim(), email: input.email.trim(),
      phone: { countryCode: input.countryCode, number: input.phone.trim() },
      createdAt: Date.now(), accessUntil: Date.now() + TRIAL_DAYS * 86400000, status: "trial",
      settings: DEFAULT_SETTINGS,
    };
    await set(k.profile(uid), c, db);
    return c;
  }

  async updateProfile(uid: string, patch: Partial<Pick<Clinician, "name" | "phone" | "settings">>) {
    const c = await this.getProfile(uid);
    if (c) await set(k.profile(uid), { ...c, ...patch }, db);
  }

  private async patientMap(uid: string): Promise<Record<string, Patient>> {
    return (await get(k.patients(uid), db)) ?? {};
  }

  async listPatients(uid: string) {
    return Object.values(await this.patientMap(uid)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async getPatient(uid: string, id: string) {
    return (await this.patientMap(uid))[id] ?? null;
  }

  async addPatient(uid: string, input: PatientInput) {
    const m = await this.patientMap(uid);
    const p: Patient = { ...input, id: newId(), createdAt: Date.now(), lastSessionAt: null, latestScore: null, progress: newProgress() };
    m[p.id] = p;
    await set(k.patients(uid), m, db);
    return p;
  }

  async updatePatient(uid: string, id: string, patch: Partial<PatientInput>) {
    const m = await this.patientMap(uid);
    if (m[id]) m[id] = { ...m[id], ...patch };
    await set(k.patients(uid), m, db);
  }

  async deletePatient(uid: string, id: string) {
    const m = await this.patientMap(uid);
    delete m[id];
    await set(k.patients(uid), m, db);
  }

  async savePart(uid: string, patientId: string, result: PartResult, progress: Progress) {
    const s = result.summary;
    const chunks = await encodeFrames(result.frames);
    const doc: SessionDoc = { ...s, patientId, trials: result.trials, repRows: result.reps, frameChunks: chunks.length };
    await set(k.session(uid, s.sessionId), doc, db);
    await set(k.frames(uid, s.sessionId), chunks, db);
    const ids: string[] = (await get(k.sessions(uid, patientId), db)) ?? [];
    if (!ids.includes(s.sessionId)) ids.push(s.sessionId);
    await set(k.sessions(uid, patientId), ids, db);
    const m = await this.patientMap(uid);
    if (m[patientId]) {
      m[patientId] = {
        ...m[patientId], progress: structuredClone(progress), lastSessionAt: Date.now(),
        latestScore: s.score?.total ?? m[patientId].latestScore,
      };
      await set(k.patients(uid), m, db);
    }
    return { uploaded: false };
  }

  async listSessions(uid: string, patientId: string) {
    const ids: string[] = (await get(k.sessions(uid, patientId), db)) ?? [];
    const docs = await Promise.all(ids.map((id) => get(k.session(uid, id), db) as Promise<SessionDoc | undefined>));
    return docs.filter((d): d is SessionDoc => !!d).map(({ trials: _t, repRows: _r, ...rest }) => rest as SessionDoc)
      .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
  }

  async getSession(uid: string, _patientId: string, sessionId: string) {
    return ((await get(k.session(uid, sessionId), db)) as SessionDoc | undefined) ?? null;
  }

  async getFrames(uid: string, _patientId: string, sessionId: string): Promise<FrameRow[]> {
    return decodeFrames(((await get(k.frames(uid, sessionId), db)) as Uint8Array[] | undefined) ?? []);
  }

  async listAssessments(uid: string, patientId: string) {
    const list: Assessment[] = (await get(k.assessments(uid, patientId), db)) ?? [];
    return [...list].sort((a, b) => a.date.localeCompare(b.date));
  }

  async addAssessment(uid: string, patientId: string, input: AssessmentInput) {
    const list: Assessment[] = (await get(k.assessments(uid, patientId), db)) ?? [];
    list.push({ ...input, id: newId(), createdAt: Date.now() });
    await set(k.assessments(uid, patientId), list, db);
  }

  async deleteAssessment(uid: string, patientId: string, id: string) {
    const list: Assessment[] = (await get(k.assessments(uid, patientId), db)) ?? [];
    const next = list.filter((a) => a.id !== id);
    if (next.length) await set(k.assessments(uid, patientId), next, db);
    else await del(k.assessments(uid, patientId), db);
  }
}
