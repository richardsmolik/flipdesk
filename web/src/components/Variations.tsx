import { useEffect, useState } from "react";
import { api, money, type Item } from "../api";
import { QtyBar, toast } from "../ui";

interface Row {
  id?: number;
  attrs: Record<string, string>;
  quantity: number;
  quantity_purchased: number;
  quantity_sold: number;
  price: number | null;
}

const PRESETS: Record<string, string> = {
  "Clothing S-XL": "S, M, L, XL",
  "Clothing XS-XXL": "XS, S, M, L, XL, XXL",
  "Shoes 7-12": "7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 12",
  "Waist 28-38": "28, 30, 32, 34, 36, 38",
};

export default function VariationsCard({ item, onSaved }: { item: Item; onSaved: (i: Item) => void }) {
  const fromItem = () =>
    item.variations.map((v) => ({ id: v.id, attrs: { ...v.attrs }, quantity: v.quantity, quantity_purchased: v.quantity_purchased, quantity_sold: v.quantity_sold, price: v.price }));
  const [rows, setRows] = useState<Row[]>(fromItem);
  const [dims, setDims] = useState<string[]>(() => {
    const d = [...new Set(item.variations.flatMap((v) => Object.keys(v.attrs)))];
    return d.length ? d : ["Size"];
  });
  const [quick, setQuick] = useState("");
  const [open, setOpen] = useState(item.variations.length > 0);
  useEffect(() => setRows(fromItem()), [item]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(rows) !== JSON.stringify(fromItem());
  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addValues = (csv: string) => {
    const vals = csv.split(",").map((s) => s.trim()).filter(Boolean);
    setRows((r) => [...r, ...vals.map((v) => ({ attrs: { [dims[0]]: v }, quantity: 1, quantity_purchased: 1, quantity_sold: 0, price: null }))]);
    setQuick("");
  };

  const save = async () => {
    try {
      const saved = await api.put<Item>(`/api/items/${item.id}/variations`, {
        variations: rows.map((r) => ({ id: r.id, attrs: Object.fromEntries(dims.map((d) => [d, r.attrs[d] ?? ""])), quantity: r.quantity, quantity_purchased: r.quantity_purchased, price: r.price })),
      });
      toast("Variations saved - quantities synced to live listings");
      onSaved(saved);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  if (!open) {
    return (
      <button className="btn-ghost w-full" onClick={() => setOpen(true)}>
        👕 This item comes in sizes / colors
      </button>
    );
  }

  const totals = rows.reduce((a, r) => ({ p: a.p + r.quantity_purchased, s: a.s + r.quantity_sold, l: a.l + r.quantity }), { p: 0, s: 0, l: 0 });

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Variations</div>
        <div className="flex gap-1">
          {dims.map((d) => (
            <span key={d} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">{d}</span>
          ))}
          {!dims.includes("Color") && (
            <button className="rounded border border-dashed border-zinc-700 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-100" onClick={() => setDims([...dims, "Color"])}>
              + Color
            </button>
          )}
        </div>
      </div>
      {rows.length > 0 && <QtyBar purchased={totals.p} sold={totals.s} left={totals.l} />}
      <div className="space-y-1.5">
        <div className="grid gap-1 text-[10px] uppercase tracking-wide text-zinc-500" style={{ gridTemplateColumns: `repeat(${dims.length}, minmax(0,1fr)) 52px 40px 52px 64px 20px` }}>
          {dims.map((d) => <span key={d}>{d}</span>)}
          <span>Bought</span><span>Sold</span><span>Left</span><span>Price</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={r.id ?? `n${i}`} className="grid items-center gap-1" style={{ gridTemplateColumns: `repeat(${dims.length}, minmax(0,1fr)) 52px 40px 52px 64px 20px` }}>
            {dims.map((d) => (
              <input key={d} className="input px-2 py-1" value={r.attrs[d] ?? ""} onChange={(e) => update(i, { attrs: { ...r.attrs, [d]: e.target.value } })} aria-label={d} />
            ))}
            <input className="input px-2 py-1" type="number" min={0} value={r.quantity_purchased} onChange={(e) => update(i, { quantity_purchased: Number(e.target.value) })} aria-label="Bought" />
            <span className="text-center text-xs tabular-nums text-zinc-400">{r.quantity_sold}</span>
            <input className={`input px-2 py-1 ${r.quantity === 0 ? "text-zinc-500" : ""}`} type="number" min={0} value={r.quantity} onChange={(e) => update(i, { quantity: Number(e.target.value) })} aria-label="Left" />
            <input className="input px-2 py-1" type="number" step="0.01" placeholder={money(item.price).replace("$", "")} value={r.price ?? ""} onChange={(e) => update(i, { price: e.target.value === "" ? null : Number(e.target.value) })} aria-label="Price override" />
            <button className="text-zinc-600 hover:text-red-400 disabled:opacity-30" disabled={r.quantity_sold > 0} title={r.quantity_sold > 0 ? "Has sales - set Left to 0 instead" : "Remove"} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        <input className="input py-1" placeholder={`Add ${dims[0].toLowerCase()}s: S, M, L`} value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === "Enter" && quick && addValues(quick)} />
        <button className="btn-ghost py-1" disabled={!quick} onClick={() => addValues(quick)}>Add</button>
      </div>
      <div className="flex flex-wrap gap-1">
        {Object.entries(PRESETS).map(([label, csv]) => (
          <button key={label} className="rounded-full border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-100" onClick={() => addValues(csv)}>
            + {label}
          </button>
        ))}
      </div>
      <button className="btn-primary w-full" disabled={!dirty} onClick={save}>Save variations</button>
      <p className="text-[11px] text-zinc-500">eBay and Shopify get one listing with every option. Other sites get one listing per option, and an option that sells out comes down everywhere automatically.</p>
    </div>
  );
}
