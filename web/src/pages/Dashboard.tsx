import { useState } from "react";
import { Link } from "react-router-dom";
import { money } from "../api";
import { MpBadge, Stat, timeAgo, useFetch, useMarketplaces } from "../ui";
import { GetStarted } from "../components/Onboarding";
import { GoalsCard, TodayCard } from "../components/Today";
import { AnnouncementBar } from "../components/Announcements";
import { useEffect as useEffect_, useReducer } from "react";

interface Dash {
  inventory: { active: number; draft: number; value: number; costBasis: number; units: number };
  last30: { revenue: number; profit: number; sales: number; fees: number };
  prev30: { revenue: number; profit: number; sales: number };
  ytd: { revenue: number; profit: number; sales: number; fees: number; expenses: number; netAfterExpenses: number };
  avgDaysToSell: number | null;
  sellThroughPct: number;
  byMarketplace: { marketplace: string; sales: number; revenue: number; profit: number; fees: number }[];
  daily: { day: string; revenue: number; profit: number; sales: number }[];
  queue: { pending: number; failed: number };
  staleCount: number;
  alerts: { id: number; kind: string; severity: string; title: string; item_id: number | null }[];
  alertCount: number;
  recent: { id: number; at: string; kind: string; message: string; item_id: number | null }[];
}

const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : null);

