import { useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api";
import { MpBadge, toast, useFetch, useMarketplaces } from "../ui";
import SoldDataCard from "../components/SoldData";

interface Stale {
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
                <td className="p-3 text-xs text-zinc-300">{s.why}</td>
                <td className="p-3"><button className="btn-ghost whitespace-nowrap text-xs" onClick={() => act(s)}>{LABEL[s.suggestion]}</button></td>
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
