import { useRef, useState } from "react";
import { api } from "../api";
import { toast, useFetch } from "../ui";

interface Lib { total: number; batches: { batch: string; source: string; rows: number; units: number; imported_at: string }[] }

export default function SoldDataCard() {
  const { data, reload } = useFetch<Lib>("/api/comps");
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("source", /terapeak/i.test(f.name) ? "terapeak" : "csv");
      const r = await api.post<{ imported: number; skipped: number; columns: string[] }>("/api/comps/import", fd);
      toast(`Imported ${r.imported} sold comps${r.skipped ? ` (${r.skipped} rows skipped)` : ""}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">📥 Sold-data library <span className="text-xs text-zinc-500">({data?.total ?? 0} sold comps)</span></div>
          <div className="text-xs text-zinc-400">
            Import Terapeak exports (eBay Seller Hub, Research tab, then Export) or any sold-listings CSV. Real sold prices then drive every price suggestion, plus sourcing mode.
          </div>
        </div>
        <input ref={file} type="file" accept=".csv,text/csv,.tsv,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="btn-primary" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Importing…" : "Import CSV"}</button>
      </div>
      {!!data?.batches.length && (
        <ul className="divide-y divide-zinc-800 text-sm">
          {data.batches.map((b) => (
            <li key={b.batch} className="flex items-center justify-between py-1.5">
              <span className="text-zinc-300">{b.batch} <span className="text-xs text-zinc-500">· {b.source} · {b.rows} rows · {b.units} units</span></span>
              <button className="text-xs text-zinc-600 hover:text-red-400" onClick={async () => (await api.del(`/api/comps/batch?batch=${encodeURIComponent(b.batch)}`), reload())}>remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
