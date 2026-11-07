// Firebase implementation: Auth (email + password) and Firestore.
// Layout (all under the clinician, so security rules stay simple):
//   users/{uid}                                     profile, accessUntil, status, settings
//   users/{uid}/patients/{pid}                       patient + progress
//   users/{uid}/patients/{pid}/sessions/{sid}         one played part (summary, trials, reps)
//   users/{uid}/patients/{pid}/sessions/{sid}/frames/{n}   per-frame data, gzip chunks
//   users/{uid}/patients/{pid}/assessments/{aid}     therapist-entered Fugl-Meyer scores
import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  createUserWithEmailAndPassword, getAuth, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut,
} from "firebase/auth";
import {
  Bytes, Timestamp, collection, deleteDoc, doc, getDoc, getDocs, initializeFirestore, orderBy,
  persistentLocalCache, persistentMultipleTabManager, query, serverTimestamp, setDoc, updateDoc, writeBatch,
  type DocumentData, type Firestore,
} from "firebase/firestore";
import { DEFAULT_SETTINGS } from "../engine/config";
import { newProgress, type FrameRow, type PartResult, type Progress } from "../engine/types";
import { decodeFrames, encodeFrames } from "./frames";
import type { Assessment, AssessmentInput, Clinician, DataStore, Patient, PatientInput, SessionDoc, SignUpInput } from "./types";
import { TRIAL_DAYS, newId } from "./util";

const ms = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : typeof v === "number" ? v : Date.now());

/** Firestore cannot store undefined; strip it (null is fine). */
const clean = <T>(o: T): T => JSON.parse(JSON.stringify(o));

// Firestore does not allow arrays inside arrays, so the model's training rows are stored as [{ r: [...] }].
const progressOut = (p: Progress) => clean({ ...p, modelRows: p.modelRows.map((r) => ({ r })) });
const progressIn = (p: DocumentData | undefined): Progress => ({
  ...newProgress(), ...p, modelRows: (p?.modelRows ?? []).map((x: { r: number[] } | number[]) => (Array.isArray(x) ? x : x.r)),
});

export class FirebaseStore implements DataStore {
  readonly mode = "firebase" as const;
  private auth;
  private db: Firestore;

  constructor(cfg: FirebaseOptions) {
    const app = initializeApp(cfg);
    this.auth = getAuth(app);
    // local cache: sessions played offline are kept on the laptop and uploaded when back online
    this.db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  }

  onAuth(cb: (uid: string | null) => void) {
    return onAuthStateChanged(this.auth, (u) => cb(u?.uid ?? null));
  }

  // The auth listener fires as soon as the account exists; getProfile waits for this so the app
  // never reads the profile (or patients) before the server has the new profile.
  private signingUp: Promise<unknown> | null = null;

  async signUp(input: SignUpInput) {
    const run = (async () => {
      const cred = await createUserWithEmailAndPassword(this.auth, input.email.trim(), input.password);
      await this.createProfile(cred.user.uid, input);
      sendEmailVerification(cred.user).catch(() => {});
    })();
    this.signingUp = run;
    try {
      await run;
    } finally {
      this.signingUp = null;
    }
  }

  async signIn(email: string, password: string) {
    await signInWithEmailAndPassword(this.auth, email.trim(), password);
  }

  async signOut() {
    await signOut(this.auth);
  }

  async resetPassword(email: string) {
    await sendPasswordResetEmail(this.auth, email.trim());
  }

  private user(uid: string) {
    return doc(this.db, "users", uid);
  }
  private patients(uid: string) {
    return collection(this.db, "users", uid, "patients");
  }
  private sessions(uid: string, pid: string) {
    return collection(this.db, "users", uid, "patients", pid, "sessions");
  }
  private assessments(uid: string, pid: string) {
    return collection(this.db, "users", uid, "patients", pid, "assessments");
  }

  async getProfile(uid: string): Promise<Clinician | null> {
    await this.signingUp?.catch(() => {});
    return this.readProfile(uid);
  }

  private async readProfile(uid: string): Promise<Clinician | null> {
    const s = await getDoc(this.user(uid));
    if (!s.exists()) return null;
    const d = s.data();
    return {
      uid, name: d.name ?? "", email: d.email ?? "", phone: d.phone ?? { countryCode: "", number: "" },
      createdAt: ms(d.createdAt), accessUntil: ms(d.accessUntil), status: d.status ?? "trial",
      settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
    };
  }

