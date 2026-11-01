import { useRef, useState } from "react";
import { api, money } from "../api";
import { Modal, toast } from "../ui";

interface Preview {
  columns: Record<string, string[]>;
  total: number;
  withPhotos: number;
  ebayListings: number;
  duplicates: number;
  problems: number;
  warnings: string[];
  sample: { line: number; title: string; price: number; cost: number; quantity: number; sku: string | null; condition: string; images: string[]; ebayId: string | null }[];
}

/** Import items from Vendoo / List Perfectly / eBay / Excel (CSV): preview first, then import. */
export default function ImportInventory({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [photos, setPhotos] = useState(true);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reset = () => (setFile(null), setPreview(null));

  const pick = async (f: File) => {
    setFile(f);
    const fd = new FormData();
    fd.append("file", f);
    try {
      setPreview(await api.post<Preview>("/api/import/inventory/preview", fd));
    } catch (e) {
      toast((e as Error).message, "err");
      reset();
    }
  };
  const go = async () => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("photos", photos ? "1" : "0");
    try {
      const r = await api.post<{ imported: number; skipped: { line: number; reason: string }[]; photosQueued: number }>("/api/import/inventory", fd);
      toast(`Imported ${r.imported} item(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}${r.photosQueued ? `. Downloading ${r.photosQueued} photos in the background.` : ""}`);
      reset();
      onDone();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => (reset(), onClose())} title="Import inventory from a spreadsheet">
      <div className="space-y-3 text-sm">
        {!preview ? (
          <>
            <p className="text-zinc-400">Works with exports from <b className="text-zinc-200">Vendoo</b>, <b className="text-zinc-200">List Perfectly</b>, <b className="text-zinc-200">eBay</b> (Seller Hub, Listings, Download report) or your own sheet saved as CSV. FlipDesk finds the columns by name: title, price, cost, SKU, quantity, condition, bin, photo links, eBay item number.</p>
            <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
            <button className="btn-primary w-full" onClick={() => input.current?.click()}>Choose CSV file</button>
            <p className="text-[11px] text-zinc-500">Excel or Google Sheets: File, Download / Save as, CSV.</p>
          </>
        ) : (
          <>
            <div className="text-zinc-300"><b>{preview.total}</b> items found{preview.withPhotos ? ` · ${preview.withPhotos} with photo links` : ""}{preview.ebayListings ? ` · ${preview.ebayListings} live on eBay` : ""}</div>
            <div className="flex flex-wrap gap-1">
              {Object.entries(preview.columns).map(([f, cols]) => (
                <span key={f} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]" title={cols.join(", ")}><span className="text-zinc-500">{f}</span> ← {cols[0]}{cols.length > 1 ? ` +${cols.length - 1}` : ""}</span>
              ))}
            </div>
            {preview.warnings.map((w) => <div key={w} className="rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-xs text-amber-200">{w}</div>)}
            <div className="max-h-48 overflow-auto rounded border border-zinc-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900 text-zinc-500"><tr><th className="p-1 text-left">Title</th><th className="p-1 text-right">Price</th><th className="p-1 text-right">Cost</th><th className="p-1 text-right">Qty</th><th className="p-1">📷</th></tr></thead>
                <tbody>
                  {preview.sample.map((r) => (
                    <tr key={r.line} className="border-t border-zinc-800">
                      <td className="max-w-[14rem] truncate p-1">{r.title}{r.ebayId && <span className="ml-1 text-[10px] text-blue-300">eBay</span>}</td>
                      <td className="p-1 text-right tabular-nums">{money(r.price)}</td>
                      <td className="p-1 text-right tabular-nums text-zinc-400">{money(r.cost)}</td>
                      <td className="p-1 text-right">{r.quantity}</td>
                      <td className="p-1 text-center text-zinc-400">{r.images.length || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.withPhotos > 0 && <label className="flex items-center gap-2"><input type="checkbox" checked={photos} onChange={(e) => setPhotos(e.target.checked)} /> Download photos from their links (in the background)</label>}
            {preview.ebayListings > 0 && <p className="text-[11px] text-zinc-500">Rows with an eBay item number are tracked as live eBay listings (sales and delisting work). eBay doesn't let apps edit listings created in Seller Hub, so price changes for those stay manual.</p>}
            <div className="flex gap-2">
              <button className="btn-primary flex-1" disabled={busy || preview.total - preview.duplicates - preview.problems <= 0} onClick={go}>{busy ? "Importing…" : `Import ${preview.total - preview.duplicates - preview.problems} items`}</button>
              <button className="btn-ghost" onClick={reset}>Choose another file</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
