import { useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api";
import { MpBadge, toast, useFetch, useMarketplaces } from "../ui";
import SoldDataCard from "../components/SoldData";
import { useRef } from "react";

interface Advice { action: "wait" | "small_drop" | "drop" | "at_floor" | "fix_visibility"; pct: number; newPrice: number | null; reason: string; confidence: string; basis: string }
interface Diagnosis { code: string; label: string; fix: string }
interface Stale {
  advice: Advice | null;
  diagnosis: Diagnosis | null;
  traffic: { impressions: number; views: number; ctr: number | null } | null;
  listingId: number; itemId: number; sku: string; title: string; marketplace: string; price: number; minPrice: number | null;
  daysListed: number; views: number; watchers: number; suggestion: "send_offer" | "price_drop" | "relist" | "crosslist"; why: string;
}

const LABEL = { send_offer: "💌 Send offer", price_drop: "📉 Drop 10%", relist: "♻️ Relist", crosslist: "🔁 Crosslist" } as const;

export default function Tools() {
  const [days, setDays] = useState(30);
  const { data, reload } = useFetch<Stale[]>(`/api/tools/stale?days=${days}`);
  const { byId } = useMarketplaces();
  const [offerPct, setOfferPct] = useState(12);
  const [busy, setBusy] = useState(false);

  const act = async (s: Stale) => {
    try {
      if (s.suggestion === "send_offer") {
        const r = await api.post<unknown[]>("/api/tools/send-offers", { itemIds: [s.itemId], pctOff: offerPct });
        toast(r.length ? `Offer sent to watchers of ${s.sku}` : "No eligible eBay listing");
      } else if (s.suggestion === "price_drop") {
        await api.post("/api/tools/bulk-price", { itemIds: [s.itemId], pct: -10 });
        toast(`Dropped ${s.sku} 10% (respecting floor)`);
      } else if (s.suggestion === "relist") {
        await api.post("/api/tools/relist", { listingIds: [s.listingId] });
        toast(`Relisting ${s.sku}`);
      } else {
        location.href = `/items/${s.itemId}`;
        return;
      }
      reload();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const watched = (data ?? []).filter((s) => s.marketplace === "ebay" && s.watchers > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Power tools</h1>
          <p className="text-sm text-zinc-400">Stale-listing radar with a recommended fix for each listing, offers to watchers, relists and bulk repricing.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          Listed ≥
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[14, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
        </div>
      </div>

      <SoldDataCard />
      <TrafficCard onDone={reload} />

      <div className="card flex flex-wrap items-center gap-3 p-4 text-sm">
        <div className="flex-1">
          <div className="font-medium">💌 Offers to all watchers</div>
          <div className="text-xs text-zinc-400">{watched.length} stale eBay listing(s) have watchers. Offers never go below your floor price.</div>
        </div>
        <label className="flex items-center gap-1">
          <input className="input w-16" type="number" value={offerPct} onChange={(e) => setOfferPct(Number(e.target.value))} />% off
        </label>
        <button
          className="btn-primary"
          disabled={!watched.length || busy}
          onClick={async () => {
            setBusy(true);
            const r = await api.post<unknown[]>("/api/tools/send-offers", { itemIds: watched.map((w) => w.itemId), pctOff: offerPct });
            toast(`Sent offers on ${r.length} listing(s)`);
            setBusy(false);
          }}
        >
          Send {watched.length} offer(s)
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <tr><th className="p-3 font-medium">Listing</th><th className="p-3 font-medium">Site</th><th className="p-3 text-right font-medium">Days</th><th className="p-3 text-right font-medium">Views</th><th className="p-3 text-right font-medium">Watchers</th><th className="p-3 text-right font-medium">Price</th><th className="p-3 font-medium">Recommendation</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {data?.map((s) => (
              <tr key={s.listingId}>
                <td className="p-3"><Link className="hover:underline" to={`/items/${s.itemId}`}><div className="max-w-xs truncate">{s.title}</div><div className="text-xs text-zinc-500">{s.sku}</div></Link></td>
                <td className="p-3"><MpBadge id={s.marketplace} mp={byId[s.marketplace]} /></td>
                <td className="p-3 text-right tabular-nums">{s.daysListed}</td>
                <td className="p-3 text-right tabular-nums">{s.views}</td>
                <td className="p-3 text-right tabular-nums">{s.watchers}</td>
                <td className="p-3 text-right tabular-nums">{money(s.price)}{s.minPrice ? <div className="text-[10px] text-zinc-500">floor {money(s.minPrice)}</div> : null}</td>
                <td className="max-w-sm p-3 text-xs">
                  {s.diagnosis && s.diagnosis.code !== "healthy" && s.diagnosis.code !== "too_new" ? (
                    <div className="mb-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.diagnosis.code === "not_seen" ? "bg-red-950 text-red-200" : s.diagnosis.code === "not_clicked" ? "bg-amber-950 text-amber-200" : "bg-blue-950 text-blue-200"}`}>{s.diagnosis.label}</span>
                      <div className="mt-1 text-zinc-300">{s.diagnosis.fix}</div>
                    </div>
                  ) : (
                    <div className="text-zinc-300">{s.why}</div>
                  )}
                  {s.advice && (
                    <div className="mt-1 text-zinc-500" title={`Based on ${s.advice.basis} · confidence ${s.advice.confidence}`}>
                      💡 {s.advice.action === "drop" || s.advice.action === "small_drop" ? <>Drop {s.advice.pct}% to {money(s.advice.newPrice)}: </> : null}{s.advice.reason}
                    </div>
                  )}
                </td>
                <td className="space-y-1 p-3">
                  {s.advice?.newPrice && (s.advice.action === "drop" || s.advice.action === "small_drop") ? (
                    <button className="btn-primary w-full whitespace-nowrap text-xs" onClick={async () => { await api.post("/api/tools/bulk-price", { itemIds: [s.itemId], set: s.advice!.newPrice }); toast(`Price set to ${money(s.advice!.newPrice)}`); reload(); }}>
                      💡 {money(s.advice.newPrice)}
                    </button>
                  ) : null}
                  {s.diagnosis?.code === "not_clicked" ? (
                    <a className="btn-ghost w-full whitespace-nowrap text-xs" href={`/items/${s.itemId}`}>📷 Fix cover photo</a>
                  ) : (
                    <button className="btn-ghost w-full whitespace-nowrap text-xs" onClick={() => act(s)}>{LABEL[s.suggestion]}</button>
                  )}
                </td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-zinc-500">Nothing stale. 🎉</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">Automatic price drops (e.g. 5% every 7 days after 21 days) can be turned on in Settings.</p>
    </div>
  );
}

function TrafficCard({ onDone }: { onDone: () => void }) {
  const { data, reload } = useFetch<{ listings: number; last: string | null; ebayLive: boolean }>("/api/traffic/summary");
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
      <div>
        <div className="font-medium">📊 eBay traffic <span className="text-xs text-zinc-500">({data?.listings ?? 0} listings{data?.last ? `, updated ${data.last.slice(0, 10)}` : ""})</span></div>
        <div className="text-xs text-zinc-400">Shows <i>why</i> a listing isn't selling: not seen, seen but not clicked, or clicked but not bought. {data?.ebayLive ? "Pulled from eBay twice a day." : "Import Seller Hub, Performance, Traffic, Download report, or connect eBay for automatic updates."}</div>
      </div>
      <div className="flex gap-2">
        <input ref={file} type="file" accept=".csv" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const fd = new FormData();
          fd.append("file", f);
          try {
            const r = await api.post<{ total: number; matched: number }>("/api/traffic/import", fd);
            toast(`Imported ${r.total} listings (${r.matched} matched)`);
            reload();
            onDone();
          } catch (x) {
            toast((x as Error).message, "err");
          }
          e.target.value = "";
        }} />
        <button className="btn-ghost" onClick={() => file.current?.click()}>⬆ Import traffic CSV</button>
        {data?.ebayLive && <button className="btn-ghost" onClick={async () => { const r = await api.post<{ updated: number }>("/api/traffic/sync"); toast(`Updated ${r.updated} listings`); reload(); onDone(); }}>↻ Sync now</button>}
      </div>
    </div>
  );
}
