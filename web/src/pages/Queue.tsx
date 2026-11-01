import { Link } from "react-router-dom";
import { api } from "../api";
import { MpBadge, timeAgo, toast, useFetch, useMarketplaces } from "../ui";

interface Job { id: number; marketplace: string; type: string; item_id: number; sku: string; title: string; status: string; attempts: number; result: string | null; updated_at: string }

export default function Queue() {
  const { data, reload } = useFetch<Job[]>("/api/jobs");
  const { byId } = useMarketplaces();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sync queue</h1>
          <p className="text-sm text-zinc-400">Publish, delist and quantity/price updates. API sites run automatically; Poshmark, Mercari, Depop, Vinted, Grailed, Facebook and Whatnot run through the Chrome extension. Delists always go first.</p>
        </div>
        <button className="btn-ghost" onClick={async () => { const r = await api.post<{ processed: number }>("/api/jobs/process"); toast(`Processed ${r.processed}`); reload(); }}>Run now</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500"><tr><th className="p-3 font-medium">Job</th><th className="p-3 font-medium">Site</th><th className="p-3 font-medium">Item</th><th className="p-3 font-medium">Status</th><th className="p-3 font-medium">Updated</th><th /></tr></thead>
          <tbody className="divide-y divide-zinc-800/70">
            {data?.map((j) => {
              const res = j.result ? (JSON.parse(j.result) as { error?: string }) : null;
              return (
                <tr key={j.id}>
                  <td className="p-3 capitalize">{j.type}</td>
                  <td className="p-3"><MpBadge id={j.marketplace} mp={byId[j.marketplace]} /></td>
                  <td className="p-3"><Link to={`/items/${j.item_id}`} className="hover:underline">{j.sku}</Link> <span className="text-zinc-500">{j.title.slice(0, 40)}</span></td>
                  <td className="p-3">
                    <span className={j.status === "done" ? "text-green-400" : j.status === "failed" ? "text-red-400" : "text-amber-300"}>{j.status === "done" ? "✓ done" : j.status === "failed" ? "✕ failed" : j.status === "claimed" ? "⟳ in progress" : "… pending"}</span>
                    {res?.error && <div className="max-w-sm truncate text-xs text-red-300" title={res.error}>{res.error}</div>}
                  </td>
                  <td className="p-3 text-xs text-zinc-500">{timeAgo(j.updated_at)}</td>
                  <td className="p-3">{j.status === "failed" && <button className="text-xs text-brand hover:underline" onClick={async () => (await api.post(`/api/jobs/${j.id}/retry`), reload())}>retry</button>}</td>
                </tr>
              );
            })}
            {data?.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-zinc-500">Queue is empty.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
