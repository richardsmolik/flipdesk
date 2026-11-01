import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api";
import { Modal, MpBadge, toast, useFetch, useMarketplaces } from "../ui";

interface Addr { name: string; line1: string; line2?: string; city: string; state: string; zip: string }
interface Row {
  id: number; item_id: number; marketplace: string; quantity: number; sale_price: number; shipping_cost: number;
  order_id: string | null; buyer: string | null; sold_at: string; tracking: string | null; sku: string; title: string;
  ship_to: Addr | null; provider: "marketplace" | "ebay" | "pirateship" | "shippo" | "manual"; label_url: string | null;
}

const GROUPS = [
  { key: "ebay", title: "🏷️ Buy label on eBay", hint: "Buy the label in eBay Seller Hub as usual. FlipDesk pulls the exact label cost from eBay automatically." },
  { key: "shippo", title: "🚀 Buy label in FlipDesk (Shippo)", hint: "Compare USPS, UPS and FedEx rates and print a 4x6 label without leaving FlipDesk. Cost and tracking are saved automatically, and tracking goes back to eBay." },
  { key: "pirateship", title: "🏴‍☠️ Pirate Ship", hint: "Select orders, then Export CSV and upload it in Pirate Ship (Ship > Import Spreadsheet). After buying the labels, export your Pirate Ship history and import it here to attach costs and tracking. Tracking goes back to eBay automatically." },
  { key: "marketplace", title: "📦 Prepaid label from the marketplace", hint: "Print the label from the site's app. Usually the buyer pays, so the label cost is $0." },
  { key: "manual", title: "✍️ Manual", hint: "Enter label cost and tracking yourself." },
] as const;

