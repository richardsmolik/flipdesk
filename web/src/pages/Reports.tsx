import { useState } from "react";
import { money } from "../api";
import { MpBadge, useFetch, useMarketplaces } from "../ui";
import Backtest from "../components/Backtest";
import AiInsights from "../components/AiInsights";

interface G { mileageCost?: number; profitAfterMileage?: number; key: string; unitsBought: number; unitsSold: number; revenue: number; profit: number; cogs: number; roiPct: number | null; sellThroughPct: number | null; avgDaysToSell: number | null; avgProfit: number | null }
interface R {
  bySource: G[]; byBrand: G[]; byCategory: G[];
  byMarketplace: { key: string; units: number; revenue: number; profit: number; feePct: number; avgDaysToSell: number | null }[];
  byMonth: { month: string; units: number; revenue: number; profit: number }[];
  aging: { bucket: string; items: number; units: number; cost: number; value: number }[];
  perHour: number | null; minutesPerItem: number;
  insights: { kind: "good" | "bad" | "info"; text: string }[];
  returns: {
    byMarketplace: { marketplace: string; sold: number; returned: number; ratePct: number; cost: number }[];
    byCategory: { category: string; returned: number; cost: number }[];
    reasons: { reason: string; n: number }[];
    totals: { returned: number; cancels: number; notRestocked: number; cost: number; ratePct: number };
  };
}

