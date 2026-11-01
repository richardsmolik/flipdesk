import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface Hit { itemId: number; sku: string; title: string; status: string; photo: string | null; reason: "photo" | "title"; score: number }

/** "Didn't I already list this?" banner. Dismissals are remembered per item pair on this device. */
export default function Duplicates({ itemId, refreshKey, compact }: { itemId: number; refreshKey?: unknown; compact?: boolean }) {
  const [hits, setHits] = useState<Hit[]>([]);
  const key = (h: Hit) => `fd-notdup-${Math.min(itemId, h.itemId)}-${Math.max(itemId, h.itemId)}`;
  useEffect(() => {
    api.get<Hit[]>(`/api/items/${itemId}/duplicates`).then((r) => setHits(r.filter((h) => !localStorage.getItem(key(h))))).catch(() => {});
  }, [itemId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hits.length) return null;
  if (compact) return <span className="text-amber-300" title={hits.map((h) => h.title).join(", ")}>⚠ possible duplicate</span>;
  return (
    <div className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm">
      <div className="mb-2 font-medium text-amber-200">⚠ Possible duplicate{hits.length > 1 ? "s" : ""}. Is this already in your inventory?</div>
      <ul className="space-y-1.5">
        {hits.map((h) => (
          <li key={h.itemId} className="flex items-center gap-2">
            {h.photo ? <img src={h.photo} alt="" className="h-9 w-9 rounded object-cover" /> : <div className="h-9 w-9 rounded bg-zinc-800" />}
            <Link to={`/items/${h.itemId}`} className="min-w-0 flex-1 truncate hover:underline">{h.title || h.sku}</Link>
            <span className="shrink-0 text-xs text-zinc-400">{h.reason === "photo" ? `photo ${Math.round(h.score * 100)}% match` : "same title"} · {h.status}</span>
            <button className="shrink-0 text-xs text-zinc-500 hover:text-zinc-200" onClick={() => (localStorage.setItem(key(h), "1"), setHits(hits.filter((x) => x !== h)))}>Not a duplicate</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
