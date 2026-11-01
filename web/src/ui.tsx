import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Marketplace } from "./api";

export function useFetch<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const load = useCallback(() => {
    if (!url) return;
    setLoading(true);
    api
      .get<T>(url)
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(load, [load]);
  return { data, error, loading, reload: load, setData };
}

let mpCache: Marketplace[] | null = null;
export function useMarketplaces() {
  const [m, setM] = useState<Marketplace[]>(mpCache ?? []);
  const reload = useCallback(() => {
    api.get<Marketplace[]>("/api/marketplaces").then((d) => ((mpCache = d), setM(d)));
  }, []);
  useEffect(() => {
    if (!mpCache) reload();
  }, [reload]);
  return { marketplaces: m, byId: Object.fromEntries(m.map((x) => [x.id, x])) as Record<string, Marketplace>, reload };
}

/** Marketplace identity chip: brand color dot + name/initials (identity is never color-alone). */
export function MpBadge({ id, status, small, mp }: { id: string; status?: string; small?: boolean; mp?: Marketplace }) {
  const name = mp?.name ?? id;
  const tone =
    status === "active"
      ? "border-zinc-700 text-zinc-200"
      : status === "sold"
        ? "border-green-800 text-green-300"
        : status === "error"
          ? "border-red-800 text-red-300"
          : status === "queued" || status === "ending"
            ? "border-amber-800 text-amber-300"
            : "border-zinc-800 text-zinc-500 line-through";
  return (
    <span
      title={`${name}${status ? ` - ${status}` : ""}`}
      className={`inline-flex items-center gap-1 rounded-full border bg-zinc-950 ${small ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-xs"} ${status ? tone : "border-zinc-700 text-zinc-200"}`}
    >
      <span className="h-2 w-2 rounded-full ring-1 ring-zinc-500/60" style={{ background: mp?.color ?? "#888" }} />
      {small ? name.split(" ")[0].slice(0, 6) : name}
    </span>
  );
}

export function Stat({ label, value, sub, delta }: { label: string; value: ReactNode; sub?: ReactNode; delta?: number | null }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-50">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
        {delta !== undefined && delta !== null && Number.isFinite(delta) && (
          <span className={delta >= 0 ? "text-green-400" : "text-red-400"}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}%
          </span>
        )}
        {sub}
      </div>
    </div>
  );
}

/** Units purchased / sold / left with a compact bar. */
export function QtyBar({ purchased, sold, left, compact }: { purchased: number; sold: number; left: number; compact?: boolean }) {
  const total = Math.max(purchased, sold + left, 1);
  return (
    <div className={compact ? "w-40" : "w-full"}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
        <div className="bg-good" style={{ width: `${(sold / total) * 100}%` }} />
        <div className="ml-[2px] bg-brand" style={{ width: `${(left / total) * 100}%` }} />
      </div>
      <div className="mt-1 text-[11px] tabular-nums text-zinc-400">
        <span className="text-zinc-200">{left}</span> left · {sold} sold · {purchased} bought
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="text-zinc-400 hover:text-zinc-100" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

let toastFn: ((m: string, kind?: "ok" | "err") => void) | null = null;
export const toast = (m: string, kind: "ok" | "err" = "ok") => toastFn?.(m, kind);
export function Toaster() {
  const [items, setItems] = useState<{ id: number; m: string; kind: string }[]>([]);
  useEffect(() => {
    toastFn = (m, kind = "ok") => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, m, kind }]);
      setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500);
    };
  }, []);
  return (
    <div className="fixed bottom-4 right-4 z-[60] space-y-2">
      {items.map((t) => (
        <div key={t.id} className={`rounded-lg border px-4 py-2 text-sm shadow-lg ${t.kind === "err" ? "border-red-800 bg-red-950 text-red-100" : "border-zinc-700 bg-zinc-900 text-zinc-100"}`}>
          {t.kind === "err" ? "⚠ " : "✓ "}
          {t.m}
        </div>
      ))}
    </div>
  );
}

export const timeAgo = (iso?: string | null) => {
  if (!iso) return "-";
  const d = (Date.now() - Date.parse(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"))) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