  async createProfile(uid: string, input: Omit<SignUpInput, "password">): Promise<Clinician> {
    const accessUntil = Date.now() + TRIAL_DAYS * 86400000;
    await setDoc(this.user(uid), {
      name: input.name.trim(),
      email: this.auth.currentUser?.email ?? input.email.trim(),
      phone: { countryCode: input.countryCode, number: input.phone.trim() },
      createdAt: serverTimestamp(),
      accessUntil: Timestamp.fromMillis(accessUntil),
      status: "trial",
      settings: DEFAULT_SETTINGS,
    });
    return (await this.readProfile(uid))!;
  }

  async updateProfile(uid: string, patch: Partial<Pick<Clinician, "name" | "phone" | "settings">>) {
    await updateDoc(this.user(uid), clean(patch) as DocumentData);
  }

  private toPatient(id: string, d: DocumentData): Patient {
    return {
      ...(d as Patient), id, createdAt: ms(d.createdAt), lastSessionAt: d.lastSessionAt ? ms(d.lastSessionAt) : null,
      progress: progressIn(d.progress),
    };
  }

  async listPatients(uid: string) {
    const s = await getDocs(query(this.patients(uid), orderBy("createdAt", "desc")));
    return s.docs.map((d) => this.toPatient(d.id, d.data()));
  }

  async getPatient(uid: string, id: string) {
    const s = await getDoc(doc(this.patients(uid), id));
    return s.exists() ? this.toPatient(s.id, s.data()) : null;
  }

  async addPatient(uid: string, input: PatientInput) {
    const p: Patient = { ...input, id: newId(), createdAt: Date.now(), lastSessionAt: null, latestScore: null, progress: newProgress() };
    const { id, ...rest } = p;
    await setDoc(doc(this.patients(uid), id), clean({ ...rest, progress: progressOut(rest.progress) }));
    return p;
  }

  async updatePatient(uid: string, id: string, patch: Partial<PatientInput>) {
    await updateDoc(doc(this.patients(uid), id), clean(patch) as DocumentData);
  }

  async deletePatient(uid: string, id: string) {
    // sessions and assessments are left in place (Firestore does not cascade); the patient disappears from lists
    await deleteDoc(doc(this.patients(uid), id));
  }

  async savePart(uid: string, patientId: string, result: PartResult, progress: Progress) {
    const chunks = await encodeFrames(result.frames);
    const s = result.summary;
    const batch = writeBatch(this.db);
    const sref = doc(this.sessions(uid, patientId), s.sessionId);
    const session: SessionDoc = { ...s, patientId, trials: result.trials, repRows: result.reps, frameChunks: chunks.length };
    batch.set(sref, clean(session));
    chunks.forEach((c, i) => batch.set(doc(sref, "frames", String(i)), { i, gz: Bytes.fromUint8Array(c) }));
    batch.update(doc(this.patients(uid), patientId), {
      progress: progressOut(progress), lastSessionAt: Date.now(),
      ...(s.score ? { latestScore: s.score.total } : {}),
    });
    const commit = batch.commit();
    // offline: the write is already kept in the local cache and will upload later; don't wait for it
    const uploaded = await Promise.race([commit.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    commit.catch((e) => console.error("upload failed", e));
    return { uploaded };
  }

  async listSessions(uid: string, patientId: string) {
    const s = await getDocs(query(this.sessions(uid, patientId), orderBy("startedAt", "asc")));
    return s.docs.map((d) => {
      const { trials: _t, repRows: _r, ...rest } = d.data() as SessionDoc;
      return rest as SessionDoc;
    });
  }

  async getSession(uid: string, patientId: string, sessionId: string) {
    const s = await getDoc(doc(this.sessions(uid, patientId), sessionId));
    return s.exists() ? (s.data() as SessionDoc) : null;
  }

  async getFrames(uid: string, patientId: string, sessionId: string): Promise<FrameRow[]> {
    const s = await getDocs(collection(doc(this.sessions(uid, patientId), sessionId), "frames"));
    const chunks = s.docs.map((d) => d.data()).sort((a, b) => a.i - b.i).map((d) => (d.gz as Bytes).toUint8Array());
    return decodeFrames(chunks);
  }

  async listAssessments(uid: string, patientId: string) {
    const s = await getDocs(query(this.assessments(uid, patientId), orderBy("date", "asc")));
    return s.docs.map((d) => ({ ...(d.data() as Assessment), id: d.id }));
  }

  async addAssessment(uid: string, patientId: string, input: AssessmentInput) {
    await setDoc(doc(this.assessments(uid, patientId), newId()), clean({ ...input, createdAt: Date.now() }));
  }

  async deleteAssessment(uid: string, patientId: string, id: string) {
    await deleteDoc(doc(this.assessments(uid, patientId), id));
  }
}
