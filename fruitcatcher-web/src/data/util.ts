export const TRIAL_DAYS = Math.min(31, Number(import.meta.env.VITE_TRIAL_DAYS) || 30);
export const ADMIN_CONTACT = (import.meta.env.VITE_ADMIN_CONTACT as string) || "the FruitCatcher admin";

export const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 20);