function ShipRow({ r, selectable, selected, onToggle, onDone }: { r: Row; selectable: boolean; selected: boolean; onToggle: () => void; onDone: () => void }) {
  const { byId } = useMarketplaces();
  const [cost, setCost] = useState(r.shipping_cost ? r.shipping_cost.toFixed(2) : "");
  const [tracking, setTracking] = useState(r.tracking ?? "");
  const [addr, setAddr] = useState("");
  const [editAddr, setEditAddr] = useState(false);
  const [rates, setRates] = useState(false);
  const save = async (shipped: boolean) => {
    try {
      await api.post(`/api/sales/${r.id}/shipping`, { cost: cost === "" ? undefined : Number(cost), tracking: tracking || undefined, shipped, address: addr || undefined });
      toast(shipped ? "Marked shipped - profit updated" : "Saved");
      setEditAddr(false);
      onDone();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <div className="flex flex-wrap items-start gap-3 border-t border-zinc-800 py-3 text-sm first:border-t-0">
      {selectable && <input type="checkbox" className="mt-1" checked={selected} onChange={onToggle} aria-label={`Select ${r.sku}`} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <MpBadge id={r.marketplace} mp={byId[r.marketplace]} small />
          <Link to={`/items/${r.item_id}`} className="truncate hover:underline">{r.quantity > 1 ? `${r.quantity}x ` : ""}{r.title}</Link>
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {money(r.sale_price)} · sold {r.sold_at.slice(0, 10)}{r.buyer ? ` · ${r.buyer}` : ""}
          {" · "}
          {r.ship_to?.line1 ? <span className="text-zinc-400">{r.ship_to.name}, {r.ship_to.city} {r.ship_to.state}</span> : r.provider === "pirateship" ? <span className="text-amber-300">no address yet</span> : null}
          {(r.provider === "pirateship" || r.provider === "manual") && (
            <button className="ml-2 text-brand hover:underline" onClick={() => setEditAddr(!editAddr)}>{r.ship_to?.line1 ? "edit address" : "add address"}</button>
          )}
        </div>
        {editAddr && (
          <textarea className="input mt-2 min-h-20 text-xs" placeholder={"Jane Doe\n123 Main St\nApt 4\nAustin, TX 78701"} value={addr} onChange={(e) => setAddr(e.target.value)} />
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <input className="input w-20 py-1" type="number" step="0.01" placeholder="Label $" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Label cost" />
        <input className="input w-40 py-1" placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} aria-label="Tracking" />
        {editAddr && <button className="btn-ghost py-1 text-xs" onClick={() => save(false)}>Save</button>}
        {(r.provider === "shippo" || r.provider === "pirateship" || r.provider === "manual") && (
          <button className="btn-primary py-1 text-xs" disabled={!r.ship_to?.line1} title={r.ship_to?.line1 ? "Compare rates and buy a label" : "Add the address first"} onClick={() => setRates(true)}>🚀 Buy label</button>
        )}
        <button className="btn-ghost py-1 text-xs" onClick={() => save(true)}>✓ Shipped</button>
      </div>
      {rates && <RatesModal row={r} onClose={() => setRates(false)} onDone={() => (setRates(false), onDone())} />}
    </div>
  );
}

export default function Shipping() {
  const { data, reload } = useFetch<{ rows: Row[]; ebayLive: boolean }>("/api/shipping");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const file = useRef<HTMLInputElement>(null);
  const rows = data?.rows ?? [];

  const exportCsv = async () => {
    const res = await fetch("/api/shipping/pirateship/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saleIds: [...sel] }) });
    if (!res.ok) return toast(((await res.json()) as { error: string }).error, "err");
    const missing = res.headers.get("X-Missing-Addresses");
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: `pirateship-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
    toast(missing ? `Exported. Skipped (no address): ${missing}` : "Exported. Upload it in Pirate Ship (Ship > Import Spreadsheet)");
  };
  const importCsv = async (f: File) => {
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await api.post<{ matched: number; unmatched: string[]; trackingUploaded: number }>("/api/shipping/pirateship/import", fd);
      toast(`Matched ${r.matched} label(s)${r.trackingUploaded ? `, sent ${r.trackingUploaded} tracking number(s) to eBay` : ""}${r.unmatched.length ? `. Unmatched: ${r.unmatched.slice(0, 3).join(", ")}` : ""}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Shipping</h1>
          <p className="text-sm text-zinc-400">{rows.length} order(s) to ship. Choose eBay labels or Pirate Ship for each marketplace in Settings.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={!rows.length} onClick={() => window.open(`/print/slips?ids=${rows.map((r) => r.id).join(",")}`, "_blank")}>🖨 Packing slips</button>
          <button className="btn-ghost" disabled={!rows.length} onClick={() => window.open(`/print/picklist?ids=${rows.map((r) => r.id).join(",")}`, "_blank")}>🧺 Pick list</button>
        </div>
        {data?.ebayLive && (
          <button className="btn-ghost" onClick={async () => { const r = await api.post<{ updated: number }>("/api/shipping/ebay-sync"); toast(`Pulled ${r.updated} eBay label cost(s)`); reload(); }}>
            ↻ Pull eBay label costs
          </button>
        )}
      </div>

      {GROUPS.map((g) => {
        const list = rows.filter((r) => r.provider === g.key);
        if (!list.length) return null;
        return (
          <section key={g.key} className="card p-4">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{g.title} <span className="text-sm font-normal text-zinc-500">({list.length})</span></h2>
              {g.key === "ebay" && <a className="btn-ghost text-xs" href="https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT" target="_blank" rel="noreferrer">Open eBay orders ↗</a>}
              {g.key === "pirateship" && (
                <div className="flex gap-2">
                  <button className="btn-primary text-xs" disabled={!sel.size} onClick={exportCsv}>⬇ Export {sel.size || ""} to Pirate Ship</button>
                  <input ref={file} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
                  <button className="btn-ghost text-xs" onClick={() => file.current?.click()}>⬆ Import Pirate Ship history</button>
                  <a className="btn-ghost text-xs" href="https://ship.pirateship.com" target="_blank" rel="noreferrer">Pirate Ship ↗</a>
                </div>
              )}
            </div>
            <p className="mb-2 text-xs text-zinc-500">{g.hint}</p>
            {list.map((r) => (
              <ShipRow
                key={r.id}
                r={r}
                selectable={g.key === "pirateship"}
                selected={sel.has(r.id)}
                onToggle={() => setSel((s) => (s.has(r.id) ? (s.delete(r.id), new Set(s)) : new Set(s.add(r.id))))}
                onDone={reload}
              />
            ))}
          </section>
        );
      })}
      {data && !rows.length && <div className="card p-8 text-center text-sm text-zinc-500">Nothing to ship. 🎉</div>}
    </div>
  );
}

interface Rate { id: string; carrier: string; service: string; amount: number; days: number | null }

function RatesModal({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [demo, setDemo] = useState(false);
  const [oz, setOz] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try {
      const r = await api.post<{ rates: Rate[]; demo: boolean }>(`/api/sales/${row.id}/rates`, oz ? { weightOz: Number(oz) } : {});
      setRates(r.rates);
      setDemo(r.demo);
    } catch (e) {
      toast((e as Error).message, "err");
      onClose();
    }
  };
  useEffect(() => {
    if (rates === null) void load();
  }, [rates]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open onClose={onClose} title={`Label for ${row.title.slice(0, 36)}`}>
      <div className="space-y-3 text-sm">
        <div className="text-xs text-zinc-400">To {row.ship_to?.name}, {row.ship_to?.city} {row.ship_to?.state} {row.ship_to?.zip}</div>
        <div className="flex gap-2">
          <input className="input" type="number" placeholder="Weight (oz), blank = item/default" value={oz} onChange={(e) => setOz(e.target.value)} />
          <button className="btn-ghost" onClick={() => (setRates(null))}>Re-rate</button>
        </div>
        {demo && <div className="rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">Demo rates. Add SHIPPO_API_KEY to .env to buy real labels.</div>}
        {!rates && <div className="text-zinc-500">Getting rates…</div>}
        <ul className="divide-y divide-zinc-800">
          {rates?.map((r, i) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium">{r.carrier} {r.service} {i === 0 && <span className="ml-1 rounded bg-green-950 px-1.5 text-[10px] text-green-300">cheapest</span>}</div>
                <div className="text-xs text-zinc-500">{r.days ? `${r.days} day${r.days === 1 ? "" : "s"}` : ""}</div>
              </div>
              <button
                className="btn-primary py-1"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(r.id);
                  try {
                    const b = await api.post<{ labelUrl: string | null; tracking: string; trackingUploaded: boolean }>(`/api/sales/${row.id}/label`, { rate: r });
                    if (b.labelUrl) window.open(b.labelUrl, "_blank");
                    toast(`Label bought: ${money(r.amount)} · ${b.tracking}${b.trackingUploaded ? " · tracking sent to eBay" : ""}`);
                    onDone();
                  } catch (e) {
                    toast((e as Error).message, "err");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === r.id ? "Buying…" : `Buy ${money(r.amount)}`}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
