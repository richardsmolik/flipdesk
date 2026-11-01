import { useState } from "react";
import { Link } from "react-router-dom";
import { api, money } from "../api";
import { MpBadge, Stat, toast, useFetch, useMarketplaces } from "../ui";

interface Sale {
  id: number; item_id: number; sku: string; title: string; marketplace: string; quantity: number; sale_price: number;
  shipping_charged: number; shipping_cost: number; fees: number; cost: number; profit: number; sold_at: string; photo: string | null;
}
interface Expense { id: number; date: string; category: string; amount: number; note: string }

export default function Sales() {
  const [days, setDays] = useState(30);
  const { data: sales } = useFetch<Sale[]>(`/api/sales?days=${days}`);
  const { data: expenses, reload: reloadExp } = useFetch<Expense[]>("/api/expenses");
  const { byId } = useMarketplaces();
  const [exp, setExp] = useState({ category: "supplies", amount: "", note: "" });
  const s = sales ?? [];
  const sum = (f: (x: Sale) => number) => s.reduce((a, x) => a + f(x), 0);
  const year = new Date().getFullYear();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Sales & profit</h1>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <a className="btn-ghost" href={`/api/export/sales.csv?year=${year}`}>⬇ Sales CSV {year}</a>
          <a className="btn-ghost" href={`/api/export/expenses.csv?year=${year}`}>⬇ Expenses CSV</a>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Units sold" value={sum((x) => x.quantity)} sub={`${s.length} orders`} />
        <Stat label="Gross" value={money(sum((x) => x.sale_price + x.shipping_charged))} />
        <Stat label="Fees" value={money(sum((x) => x.fees))} />
        <Stat label="Shipping + COGS" value={money(sum((x) => x.shipping_cost + x.cost))} />
        <Stat label="Profit" value={money(sum((x) => x.profit))} sub={s.length ? `avg ${money(sum((x) => x.profit) / s.length)}/order` : undefined} />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <tr><th className="p-3 font-medium">Item</th><th className="p-3 font-medium">Where</th><th className="p-3 text-right font-medium">Qty</th><th className="p-3 text-right font-medium">Sale</th><th className="p-3 text-right font-medium">Fees</th><th className="p-3 text-right font-medium">Ship</th><th className="p-3 text-right font-medium">COGS</th><th className="p-3 text-right font-medium">Profit</th><th className="p-3 font-medium">Date</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {s.map((x) => (
              <tr key={x.id}>
                <td className="p-3"><Link to={`/items/${x.item_id}`} className="flex items-center gap-2 hover:underline">{x.photo && <img src={x.photo} alt="" className="h-8 w-8 rounded object-cover" />}<span className="max-w-xs truncate">{x.title}</span></Link></td>
                <td className="p-3"><MpBadge id={x.marketplace} mp={byId[x.marketplace]} /></td>
                <td className="p-3 text-right">{x.quantity}</td>
                <td className="p-3 text-right">{money(x.sale_price + x.shipping_charged)}</td>
                <td className="p-3 text-right text-zinc-400">{money(x.fees)}</td>
                <td className="p-3 text-right text-zinc-400">{money(x.shipping_cost)}</td>
                <td className="p-3 text-right text-zinc-400">{money(x.cost)}</td>
                <td className={`p-3 text-right font-medium ${x.profit < 0 ? "text-red-400" : "text-zinc-100"}`}>{money(x.profit)}</td>
                <td className="p-3 text-xs text-zinc-500">{x.sold_at.slice(0, 10)}</td>
              </tr>
            ))}
            {!s.length && <tr><td colSpan={9} className="p-8 text-center text-zinc-500">No sales in this period.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Business expenses (for taxes)</h2>
        <form className="mb-3 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); await api.post("/api/expenses", { ...exp, amount: Number(exp.amount) }); setExp({ ...exp, amount: "", note: "" }); reloadExp(); toast("Expense added"); }}>
          <select className="input w-36" value={exp.category} onChange={(e) => setExp({ ...exp, category: e.target.value })}>
            {["supplies", "shipping", "mileage", "fees", "subscriptions", "other"].map((c) => <option key={c}>{c}</option>)}
          </select>
          <input className="input w-28" type="number" step="0.01" placeholder="Amount" required value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} />
          <input className="input flex-1" placeholder="Note" value={exp.note} onChange={(e) => setExp({ ...exp, note: e.target.value })} />
          <button className="btn-ghost">Add</button>
        </form>
        <ul className="divide-y divide-zinc-800 text-sm">
          {expenses?.map((x) => (
            <li key={x.id} className="flex items-center justify-between py-1.5">
              <span className="text-zinc-300">{x.date} · {x.category} · {x.note}</span>
              <span className="flex items-center gap-3 tabular-nums">{money(x.amount)}<button className="text-xs text-zinc-600 hover:text-red-400" onClick={async () => (await api.del(`/api/expenses/${x.id}`), reloadExp())}>✕</button></span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
