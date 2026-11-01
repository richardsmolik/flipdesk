import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, money, type Item } from "../api";
import { Modal, MpBadge, QtyBar, toast, useFetch, useMarketplaces } from "../ui";

const TABS = ["active", "draft", "sold", "archived", "all"] as const;

export default function Inventory() {
  const [status, setStatus] = useState<(typeof TABS)[number]>("active");
  const [q, setQ] = useState("");
  const [mp, setMp] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<null | "crosslist" | "price">(null);
  const url = `/api/items?status=${status}&q=${encodeURIComponent(q)}${mp ? `&marketplace=${mp}` : ""}`;
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
          <a className="btn-ghost" href="/api/export/inventory.csv">⬇ CSV</a>
          <Link className="btn-primary" to="/items/new">✨ New listing</Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
          {TABS.map((t) => (
            <button key={t} onClick={() => (setStatus(t), setSel(new Set()))} className={`rounded px-3 py-1 text-sm capitalize ${status === t ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-100"}`}>
              {t}
            </button>
          ))}
        </div>
        <input className="input max-w-xs" placeholder="Search title, SKU, brand, bin…" value={q} onChange={(e) => setQ(e.target.value)} />
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
          <button className="btn-ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      <div className="card overflow-x-auto">
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
                    {i.photos[0] ? <img src={i.photos[0].url} alt="" className="h-11 w-11 rounded-md object-cover" /> : <div className="h-11 w-11 rounded-md bg-zinc-800" />}
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
      </div>

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