function GroupTable({ title, rows }: { title: string; rows: G[] }) {
  return (
    <div className="card overflow-x-auto p-4">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-zinc-500">
          <tr><th className="pb-2 text-left font-medium">Name</th><th className="text-right font-medium">Sold / bought</th><th className="text-right font-medium">Profit</th><th className="text-right font-medium">Avg profit</th><th className="text-right font-medium">Return on cost</th><th className="text-right font-medium">Days to sell</th></tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.slice(0, 12).map((r) => (
            <tr key={r.key}>
              <td className="max-w-[180px] truncate py-1.5 text-zinc-200">{r.key}</td>
              <td className="text-right text-zinc-400">{r.unitsSold} / {r.unitsBought}{r.sellThroughPct !== null && <span className="ml-1 text-[11px] text-zinc-500">({r.sellThroughPct}%)</span>}</td>
              <td className={`text-right font-medium ${r.profit < 0 ? "text-red-400" : "text-zinc-100"}`}>
                {money(r.profit)}
                {r.mileageCost ? <div className="text-[10px] font-normal text-zinc-500" title={`Minus ${money(r.mileageCost)} of mileage`}>{money(r.profitAfterMileage)} after gas</div> : null}
              </td>
              <td className="text-right text-zinc-300">{money(r.avgProfit)}</td>
              <td className="text-right text-zinc-300">{r.roiPct !== null ? `${r.roiPct}%` : "-"}</td>
              <td className="text-right text-zinc-400">{r.avgDaysToSell ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Reports() {
  const [days, setDays] = useState(365);
  const { data: r } = useFetch<R>(`/api/reports?days=${days}`);
  const { byId } = useMarketplaces();
  if (!r) return <div className="text-zinc-500">Loading…</div>;
  const maxAging = Math.max(1, ...r.aging.map((a) => a.cost));
  const maxMonth = Math.max(1, ...r.byMonth.map((m) => Math.abs(m.profit)));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-zinc-400">What's actually making you money, and what isn't.</p>
        </div>
        <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 90, 180, 365, 3650].map((d) => <option key={d} value={d}>{d === 3650 ? "All time" : `Last ${d} days`}</option>)}
        </select>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {r.insights.map((i, n) => (
          <div key={n} className={`rounded-lg border px-4 py-3 text-sm ${i.kind === "good" ? "border-green-900 bg-green-950/30 text-green-100" : i.kind === "bad" ? "border-amber-900 bg-amber-950/30 text-amber-100" : "border-zinc-800 bg-zinc-900 text-zinc-200"}`}>
            {i.kind === "good" ? "👍 " : i.kind === "bad" ? "⚠️ " : "💡 "}{i.text}
          </div>
        ))}
        {!r.insights.length && <div className="text-sm text-zinc-500">Record a few more sales (and fill in Source and Brand on items) to unlock insights.</div>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Cash tied up in inventory, by age</h2>
          <div className="space-y-2">
            {r.aging.map((a) => (
              <div key={a.bucket} className="text-sm">
                <div className="mb-0.5 flex justify-between text-xs"><span className="text-zinc-300">{a.bucket}</span><span className="tabular-nums text-zinc-400">{a.units} units · cost {money(a.cost)} · list {money(a.value)}</span></div>
                <div className="h-2 rounded bg-zinc-800"><div className={`h-2 rounded ${a.bucket === "90+ days" ? "bg-critical" : "bg-brand"}`} style={{ width: `${(a.cost / maxAging) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Monthly profit</h2>
          <div className="space-y-1.5">
            {r.byMonth.map((m) => (
              <div key={m.month} className="flex items-center gap-2 text-xs" title={`${m.units} units · ${money(m.revenue)} revenue`}>
                <span className="w-14 text-zinc-500">{m.month}</span>
                <div className="h-2 flex-1 rounded bg-zinc-800"><div className={`h-2 rounded ${m.profit < 0 ? "bg-critical" : "bg-brand"}`} style={{ width: `${(Math.abs(m.profit) / maxMonth) * 100}%` }} /></div>
                <span className="w-20 text-right tabular-nums text-zinc-200">{money(m.profit)}</span>
              </div>
            ))}
            {!r.byMonth.length && <div className="text-sm text-zinc-500">No sales yet.</div>}
          </div>
          {r.perHour !== null && <div className="mt-3 text-xs text-zinc-400">≈ <b className="text-zinc-100">{money(r.perHour)}/hour</b> at {r.minutesPerItem} min per item</div>}
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Returns</h2>
          <span className="text-xs text-zinc-400">{r.returns.totals.returned} returns ({r.returns.totals.ratePct}% of orders) · {r.returns.totals.cancels} cancellations · cost {money(r.returns.totals.cost)}{r.returns.totals.notRestocked ? ` · ${r.returns.totals.notRestocked} not restockable` : ""}</span>
        </div>
        {r.returns.totals.returned === 0 ? (
          <p className="text-sm text-zinc-500">No returns recorded. Use "Return / cancel" on the Sales page when one happens.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <div className="mb-1 text-xs text-zinc-500">Return rate by site</div>
              {r.returns.byMarketplace.filter((m) => m.returned).map((m) => (
                <div key={m.marketplace} className="flex items-center gap-2 py-0.5 text-xs">
                  <span className="w-20 shrink-0"><MpBadge id={m.marketplace} mp={byId[m.marketplace]} small /></span>
                  <div className="h-2 flex-1 rounded bg-zinc-800"><div className={`h-2 rounded ${m.ratePct >= Math.max(5, r.returns.totals.ratePct * 2) ? "bg-critical" : "bg-brand"}`} style={{ width: `${Math.min(100, m.ratePct * 4)}%` }} /></div>
                  <span className="w-12 text-right tabular-nums">{m.ratePct}%</span>
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 text-xs text-zinc-500">By category</div>
              {r.returns.byCategory.map((c) => <div key={c.category} className="flex justify-between py-0.5 text-xs"><span className="capitalize text-zinc-300">{c.category}</span><span className="tabular-nums text-zinc-400">{c.returned} · {money(c.cost)}</span></div>)}
            </div>
            <div>
              <div className="mb-1 text-xs text-zinc-500">Reasons</div>
              {r.returns.reasons.map((x) => <div key={x.reason} className="flex justify-between py-0.5 text-xs"><span className="capitalize text-zinc-300">{x.reason.replace(/_/g, " ")}</span><span className="tabular-nums text-zinc-400">{x.n}</span></div>)}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <GroupTable title="By source (where you buy)" rows={r.bySource} />
        <GroupTable title="By brand" rows={r.byBrand} />
        <GroupTable title="By category" rows={r.byCategory} />
        <div className="card overflow-x-auto p-4">
          <h2 className="mb-2 text-sm font-semibold">By marketplace</h2>
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-zinc-500"><tr><th className="pb-2 text-left font-medium">Site</th><th className="text-right font-medium">Units</th><th className="text-right font-medium">Profit</th><th className="text-right font-medium">Fees</th><th className="text-right font-medium">Days to sell</th></tr></thead>
            <tbody className="divide-y divide-zinc-800">
              {r.byMarketplace.map((m) => (
                <tr key={m.key}><td className="py-1.5"><MpBadge id={m.key} mp={byId[m.key]} /></td><td className="text-right text-zinc-400">{m.units}</td><td className="text-right font-medium">{money(m.profit)}</td><td className="text-right text-zinc-400">{m.feePct}%</td><td className="text-right text-zinc-400">{m.avgDaysToSell ?? "-"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <AiInsights />
      <Backtest />
    </div>
  );
}
