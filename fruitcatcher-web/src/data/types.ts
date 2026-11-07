import type { Settings } from "../engine/config";
import type { FrameRow, Group, MotorScore, PartResult, Progress, RepRow, SessionSummary, TrialRow } from "../engine/types";

export type AccessStatus = "trial" | "active" | "blocked";

/** users/{uid} - the clinician. accessUntil and status are edited by hand in the Firebase console. */
export interface Clinician {
  uid: string;
  name: string;
  email: string;
  phone: { countryCode: string; number: string };
  createdAt: number; // ms
  accessUntil: number; // ms
  status: AccessStatus;
  settings: Settings;
}

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  countryCode: string;
  phone: string;
}

/** users/{uid}/patients/{patientId} */
export interface Patient {
  id: string;
  code: string; // coded ID such as P01 - no names needed
  group: Group;
  affectedSide: "left" | "right" | "both" | "none";
  birthYear: number | null;
  sex: "female" | "male" | "other" | "";
  strokeDate: string; // yyyy-mm-dd or ""
  notes: string;
  createdAt: number;
  lastSessionAt: number | null;
  latestScore: number | null;
  progress: Progress;
}

export type PatientInput = Omit<Patient, "id" | "createdAt" | "lastSessionAt" | "latestScore" | "progress">;

/** users/{uid}/patients/{id}/sessions/{sessionId}: one played part. */
export interface SessionDoc extends SessionSummary {
  patientId: string;
  trials?: TrialRow[];
  repRows?: RepRow[];
  frameChunks: number;
}

/** users/{uid}/patients/{id}/assessments/{id}: a therapist-entered Fugl-Meyer (FMA-UE) score. */
export interface Assessment {
  id: string;
  date: string; // yyyy-mm-dd
  fmaTotal: number; // 0-66
  fmaA: number | null; // shoulder / elbow / forearm, 0-36
  fmaB: number | null; // wrist, 0-10
  fmaC: number | null; // hand, 0-14
  fmaD: number | null; // coordination / speed, 0-6
  notes: string;
  createdAt: number;
}

export type AssessmentInput = Omit<Assessment, "id" | "createdAt">;

export interface DataStore {
  readonly mode: "firebase" | "local";
  onAuth(cb: (uid: string | null) => void): () => void;
  signUp(input: SignUpInput): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<void>;

  getProfile(uid: string): Promise<Clinician | null>;
  createProfile(uid: string, input: Omit<SignUpInput, "password">): Promise<Clinician>;
  updateProfile(uid: string, patch: Partial<Pick<Clinician, "name" | "phone" | "settings">>): Promise<void>;

  listPatients(uid: string): Promise<Patient[]>;
  getPatient(uid: string, id: string): Promise<Patient | null>;
  addPatient(uid: string, input: PatientInput): Promise<Patient>;
  updatePatient(uid: string, id: string, patch: Partial<PatientInput>): Promise<void>;
  deletePatient(uid: string, id: string): Promise<void>;

  /** Saves one played part and the patient's progress. Resolves once safely stored on this device;
   *  `uploaded` tells whether it already reached the cloud. */
  savePart(uid: string, patientId: string, result: PartResult, progress: Progress): Promise<{ uploaded: boolean }>;
  listSessions(uid: string, patientId: string): Promise<SessionDoc[]>;
  getSession(uid: string, patientId: string, sessionId: string): Promise<SessionDoc | null>;
  getFrames(uid: string, patientId: string, sessionId: string): Promise<FrameRow[]>;

  listAssessments(uid: string, patientId: string): Promise<Assessment[]>;
  addAssessment(uid: string, patientId: string, input: AssessmentInput): Promise<void>;
  deleteAssessment(uid: string, patientId: string, id: string): Promise<void>;
}

export const hasAccess = (c: Clinician | null) => !!c && c.status !== "blocked" && c.accessUntil > Date.now();

export const daysLeft = (c: Clinician) => Math.max(0, Math.ceil((c.accessUntil - Date.now()) / 86400000));

export type { MotorScore };
