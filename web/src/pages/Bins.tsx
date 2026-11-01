import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { money, type Item } from "../api";
import { useFetch } from "../ui";
import Lightbox from "../components/Lightbox";

interface Bin { name: string; items: number; units: number; value: number; oldest_days: number }

export function BinList() {
  const { data } = useFetch<Bin[]>("/api/bins");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const all = data?.map((b) => b.name) ?? [];
  const open = (size: string) => window.open(`/print/labels?size=${size}&bins=${encodeURIComponent([...(sel.size ? sel : all)].join(","))}`, "_blank");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bins</h1>
          <p className="text-sm text-zinc-400">Where everything lives. Print a QR label for each bin; scan it with your phone to see what's inside, with photos.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => open("small")}>🏷️ Print {sel.size || "all"} bin labels (small)</button>
          <button className="btn-ghost" onClick={() => open("large")}>4x6</button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data?.map((b) => (
          <div key={b.name} className={`card p-4 ${sel.has(b.name) ? "ring-2 ring-brand" : ""}`}>
            <div className="flex items-center justify-between">
              <Link to={`/bins/${encodeURIComponent(b.name)}`} className="text-lg font-semibold hover:underline">{b.name}</Link>
              <input type="checkbox" checked={sel.has(b.name)} onChange={() => setSel((s) => (s.has(b.name) ? (s.delete(b.name), new Set(s)) : new Set(s.add(b.name))))} aria-label={`Select ${b.name}`} />
            </div>
            <div className="mt-1 text-sm text-zinc-400">{b.items} items · {b.units} units · {money(b.value)}</div>
            <div className={`text-xs ${b.oldest_days >= 60 ? "text-amber-300" : "text-zinc-500"}`}>oldest {b.oldest_days} days</div>
          </div>
        ))}
        {data?.length === 0 && <div className="text-sm text-zinc-500">No bins yet. Set "Bin / location" on items.</div>}
      </div>
    </div>
  );
}

export function BinDetail() {
  const { name = "" } = useParams();
  const { data } = useFetch<Item[]>(`/api/bins/${encodeURIComponent(name)}`);
  const [view, setView] = useState<number | null>(null);
  return (
    <div className="space-y-4">
      <Link to="/bins" className="text-xs text-zinc-500 hover:text-zinc-300">← Bins</Link>
      <h1 className="text-2xl font-semibold">Bin {name} <span className="text-base font-normal text-zinc-500">({data?.length ?? 0} items)</span></h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {data?.map((i, idx) => (
          <div key={i.id} className="card overflow-hidden">
            <button className="aspect-square w-full bg-zinc-800" onClick={() => setView(idx)} aria-label={`View photos of ${i.title}`}>
              {i.photos[0] ? <img src={i.photos[0].url} alt="" className="h-full w-full object-cover" /> : "📷"}
            </button>
            <Link to={`/items/${i.id}`} className="block p-2 text-sm">
              <div className="line-clamp-2">{i.title}</div>
              <div className="text-xs text-zinc-500">{i.sku} · {money(i.price)} · {i.quantity} left</div>
            </Link>
          </div>
        ))}
      </div>
      {view !== null && data?.[view] && (
        <Lightbox item={data[view]} onClose={() => setView(null)} onPrevItem={view > 0 ? () => setView(view - 1) : undefined} onNextItem={view < data.length - 1 ? () => setView(view + 1) : undefined} />
      )}
    </div>
  );
}
