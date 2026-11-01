import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, money, type Item } from "../api";
import { MpBadge, toast, useFetch, useMarketplaces } from "../ui";

interface Suggestion {
  reason: string;
  itemIds: number[];
  items: { id: number; sku: string; title: string; price: number; ageDays: number; photo: string | null }[];
  separatePrice: number;
  bundlePrice: number;
  bundleProfit: number;
  marketplace: string;
  staleCount: number;
}
interface Promo { id: number; name: string; status: string; external_id: string | null; item_ids: string; created_at: string }

export default function Bundles() {
  const [discount, setDiscount] = useState(15);
  const { data: sugg, reload } = useFetch<Suggestion[]>(`/api/bundles/suggestions?discount=${discount}`);
  const { data: promos, reload: reloadPromos } = useFetch<Promo[]>("/api/promotions");
  const { byId } = useMarketplaces();
  const nav = useNavigate();

  const makeLot = async (s: Suggestion) => {
    try {
      const lot = await api.post<Item>("/api/bundles", { parts: s.itemIds.map((itemId) => ({ itemId })), discountPct: discount });
      toast(`Lot ${lot.sku} created - pick sites and crosslist`);
      nav(`/items/${lot.id}`);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const multiBuy = async (s: Suggestion) => {
    try {
      const r = await api.post<{ listings: number; demo: boolean }>("/api/promotions/multibuy", {
        itemIds: s.itemIds,
        tiers: [{ minQuantity: 2, pctOff: Math.round(discount * 0.66) }, { minQuantity: 3, pctOff: discount }],
        name: `${s.reason} - multi-buy`,
      });
      toast(`eBay multi-buy started on ${r.listings} listings${r.demo ? " (demo)" : ""}`);
      reloadPromos();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bundles</h1>
          <p className="max-w-2xl text-sm text-zinc-400">
            Move more per sale and clear slow stock. A <b className="text-zinc-200">lot</b> is one listing made of several items, posted to any site. FlipDesk keeps it in sync both ways: if the lot sells, each item comes down; if an item sells alone, the lot comes down. <b className="text-zinc-200">Multi-buy</b> gives eBay buyers an automatic discount when they buy 2 or more.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          Discount <input className="input w-16" type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />%
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {sugg?.map((s) => (
          <div key={s.itemIds.join(",")} className="card space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{s.reason}</div>
                <div className="text-xs text-zinc-500">{s.items.length} items{s.staleCount ? ` · ${s.staleCount} listed 30+ days` : ""}</div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold tabular-nums">{money(s.bundlePrice)}</div>
                <div className="text-xs text-zinc-500 line-through">{money(s.separatePrice)}</div>
              </div>
            </div>
            <ul className="space-y-1.5">
              {s.items.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-sm">
                  {i.photo ? <img src={i.photo} alt="" className="h-8 w-8 rounded object-cover" /> : <div className="h-8 w-8 rounded bg-zinc-800" />}
                  <Link to={`/items/${i.id}`} className="min-w-0 flex-1 truncate hover:underline">{i.title}</Link>
                  <span className={`text-xs ${i.ageDays >= 30 ? "text-amber-300" : "text-zinc-500"}`}>{i.ageDays}d</span>
                  <span className="w-16 text-right text-xs tabular-nums text-zinc-400">{money(i.price)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Lot profit ≈ <b className="text-zinc-100">{money(s.bundleProfit)}</b> on <MpBadge id={s.marketplace} mp={byId[s.marketplace]} small /></span>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={() => makeLot(s)}>📦 Create lot listing</button>
              <button className="btn-ghost flex-1" onClick={() => multiBuy(s)}>🏷️ eBay multi-buy instead</button>
            </div>
          </div>
        ))}
        {sugg?.length === 0 && (
          <div className="card p-8 text-center text-sm text-zinc-500 lg:col-span-2">
            No natural bundles right now. Fill in brand, category and size on your items to get suggestions.
            <button className="ml-2 text-brand hover:underline" onClick={reload}>Refresh</button>
          </div>
        )}
      </div>

      <p className="text-xs text-zinc-500">Tip: you can also select items in Inventory and choose "Make a lot".</p>

      {!!promos?.length && (
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">eBay multi-buy promotions</h2>
          <ul className="divide-y divide-zinc-800 text-sm">
            {promos.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span>{p.name} <span className="text-xs text-zinc-500">· {JSON.parse(p.item_ids).length} items · {p.status}{p.external_id?.startsWith("DEMO") ? " · demo" : ""}</span></span>
                {p.status === "running" && <button className="text-xs text-zinc-500 hover:text-red-400" onClick={async () => (await api.post(`/api/promotions/${p.id}/end`), reloadPromos())}>End</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
