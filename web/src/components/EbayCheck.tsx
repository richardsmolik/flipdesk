import { useEffect, useState } from "react";
import { api } from "../api";

interface Check { demo?: boolean; category: { id: string; name: string } | null; missing: { name: string; values: string[] }[]; warning?: string }

/** Pre-flight for eBay: category + required item specifics this item is missing (fill them in one click). */
export default function EbayCheck({ itemId, specifics, onSet, refreshKey }: { itemId: number; specifics: Record<string, string>; onSet: (name: string, value: string) => void; refreshKey: unknown }) {
  const [c, setC] = useState<Check | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<Check>(`/api/items/${itemId}/ebay-check`).then(setC).catch((e: Error) => setErr(e.message));
  }, [itemId, refreshKey]);
  if (err) return <div className="text-[11px] text-red-300">eBay check failed: {err}</div>;
  if (!c || c.demo) return null;
  const missing = c.missing.filter((m) => !specifics[m.name]);
  return (
    <div className={`rounded-md border p-2 text-xs ${missing.length ? "border-amber-900 bg-amber-950/30" : "border-green-900 bg-green-950/20"}`}>
      <div className="text-zinc-300">eBay category: <b>{c.category?.name ?? "unknown"}</b></div>
      {c.warning && <div className="text-amber-200">{c.warning}</div>}
      {missing.length === 0 ? (
        <div className="text-green-300">✓ All required item specifics are filled in</div>
      ) : (
        <div className="mt-1 space-y-1">
          <div className="text-amber-200">eBay requires these for this category. Fill them in, then Save:</div>
          {missing.map((m) => (
            <label key={m.name} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-zinc-300">{m.name}</span>
              {m.values.length ? (
                <select className="input py-1 text-xs" defaultValue="" onChange={(e) => e.target.value && onSet(m.name, e.target.value)}>
                  <option value="" disabled>Choose…</option>
                  {m.values.map((v) => <option key={v}>{v}</option>)}
                </select>
              ) : (
                <input className="input py-1 text-xs" placeholder={m.name} onBlur={(e) => e.target.value && onSet(m.name, e.target.value)} />
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