/** Single-series bar chart (daily profit). Hover a day for its numbers; table view available. */
function ProfitChart({ data }: { data: Dash["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 720, H = 180, PAD_L = 44, PAD_B = 22;
  const max = Math.max(10, ...data.map((d) => d.profit));
  const min = Math.min(0, ...data.map((d) => d.profit));
  const y = (v: number) => ((max - v) / (max - min)) * (H - PAD_B - 8) + 8;
  const bw = (W - PAD_L) / data.length;
  const ticks = [0, max / 2, max].map((t) => Math.round(t));
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Daily profit - last 30 days</h2>
        <button className="text-xs text-zinc-400 underline-offset-2 hover:underline" onClick={() => setTable(!table)}>
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-48 overflow-auto text-xs">
          <table className="w-full tabular-nums">
            <thead className="text-zinc-500"><tr><th className="text-left">Day</th><th className="text-right">Sales</th><th className="text-right">Revenue</th><th className="text-right">Profit</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.day} className="text-zinc-300"><td>{d.day}</td><td className="text-right">{d.sales}</td><td className="text-right">{money(d.revenue)}</td><td className="text-right">{money(d.profit)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Daily profit bar chart" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD_L} x2={W} y1={y(t)} y2={y(t)} stroke="#27272a" strokeWidth={1} />
                <text x={PAD_L - 6} y={y(t)} fill="#71717a" fontSize={10} textAnchor="end" dominantBaseline="middle">${t}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const top = y(Math.max(0, d.profit));
              const bh = Math.max(d.profit !== 0 ? 2 : 0, Math.abs(y(0) - y(d.profit)));
              return (
                <g key={d.day} onMouseEnter={() => setHover(i)}>
                  <rect x={PAD_L + i * bw} y={0} width={bw} height={H} fill="transparent" />
                  <rect x={PAD_L + i * bw + 1} y={d.profit >= 0 ? top : y(0)} width={Math.max(1, bw - 2)} height={bh} rx={Math.min(4, bw / 3)} fill={d.profit < 0 ? "#d03b3b" : "#3987e5"} opacity={hover === null || hover === i ? 1 : 0.45} />
                </g>
              );
            })}
            {data.filter((_, i) => i % 7 === 0).map((d) => {
              const i = data.indexOf(d);
              return <text key={d.day} x={PAD_L + i * bw + bw / 2} y={H - 6} fill="#71717a" fontSize={10} textAnchor="middle">{d.day.slice(5)}</text>;
            })}
          </svg>
          {h && (
            <div className="pointer-events-none absolute top-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs shadow" style={{ left: `${Math.min(80, ((PAD_L + hover! * bw) / W) * 100)}%` }}>
              <div className="font-medium text-zinc-100">{h.day}</div>
              <div className="text-zinc-400">{h.sales} sale{h.sales === 1 ? "" : "s"} · {money(h.revenue)} revenue</div>
              <div className="text-zinc-200">Profit {money(h.profit)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { data: d } = useFetch<Dash>("/api/dashboard");
  const [gsKey, bump] = useReducer((x: number) => x + 1, 0);
  useEffect_(() => {
    window.addEventListener("fd-onboarding-changed", bump);
    return () => window.removeEventListener("fd-onboarding-changed", bump);
  }, []);
  const { byId } = useMarketplaces();
  if (!d) return <div className="text-zinc-500">Loading…</div>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex gap-2">
          <Link to="/items/new" className="btn-primary">✨ New AI listing</Link>
          <Link to="/inventory" className="btn-ghost">Inventory</Link>
          <Link to="/switch" className="btn-ghost">Coming from Vendoo / List Perfectly?</Link>
        </div>
      </div>

      <AnnouncementBar />

      <GetStarted key={gsKey} onWelcome={() => window.dispatchEvent(new Event("fd-open-welcome"))} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><TodayCard /></div>
        <GoalsCard />
      </div>

      {d.alerts.filter((a) => a.severity === "critical").map((a) => (
        <Link key={a.id} to="/inbox" className="block rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-100 hover:bg-red-950">
          🚨 <b>{a.title}</b> - open the Inbox for a ready-to-send buyer message
        </Link>
      ))}
      {d.alertCount > d.alerts.filter((a) => a.severity === "critical").length && (
        <Link to="/inbox" className="inline-block rounded-md border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-sm text-amber-200">🔔 {d.alertCount} item(s) in your Inbox</Link>
      )}
      {(d.queue.failed > 0 || d.staleCount > 0 || d.queue.pending > 0) && (
        <div className="flex flex-wrap gap-2 text-sm">
          {d.queue.failed > 0 && <Link to="/queue" className="rounded-md border border-red-900 bg-red-950/60 px-3 py-1.5 text-red-200">⚠ {d.queue.failed} sync job(s) failed - review</Link>}
          {d.queue.pending > 0 && <Link to="/queue" className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-amber-200">🔄 {d.queue.pending} waiting for the extension / API</Link>}
          {d.staleCount > 0 && <Link to="/tools" className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-zinc-200">🐢 {d.staleCount} listing(s) stale 30+ days - get suggestions</Link>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Revenue (30d)" value={money(d.last30.revenue)} delta={pct(d.last30.revenue, d.prev30.revenue)} sub="vs prior 30d" />
        <Stat label="Profit (30d)" value={money(d.last30.profit)} delta={pct(d.last30.profit, d.prev30.profit)} sub={`${d.last30.sales} sales`} />
        <Stat label="Sell-through (30d)" value={`${d.sellThroughPct}%`} sub={d.avgDaysToSell !== null ? `avg ${d.avgDaysToSell} days to sell` : undefined} />
        <Stat label="Inventory value" value={money(d.inventory.value)} sub={`${d.inventory.units} units · cost ${money(d.inventory.costBasis)}`} />
        <Stat label="Profit YTD" value={money(d.ytd.netAfterExpenses)} sub={`after ${money(d.ytd.expenses)} expenses`} />
      </div>

      <ProfitChart data={d.daily} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-200">Where you make money (90d)</h2>
          {d.byMarketplace.length === 0 ? (
            <p className="text-sm text-zinc-500">No sales yet.</p>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead className="text-xs text-zinc-500"><tr><th className="pb-2 text-left font-medium">Marketplace</th><th className="text-right font-medium">Sales</th><th className="text-right font-medium">Revenue</th><th className="text-right font-medium">Fees</th><th className="text-right font-medium">Profit</th></tr></thead>
              <tbody className="divide-y divide-zinc-800">
                {d.byMarketplace.map((m) => (
                  <tr key={m.marketplace}>
                    <td className="py-2"><MpBadge id={m.marketplace} mp={byId[m.marketplace]} /></td>
                    <td className="text-right text-zinc-300">{m.sales}</td>
                    <td className="text-right text-zinc-300">{money(m.revenue)}</td>
                    <td className="text-right text-zinc-500">{money(m.fees)}</td>
                    <td className="text-right font-medium text-zinc-100">{money(m.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-200">Activity</h2>
          <ul className="space-y-2 text-sm">
            {d.recent.map((a) => (
              <li key={a.id} className="flex gap-3">
                <span className="w-16 shrink-0 text-xs text-zinc-500">{timeAgo(a.at)}</span>
                <span className={a.kind === "sale" ? "text-green-300" : a.kind === "error" || a.kind === "alert" ? "text-red-300" : "text-zinc-300"}>
                  {a.item_id ? <Link to={`/items/${a.item_id}`} className="hover:underline">{a.message}</Link> : a.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
