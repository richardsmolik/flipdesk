import { useRef, useState } from "react";
import { api, money } from "../api";
import { Modal, MpBadge, toast, useMarketplaces } from "../ui";

interface Preview {
  columns: Record<string, string>;
  total: number;
  ready: number;
  problemCount: number;
  problems: { line: number; reason: string }[];
  duplicates: number;
  byMarketplace: Record<string, number>;
  from: string | null;
  to: string | null;
  revenue: number;
  warnings: string[];
}

/** Bring in past sales so Reports, insights and price advice work from day one. */
export default function ImportSales({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { marketplaces, byId } = useMarketplaces();
  const [file, setFile] = useState<File | null>(null);
  const [mp, setMp] = useState("");
  const [p, setP] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reset = () => (setFile(null), setP(null));
  const form = (f: File, m: string) => {
    const fd = new FormData();
    fd.append("file", f);
    if (m) fd.append("marketplace", m);
    return fd;
  };
  const preview = async (f: File, m = mp) => {
    setFile(f);
    try {
      setP(await api.post<Preview>("/api/import/sales/preview", form(f, m)));
    } catch (e) {
      toast((e as Error).message, "err");
      reset();
    }
  };
  return (
    <Modal open={open} onClose={() => (reset(), onClose())} title="Import sold history">
      <div className="space-y-3 text-sm">
        {!p ? (
          <>
            <p className="text-zinc-400">Export your <b className="text-zinc-200">sold items</b> from Vendoo, List Perfectly, eBay (Seller Hub, Orders, Download report) or your own sheet as CSV. Reports, "best source", returns and price advice then work from day one.</p>
            <p className="text-xs text-zinc-500">History only: nothing gets delisted, no notifications, and these orders won't show up in Shipping.</p>
            <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && preview(e.target.files[0])} />
            <button className="btn-primary w-full" onClick={() => input.current?.click()}>Choose CSV file</button>
          </>
        ) : (
          <>
            <div className="text-zinc-300"><b>{p.ready}</b> sales ready{p.from && ` · ${p.from.slice(0, 10)} to ${p.to?.slice(0, 10)}`} · {money(p.revenue)} revenue</div>
            <div className="flex flex-wrap gap-1">{Object.entries(p.byMarketplace).map(([m, n]) => <span key={m} className="flex items-center gap-1 text-xs"><MpBadge id={m} mp={byId[m]} small /> {n}</span>)}</div>
            <div className="flex flex-wrap gap-1">{Object.entries(p.columns).map(([f, col]) => <span key={f} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]"><span className="text-zinc-500">{f}</span> ← {col}</span>)}</div>
            {!p.columns.marketplace && (
              <label className="flex items-center gap-2 text-xs">These sales came from
                <select className="input w-auto py-1" value={mp} onChange={(e) => { setMp(e.target.value); if (file) preview(file, e.target.value); }}>
                  <option value="">Choose…</option>
                  {marketplaces.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            )}
            {p.warnings.map((w) => <div key={w} className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-xs text-amber-200">{w}</div>)}
            {p.problemCount > 0 && (
              <details className="text-xs text-zinc-400"><summary className="cursor-pointer">{p.problemCount} row(s) will be skipped</summary>
                <ul className="mt-1 max-h-24 overflow-auto">{p.problems.map((x) => <li key={x.line}>Line {x.line}: {x.reason}</li>)}</ul>
              </details>
            )}
            <div className="flex gap-2">
              <button
                className="btn-primary flex-1"
                disabled={busy || p.ready <= 0}
                onClick={async () => {
                  if (!file) return;
                  setBusy(true);
                  try {
                    const r = await api.post<{ imported: number; attached: number }>("/api/import/sales", form(file, mp));
                    toast(`Imported ${r.imported} past sales${r.attached ? ` (${r.attached} matched existing items)` : ""}`);
                    reset();
                    onDone();
                  } catch (e) {
                    toast((e as Error).message, "err");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Importing…" : `Import ${p.ready} sales`}
              </button>
              <button className="btn-ghost" onClick={reset}>Other file</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
