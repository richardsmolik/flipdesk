import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, money, type Item } from "../api";
import { Modal, MpBadge, QtyBar, toast, useFetch, useMarketplaces } from "../ui";
import Lightbox from "../components/Lightbox";
import ImportInventory from "../components/ImportInventory";

const VIEWS = [
  { key: "inventory", label: "Inventory", hint: "Everything in stock" },
  { key: "selling", label: "Selling", hint: "Live on at least one site" },
  { key: "unsold", label: "Not sold yet", hint: "Live but no sales yet, oldest first" },
  { key: "drafts", label: "Drafts", hint: "Not listed yet" },
  { key: "sold", label: "Sold", hint: "Has at least one sale" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

const daysListed = (i: Item) => {
  const first = i.listings.filter((l) => l.listed_at).map((l) => Date.parse(l.listed_at!.replace(" ", "T") + "Z")).sort()[0];
  return first ? Math.floor((Date.now() - first) / 86400_000) : null;
};

export default function Inventory() {
  const [view, setView] = useState<ViewKey>(() => (new URLSearchParams(location.search).get("view") as ViewKey) || "inventory");
  const [layout, setLayout] = useState<"grid" | "list">(() => (localStorage.getItem("fd-layout") as "grid" | "list") || "grid");
  const [viewer, setViewer] = useState<{ idx: number; photo: number } | null>(null);
  const { data: counts } = useFetch<Record<ViewKey, number>>("/api/items-counts");
  const [q, setQ] = useState("");
  const [mp, setMp] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<null | "crosslist" | "price">(null);
  const [importing, setImporting] = useState(false);
  const url = `/api/items?view=${view}&q=${encodeURIComponent(q)}${mp ? `&marketplace=${mp}` : ""}`;
  const { data: items, reload } = useFetch<Item[]>(url);
  const { marketplaces, byId } = useMarketplaces();
  const nav = useNavigate();

  const totals = useMemo(() => {
    const list = items ?? [];
    return {
      units: list.reduce((s, i) => s + i.quantity, 0),
      value: list.reduce((s, i) => s + i.price * i.quantity, 0),
      cost: list.reduce((s, i) => s + i.cost * i.quantity, 0),
    };
  }, [items]);

  const toggle = (id: number) => setSel((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));
  const allSelected = items?.length ? items.every((i) => sel.has(i.id)) : false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-sm text-zinc-400">
            {items?.length ?? 0} items · {totals.units} units left · {money(totals.value)} at list · {money(totals.cost)} cost
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setImporting(true)}>⬆ Import</button>
          <Link className="btn-ghost" to="/bulk">🗂️ Bulk upload</Link>
          <a className="btn-ghost" href="/api/export/inventory.csv">⬇ CSV</a>
          <Link className="btn-primary" to="/items/new">✨ New listing</Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
          {VIEWS.map((t) => (
            <button
              key={t.key}
              title={t.hint}
              onClick={() => (setView(t.key), setSel(new Set()), history.replaceState(null, "", `?view=${t.key}`))}
              className={`rounded px-3 py-1 text-sm ${view === t.key ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-100"}`}
            >
              {t.label}
              {counts && <span className="ml-1 text-xs text-zinc-500">{counts[t.key]}</span>}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5" role="group" aria-label="Layout">
          {(["grid", "list"] as const).map((l) => (
            <button key={l} onClick={() => (setLayout(l), localStorage.setItem("fd-layout", l))} className={`rounded px-2 py-1 text-sm ${layout === l ? "bg-zinc-700 text-white" : "text-zinc-400"}`} aria-pressed={layout === l}>
              {l === "grid" ? "▦ Photos" : "☰ List"}
            </button>
          ))}
        </div>
        <input data-search className="input max-w-xs" placeholder="Search title, SKU, brand, bin…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[200px]" value={mp} onChange={(e) => setMp(e.target.value)}>
          <option value="">Live on any site</option>
          {marketplaces.map((m) => <option key={m.id} value={m.id}>Live on {m.name}</option>)}
        </select>
      </div>

      {sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-900 bg-blue-950/40 px-3 py-2 text-sm">
          <span className="text-blue-200">{sel.size} selected</span>
          <button className="btn-ghost" onClick={() => setBulk("crosslist")}>🔁 Crosslist to…</button>
          <button className="btn-ghost" onClick={() => setBulk("price")}>💲 Change price…</button>
          <button className="btn-ghost" onClick={() => window.open(`/print/labels?items=${[...sel].join(",")}`, "_blank")}>🏷️ Print labels</button>
          {sel.size >= 2 && (
            <button
              className="btn-ghost"
              onClick={async () => {
                try {
                  const lot = await api.post<Item>("/api/bundles", { parts: [...sel].map((itemId) => ({ itemId })) });
                  toast(`Lot ${lot.sku} created`);
                  nav(`/items/${lot.id}`);
                } catch (e) {
                  toast((e as Error).message, "err");
                }
              }}
            >
              🎁 Make a lot
            </button>
          )}
          <button className="btn-ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {layout === "grid" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {items?.map((i, idx) => {
            const age = daysListed(i);
            const live = [...new Map(i.listings.filter((l) => ["active", "queued", "sold"].includes(l.status)).map((l) => [l.marketplace, l])).values()];
            return (
              <div key={i.id} className={`card group overflow-hidden ${sel.has(i.id) ? "ring-2 ring-brand" : ""}`}>
                <div className="relative aspect-square bg-zinc-800">
                  <button className="h-full w-full" onClick={() => setViewer({ idx, photo: 0 })} aria-label={`View photos of ${i.title}`}>
                    {i.photos[0] ? <img src={i.photos[0].url} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" /> : <span className="text-3xl text-zinc-600">📷</span>}
                  </button>
                  <input type="checkbox" className="absolute left-2 top-2 h-4 w-4" checked={sel.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.sku}`} />
                  {i.photos.length > 1 && <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px]">📷 {i.photos.length}</span>}
                  {view === "unsold" && age !== null && (
                    <span className={`pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-medium ${age >= 60 ? "bg-red-900/90 text-red-100" : age >= 30 ? "bg-amber-900/90 text-amber-100" : "bg-black/70 text-zinc-200"}`}>{age}d listed</span>
                  )}
                  {i.status === "draft" && <span className="pointer-events-none absolute right-2 top-2 rounded bg-zinc-900/90 px-1.5 py-0.5 text-[11px]">Draft</span>}
                  {i.quantity === 0 && i.quantity_sold > 0 && <span className="pointer-events-none absolute right-2 top-2 rounded bg-green-900/90 px-1.5 py-0.5 text-[11px] text-green-100">Sold</span>}
                </div>
                <Link to={`/items/${i.id}`} className="block space-y-1.5 p-2.5">
                  <div className="line-clamp-2 min-h-[2.5rem] text-sm font-medium text-zinc-100">{i.title || <span className="text-zinc-500">Untitled draft</span>}</div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold tabular-nums text-zinc-100">{money(i.price)}</span>
                    <span className="text-zinc-500">{i.sku}</span>
                  </div>
                  <QtyBar compact purchased={i.quantity_purchased} sold={i.quantity_sold} left={i.quantity} />
                  <div className="flex flex-wrap gap-1">
                    {live.map((l) => <MpBadge key={l.id} small id={l.marketplace} status={l.status} mp={byId[l.marketplace]} />)}
                    {!live.length && <span className="text-[11px] text-zinc-600">not listed</span>}
                  </div>
                </Link>
              </div>
            );
          })}
          {items?.length === 0 && <div className="col-span-full p-10 text-center text-zinc-500">Nothing here. <Link to="/items/new" className="text-brand hover:underline">Create a listing</Link></div>}
        </div>
      )}

      {layout === "list" && <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <tr>
              <th className="p-3"><input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(items?.map((i) => i.id)))} aria-label="Select all" /></th>
              <th className="p-3 font-medium">Item</th>
              <th className="p-3 font-medium">Quantity</th>
              <th className="p-3 text-right font-medium">Price</th>
              <th className="p-3 text-right font-medium">Cost/unit</th>
              <th className="p-3 font-medium">Listed on</th>
              <th className="p-3 font-medium">Bin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {items?.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-zinc-900" onClick={() => nav(`/items/${i.id}`)}>
                <td className="p-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.sku}`} /></td>
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    {i.photos[0] ? (
                      <button onClick={(e) => (e.stopPropagation(), setViewer({ idx: items.indexOf(i), photo: 0 }))} aria-label={`View photos of ${i.title}`}>
                        <img src={i.photos[0].url} alt="" className="h-11 w-11 rounded-md object-cover" />
                      </button>
                    ) : <div className="h-11 w-11 rounded-md bg-zinc-800" />}
                    <div className="min-w-0">
                      <div className="max-w-md truncate font-medium text-zinc-100">{i.title || <span className="text-zinc-500">Untitled draft</span>}</div>
                      <div className="text-xs text-zinc-500">{i.sku}{i.brand ? ` · ${i.brand}` : ""}{i.variations.length ? <span className="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-300">{i.variations.length} options</span> : null}</div>
                    </div>
                  </div>
                </td>
                <td className="p-3"><QtyBar compact purchased={i.quantity_purchased} sold={i.quantity_sold} left={i.quantity} /></td>
                <td className="p-3 text-right tabular-nums">{money(i.price)}</td>
                <td className="p-3 text-right tabular-nums text-zinc-400">{money(i.cost)}</td>
                <td className="p-3">
                  <div className="flex max-w-xs flex-wrap gap-1">
                    {[...new Map(i.listings.filter((l) => l.status !== "ended").map((l) => [l.marketplace, l])).values()].map((l) => <MpBadge key={l.id} small id={l.marketplace} status={l.status} mp={byId[l.marketplace]} />)}
                    {!i.listings.length && <span className="text-xs text-zinc-600">not listed</span>}
                  </div>
                </td>
                <td className="p-3 text-xs text-zinc-400">{i.location}</td>
              </tr>
            ))}
            {items?.length === 0 && (
              <tr><td colSpan={7} className="p-10 text-center text-zinc-500">Nothing here. <Link to="/items/new" className="text-brand hover:underline">Create a listing</Link></td></tr>
            )}
          </tbody>
        </table>
      </div>}

      {viewer && items?.[viewer.idx] && (
        <Lightbox
          item={items[viewer.idx]}
          start={viewer.photo}
          onClose={() => setViewer(null)}
          onPrevItem={viewer.idx > 0 ? () => setViewer({ idx: viewer.idx - 1, photo: 0 }) : undefined}
          onNextItem={viewer.idx < items.length - 1 ? () => setViewer({ idx: viewer.idx + 1, photo: 0 }) : undefined}
        />
      )}

      <ImportInventory open={importing} onClose={() => setImporting(false)} onDone={() => (setImporting(false), reload())} />
      <BulkCrosslist open={bulk === "crosslist"} ids={[...sel]} onClose={() => setBulk(null)} onDone={() => (setBulk(null), setSel(new Set()), reload())} />
      <BulkPrice open={bulk === "price"} ids={[...sel]} onClose={() => setBulk(null)} onDone={() => (setBulk(null), reload())} />
    </div>
  );
}

function BulkCrosslist({ open, ids, onClose, onDone }: { open: boolean; ids: number[]; onClose: () => void; onDone: () => void }) {
  const { marketplaces } = useMarketplaces();
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Modal open={open} onClose={onClose} title={`Crosslist ${ids.length} item(s)`}>
      <div className="grid grid-cols-2 gap-2">
        {marketplaces.map((m) => (
          <label key={m.id} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm">
            <input type="checkbox" checked={picked.includes(m.id)} onChange={() => setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))} />
            <MpBadge id={m.id} mp={m} />
          </label>
        ))}
      </div>
      <button
        className="btn-primary mt-4 w-full"
        disabled={!picked.length}
        onClick={async () => {
          try {
            const r = await api.post<{ queued: number }>("/api/bulk/crosslist", { itemIds: ids, marketplaces: picked });
            toast(`Queued ${r.queued} new listing(s)`);
            onDone();
          } catch (e) {
            toast((e as Error).message, "err");
          }
        }}
      >
        Crosslist now
      </button>
    </Modal>
  );
}

function BulkPrice({ open, ids, onClose, onDone }: { open: boolean; ids: number[]; onClose: () => void; onDone: () => void }) {
  const [pct, setPct] = useState(-10);
  return (
    <Modal open={open} onClose={onClose} title={`Change price on ${ids.length} item(s)`}>
      <label className="label">Change by %</label>
      <input className="input" type="number" value={pct} onChange={(e) => setPct(Number(e.target.value))} />
      <p className="mt-2 text-xs text-zinc-500">Never goes below each item's minimum price. Live listings are updated on every marketplace.</p>
      <button
        className="btn-primary mt-4 w-full"
        onClick={async () => {
          const r = await api.post<unknown[]>("/api/tools/bulk-price", { itemIds: ids, pct });
          toast(`Updated ${r.length} price(s)`);
          onDone();
        }}
      >
        Apply {pct > 0 ? "+" : ""}{pct}%
      </button>
    </Modal>
  );
}
