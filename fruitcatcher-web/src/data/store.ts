import { FirebaseStore } from "./firebaseStore";
import { LocalStore } from "./localStore";
import type { DataStore } from "./types";

const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY as string,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: env.VITE_FIREBASE_APP_ID as string,
};

/** Firebase when its config is set (see .env.example), otherwise the in-browser demo store. */
export const store: DataStore =
  firebaseConfig.apiKey && firebaseConfig.projectId ? new FirebaseStore(firebaseConfig) : new LocalStore();

/** Friendly text for Firebase / demo auth error codes. */
export function authMessage(e: unknown): string {
  const code = (e as { code?: string })?.code ?? (e as Error)?.message ?? "";
  const map: Record<string, string> = {
    "auth/email-already-in-use": "An account with this email already exists. Try signing in.",
    "auth/invalid-email": "That email address does not look right.",
    "auth/weak-password": "Please use a password of at least 6 characters.",
    "auth/invalid-credential": "Email or password is not correct.",
    "auth/wrong-password": "Email or password is not correct.",
    "auth/user-not-found": "Email or password is not correct.",
    "auth/too-many-requests": "Too many attempts. Please wait a minute and try again.",
    "auth/network-request-failed": "No internet connection. Please check the network and try again.",
  };
  for (const [k, v] of Object.entries(map)) if (code.includes(k)) return v;
  return (e as Error)?.message || "Something went wrong. Please try again.";
}
