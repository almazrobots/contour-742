import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { FINDING, PROCESS, SYNC, VERIFICATION } from "../lib/labels";

// ─────────────── иконки (линейные, 18px, currentColor)
const paths: Record<string, string> = {
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  building: "M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16M15 9h4a1 1 0 011 1v11M3 21h18M8 8h3M8 12h3M8 16h3",
  check: "M9 12.5l2 2 4-4.5M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z",
  upload: "M12 15V4m0 0l-4 4m4-4l4 4M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3",
  matrix: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  book: "M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zM4 19a2 2 0 012-2h13",
  brain: "M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 1V4.5A3 3 0 009 4zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 1",
  log: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  out: "M15 12H4m0 0l4-4m-4 4l4 4M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4",
  chev: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  split: "M6 3v6a3 3 0 003 3h6a3 3 0 013 3v6M6 21v-6M18 3v4M15 5l3-3 3 3",
  bell: "M18 16v-5a6 6 0 10-12 0v5l-2 2h16l-2-2zM10 21h4",
  api: "M8 9l-3 3 3 3M16 9l3 3-3 3M13 7l-2 10",
  trace: "M4 6h4v4H4zM16 14h4v4h-4zM10 8h4M8 10v2a4 4 0 004 4h4",
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.list} />
    </svg>
  );
}

// ─────────────── пилюли статусов
export function Pill({ tone, children, solid }: { tone: string; children: ReactNode; solid?: boolean }) {
  return <span className={`pill ${solid ? "solid-" : ""}${tone}`}>{children}</span>;
}

export function FindingPill({ status, solid }: { status: string; solid?: boolean }) {
  const s = FINDING[status] ?? { ru: status, tone: "gray" };
  return (
    <Pill tone={s.tone} solid={solid}>
      <span title={status}>{s.ru}</span>
    </Pill>
  );
}

export function VerificationPill({ status }: { status: string }) {
  const s = VERIFICATION[status] ?? { ru: status, tone: "gray" };
  return <Pill tone={s.tone}>{s.ru}</Pill>;
}

export function ProcessPill({ status }: { status: string }) {
  const s = PROCESS[status] ?? { ru: status, tone: "gray" };
  return <Pill tone={s.tone}>{s.ru}</Pill>;
}

export function SyncPill({ status }: { status: string | null }) {
  if (!status) return null;
  const s = SYNC[status] ?? { ru: status, tone: "gray" };
  return <Pill tone={s.tone}>{s.ru}</Pill>;
}

export function Priority({ p }: { p: string }) {
  const ru = { HIGH: "Высокий", MEDIUM: "Средний", LOW: "Низкий" }[p] ?? p;
  return (
    <span className={`flag ${p}`} title="Очерёдность экспертной проверки — не юридическое действие">
      <Icon name="flag" size={14} />
      {ru}
    </span>
  );
}

// ─────────────── тосты
type Toast = { text: string; err?: boolean } | null;
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const show = useCallback((text: string, err?: boolean) => setT({ text, err }), []);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), t.err ? 6000 : 3500);
    return () => clearTimeout(h);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast ${t.err ? "err" : ""}`} role="status">
          {t.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ─────────────── загрузка данных
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

export function Loading({ error }: { error?: string | null }) {
  return <div className="empty">{error ? `Не удалось загрузить: ${error}` : "Загрузка…"}</div>;
}
