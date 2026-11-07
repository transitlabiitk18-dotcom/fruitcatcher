import clsx from "clsx";
import { LogOut, Settings, Users } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { Brand } from "../components/Logo";
import { Badge, Button } from "../components/ui";
import { store } from "../data/store";
import { daysLeft } from "../data/types";
import { ADMIN_CONTACT } from "../data/util";
import { useClinician } from "./auth";

export function Shell() {
  const { profile } = useClinician();
  const left = daysLeft(profile);
  const link = ({ isActive }: { isActive: boolean }) =>
    clsx("flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
      isActive ? "bg-brand-50 text-brand-800" : "text-slate-600 hover:bg-slate-100");
  return (
    <div className="flex min-h-full flex-col">
      {store.mode === "local" && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          Local demo mode: data is saved only in this browser. Add the Firebase settings to store data in the cloud.
        </div>
      )}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <NavLink to="/"><Brand /></NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={link}><Users className="size-4" /> Patients</NavLink>
            <NavLink to="/settings" className={link}><Settings className="size-4" /> Settings</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {profile.status === "trial" && (
              <Badge tone={left <= 5 ? "amber" : "brand"}>Free trial · {left} day{left === 1 ? "" : "s"} left</Badge>
            )}
            <span className="hidden text-sm text-slate-600 sm:inline">{profile.name}</span>
            <Button variant="ghost" size="sm" onClick={() => store.signOut()} title="Sign out">
              <LogOut className="size-4" /> <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400">
        FruitCatcher · Questions about your account: {ADMIN_CONTACT}
      </footer>
    </div>
  );
}

export function TrialEndedPage() {
  const { profile } = useClinician();
  const blocked = profile.status === "blocked";
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 flex justify-center"><Brand /></div>
        <h1 className="text-xl font-semibold text-slate-900">{blocked ? "Access paused" : "Your free trial has ended"}</h1>
        <p className="mt-3 text-sm text-slate-600">
          {blocked ? "Access to this account is currently paused." : "Thank you for trying FruitCatcher."} Please contact the admin to continue:
        </p>
        <p className="mt-2 font-medium text-brand-700">{ADMIN_CONTACT}</p>
        <p className="mt-4 text-xs text-slate-500">All your patients and sessions are kept safely and will be there when access is restored.</p>
        <Button variant="outline" className="mt-6" onClick={() => store.signOut()}>Sign out</Button>
      </div>
    </div>
  );
}
