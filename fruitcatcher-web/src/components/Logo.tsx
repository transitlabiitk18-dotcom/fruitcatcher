export function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="36" r="22" fill="#f97316" />
      <circle cx="24" cy="28" r="6" fill="#fff7ed" />
      <path d="M32 14 L37 4" stroke="#16a34a" strokeWidth="5" strokeLinecap="round" />
      <ellipse cx="44" cy="8" rx="9" ry="4" fill="#22c55e" transform="rotate(-20 44 8)" />
    </svg>
  );
}

export function Brand({ light }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <Logo className="size-7" />
      <span className={`text-lg font-bold tracking-tight ${light ? "text-white" : "text-slate-900"}`}>
        Fruit<span className={light ? "text-brand-200" : "text-brand-600"}>Catcher</span>
      </span>
    </span>
  );
}
