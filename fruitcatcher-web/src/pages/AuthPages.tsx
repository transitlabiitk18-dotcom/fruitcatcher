import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../app/auth";
import { COUNTRY_CODES } from "../app/countries";
import { Brand } from "../components/Logo";
import { Alert, Button, Field, Input, Select } from "../components/ui";
import { authMessage, store } from "../data/store";
import { TRIAL_DAYS } from "../data/util";

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full">
      <div className="hidden w-[44%] flex-col justify-between bg-gradient-to-br from-brand-700 via-brand-800 to-slate-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2 text-lg font-bold">
          <Brand light />
        </div>
        <div>
          <h2 className="text-3xl leading-tight font-semibold">Music-driven arm rehabilitation with just a webcam.</h2>
          <ul className="mt-6 space-y-3 text-brand-100">
            <li>• Reaching game that adapts to each patient's ability</li>
            <li>• Posture, speed and smoothness measured every session</li>
            <li>• Progress dashboards and Fugl-Meyer tracking for clinicians</li>
          </ul>
        </div>
        <p className="text-xs text-brand-200">Camera video is processed on this computer and never uploaded.</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Brand /></div>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
          {store.mode === "local" && (
            <p className="mt-6 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Local demo mode: accounts and data are stored only in this browser.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await store.signIn(email, password);
      nav("/");
    } catch (x) {
      setErr(authMessage(x));
    }
    setBusy(false);
  };

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back. Sign in to see your patients.">
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert tone="error">{err}</Alert>}
        <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div className="flex justify-end">
          <Link to="/reset" className="text-sm text-brand-700 hover:underline">Forgot password?</Link>
        </div>
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        New to FruitCatcher? <Link to="/signup" className="font-medium text-brand-700 hover:underline">Start a {TRIAL_DAYS}-day free trial</Link>
      </p>
    </AuthLayout>
  );
}

export function ProfileFields({ v, set }: { v: { name: string; countryCode: string; phone: string }; set: (patch: Partial<{ name: string; countryCode: string; phone: string }>) => void }) {
  return (
    <>
      <Field label="Full name"><Input required autoComplete="name" value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="Dr. A. Sharma" /></Field>
      <Field label="Mobile number" hint="Used only to contact you about your account.">
        <div className="flex gap-2">
          <Select className="w-32! shrink-0" value={v.countryCode} onChange={(e) => set({ countryCode: e.target.value })} aria-label="Country code">
            {COUNTRY_CODES.map(([code, name]) => <option key={code + name} value={code}>{code} {name}</option>)}
          </Select>
          <Input className="min-w-0 flex-1" required type="tel" inputMode="tel" autoComplete="tel-national" pattern="[0-9 ]{6,15}" title="6 to 15 digits"
            value={v.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="98765 43210" />
        </div>
      </Field>
    </>
  );
}

export function SignupPage() {
  const nav = useNavigate();
  const [v, setV] = useState({ name: "", email: "", password: "", confirm: "", countryCode: "+91", phone: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    if (v.password !== v.confirm) return setErr("The two passwords do not match.");
    setBusy(true);
    try {
      await store.signUp({ name: v.name, email: v.email, password: v.password, countryCode: v.countryCode, phone: v.phone.replace(/\s+/g, "") });
      nav("/");
    } catch (x) {
      setErr(authMessage(x));
    }
    setBusy(false);
  };

  return (
    <AuthLayout title="Create your account" subtitle={`Free for ${TRIAL_DAYS} days. No payment needed.`}>
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert tone="error">{err}</Alert>}
        <ProfileFields v={v} set={set} />
        <Field label="Email"><Input type="email" autoComplete="email" required value={v.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Password" hint="At least 6 characters."><Input type="password" autoComplete="new-password" minLength={6} required value={v.password} onChange={(e) => set({ password: e.target.value })} /></Field>
        <Field label="Confirm password"><Input type="password" autoComplete="new-password" required value={v.confirm} onChange={(e) => set({ confirm: e.target.value })} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Create account</Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPage() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await store.resetPassword(email);
      setMsg({ tone: "success", text: "If an account exists for this email, a reset link is on its way." });
    } catch (x) {
      setMsg({ tone: "error", text: authMessage(x) });
    }
    setBusy(false);
  };
  return (
    <AuthLayout title="Reset password" subtitle="We'll email you a link to choose a new password.">
      <form onSubmit={submit} className="space-y-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
      </form>
      <p className="mt-6 text-center text-sm"><Link to="/login" className="text-brand-700 hover:underline">Back to sign in</Link></p>
    </AuthLayout>
  );
}

/** Shown when a signed-in account has no profile document (e.g. sign-up was interrupted). */
export function CompleteProfilePage() {
  const { uid, refresh } = useAuth();
  const [v, setV] = useState({ name: "", countryCode: "+91", phone: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await store.createProfile(uid!, { name: v.name, email: "", countryCode: v.countryCode, phone: v.phone.replace(/\s+/g, "") });
      await refresh();
    } catch (x) {
      setErr(authMessage(x));
    }
    setBusy(false);
  };
  return (
    <AuthLayout title="Finish setting up" subtitle="A few details to complete your account.">
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert tone="error">{err}</Alert>}
        <ProfileFields v={v} set={(p) => setV((o) => ({ ...o, ...p }))} />
        <Button type="submit" className="w-full" loading={busy}>Continue</Button>
        <Button type="button" variant="ghost" className="w-full" onClick={() => store.signOut()}>Sign out</Button>
      </form>
    </AuthLayout>
  );
}
