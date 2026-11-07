import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { store } from "../data/store";
import type { Clinician } from "../data/types";

interface AuthState {
  uid: string | null;
  profile: Clinician | null;
  loading: boolean;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthState>({ uid: null, profile: null, loading: true, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [uid, setUid] = useState<string | null>(null);
  const [profile, setProfile] = useState<Clinician | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (u: string | null) => {
    setLoading(true);
    setUid(u);
    try {
      setProfile(u ? await store.getProfile(u) : null);
    } catch (e) {
      console.error(e);
      setProfile(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => store.onAuth((u) => void load(u)), [load]);

  const refresh = useCallback(() => load(uid), [load, uid]);
  return <Ctx.Provider value={{ uid, profile, loading, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** For pages behind the login: uid and profile are always set there. */
export function useClinician() {
  const a = useContext(Ctx);
  return { uid: a.uid!, profile: a.profile!, refresh: a.refresh };
}
