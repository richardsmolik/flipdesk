import { useState } from "react";
import { Link } from "react-router-dom";
import { useFetch } from "../ui";
import ImportInventory from "../components/ImportInventory";
import ImportSales from "../components/ImportSales";

/** Moving from another tool: inventory + photos, sold history, then connect marketplaces. */
type Source = "vendoo" | "listperfectly" | "ebay" | "sheet";

const TIPS: Record<Source, { name: string; inventory: string; sold: string; note?: string }> = {
  vendoo: {
    name: "Vendoo",
    inventory: "In Vendoo, open your inventory, select all items and look for Export / Download CSV.",
    sold: "Filter to Sold items and export them the same way.",
    note: "Menus change from time to time. Look for Export or Download. If photo links aren't in the file, add photos later with Bulk upload or your phone.",
  },
  listperfectly: {
    name: "List Perfectly",
    inventory: "In List Perfectly, open your catalog/inventory and look for the Export (CSV) option.",
    sold: "Export your sold items (or sales report) as CSV too.",
    note: "Menus change from time to time. Look for Export or Download.",
  },
  ebay: {
    name: "eBay only",
    inventory: "eBay Seller Hub: Listings, Active, Download report (includes eBay item numbers, so FlipDesk tracks them as live eBay listings).",
    sold: "Seller Hub: Orders, Download report (choose the date range you want).",
  },
  sheet: {
    name: "My own spreadsheet",
    inventory: "Save your sheet as CSV. Helpful headers: Title, Price, Cost, Quantity, SKU, Condition, Bin, Photo URLs.",
    sold: "For past sales: Title, Sold Price, Sold Date, Marketplace (+ Cost, Fees, Date Listed if you have them).",
  },
};

function Step({ n, title, active, complete, children }: { n: number; title: string; active: boolean; complete: boolean; children: React.ReactNode }) {
  return (
    <div className={`card p-4 ${active ? "border-blue-900" : ""} ${!active && !complete ? "opacity-60" : ""}`}>
      <div className="mb-2 flex items-center gap-3">
        <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${complete ? "bg-green-900 text-green-200" : active ? "bg-brand text-white" : "bg-zinc-800 text-zinc-400"}`}>{complete ? "✓" : n}</span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      <div className="pl-10 text-sm">{children}</div>
    </div>
  );
}

export default function Switch() {
  const [source, setSource] = useState<Source | null>(null);
  const [modal, setModal] = useState<null | "inv" | "sold">(null);
  const [done, setDone] = useState<{ inv: boolean; sold: boolean }>({ inv: false, sold: false });
  const { data: counts, reload } = useFetch<{ inventory: number; selling: number; drafts: number; sold: number }>("/api/items-counts");
  const t = source ? TIPS[source] : null;
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Switch to FlipDesk</h1>
        <p className="text-sm text-zinc-400">Bring your inventory, photos and sales history over in a few minutes. Nothing changes on your other tool or your marketplaces.</p>
      </div>

      <Step n={1} title="Where are you coming from?" active={!source} complete={!!source}>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(TIPS) as Source[]).map((s) => (
            <button key={s} className={`btn-ghost ${source === s ? "border-brand" : ""}`} onClick={() => setSource(s)}>{TIPS[s].name}</button>
          ))}
        </div>
      </Step>

      <Step n={2} title="Inventory and photos" active={!!source && !done.inv} complete={done.inv}>
        {t && (
          <div className="space-y-2">
            <p className="text-zinc-300">{t.inventory}</p>
            {t.note && <p className="text-xs text-zinc-500">{t.note}</p>}
            <button className="btn-primary" onClick={() => setModal("inv")}>⬆ Import inventory file</button>
            {done.inv && <button className="ml-2 text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setModal("inv")}>Import another file</button>}
          </div>
        )}
      </Step>

      <Step n={3} title="Sold history (for reports and price advice)" active={!!source && done.inv && !done.sold} complete={done.sold}>
        {t && (
          <div className="space-y-2">
            <p className="text-zinc-300">{t.sold}</p>
            <div className="flex items-center gap-3">
              <button className="btn-primary" disabled={!source} onClick={() => setModal("sold")}>⬆ Import sold history</button>
              {!done.sold && <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setDone({ ...done, sold: true })}>Skip</button>}
            </div>
          </div>
        )}
      </Step>

      <Step n={4} title="Connect your marketplaces" active={done.inv && done.sold} complete={false}>
        <p className="mb-2 text-zinc-300">Connect eBay (guided checklist) and install the Chrome extension for Poshmark, Mercari, Depop and the rest.</p>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-primary" to="/connections">🔌 Marketplaces</Link>
          <Link className="btn-ghost" to="/inventory?view=drafts">Review imported drafts</Link>
        </div>
      </Step>

      {counts && (done.inv || done.sold) && (
        <div className="card grid grid-cols-4 gap-3 p-4 text-center text-sm">
          <div><div className="text-2xl font-semibold tabular-nums">{counts.inventory}</div><div className="text-xs text-zinc-500">in stock</div></div>
          <div><div className="text-2xl font-semibold tabular-nums">{counts.selling}</div><div className="text-xs text-zinc-500">live listings</div></div>
          <div><div className="text-2xl font-semibold tabular-nums">{counts.drafts}</div><div className="text-xs text-zinc-500">drafts to list</div></div>
          <div><div className="text-2xl font-semibold tabular-nums">{counts.sold}</div><div className="text-xs text-zinc-500">items with sales</div></div>
        </div>
      )}

      <ImportInventory open={modal === "inv"} onClose={() => setModal(null)} onDone={() => (setModal(null), setDone((d) => ({ ...d, inv: true })), reload())} />
      <ImportSales open={modal === "sold"} onClose={() => setModal(null)} onDone={() => (setModal(null), setDone((d) => ({ ...d, sold: true })), reload())} />
    </div>
  );
}
