import { useState } from "react";
import { api, money, type Item } from "../api";
import { toast, useFetch } from "../ui";

interface Cand { itemId: number; sku: string; title: string; score: number; listedThere: boolean }
interface Email {
  id: number;
  received_at: string;
  subject: string;
  marketplace: string;
  note: string | null;
  parsed: { price: number | null; quantity: number; size: string | null; candidates: Cand[]; snippet: string };
}

function Row({ e, onDone }: { e: Email; onDone: () => void }) {
  const [itemId, setItemId] = useState<number | undefined>(e.parsed.candidates[0]?.itemId);
  const [price, setPrice] = useState(e.parsed.price ?? 0);
  const [qty, setQty] = useState(e.parsed.quantity || 1);
  const { data: item } = useFetch<Item>(itemId ? `/api/items/${itemId}` : null);
  const [variationId, setVariationId] = useState<number | undefined>();
  const [search, setSearch] = useState("");
  const { data: results } = useFetch<Item[]>(search.length >= 2 ? `/api/items?status=all&q=${encodeURIComponent(search)}` : null);
  const options = [...e.parsed.candidates.map((c) => ({ id: c.itemId, label: `${c.title} (${Math.round(c.score * 100)}% match${c.listedThere ? "" : ", not listed there"})` })), ...(results ?? []).map((i) => ({ id: i.id, label: `${i.sku} ${i.title}` }))];
  return (
    <div className="rounded-xl border border-amber-900/70 bg-amber-950/20 p-4 text-sm">
      <div className="flex justify-between gap-2">
        <div>
          <div className="font-medium">✉️ {e.subject}</div>
          <div className="text-xs text-zinc-500">{e.marketplace} · {e.received_at}{e.note ? ` · ${e.note}` : ""}</div>
        </div>
        <button className="text-xs text-zinc-500 hover:text-zinc-200" onClick={async () => (await api.post(`/api/emails/${e.id}/ignore`), onDone())}>Not a sale</button>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{e.parsed.snippet}</p>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_110px_70px]">
        <div className="space-y-1">
          <select className="input" value={itemId ?? ""} onChange={(x) => (setItemId(Number(x.target.value)), setVariationId(undefined))}>
            <option value="" disabled>Which item sold?</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <input className="input py-1 text-xs" placeholder="Search another item…" value={search} onChange={(x) => setSearch(x.target.value)} />
          {item && item.variations.length > 0 && (
            <select className="input" value={variationId ?? ""} onChange={(x) => setVariationId(Number(x.target.value))}>
              <option value="" disabled>Which option?{e.parsed.size ? ` (email says size ${e.parsed.size})` : ""}</option>
              {item.variations.map((v) => <option key={v.id} value={v.id}>{v.name} - {v.quantity} left</option>)}
            </select>
          )}
        </div>
        <input className="input" type="number" step="0.01" value={price} onChange={(x) => setPrice(Number(x.target.value))} aria-label="Sale price" />
        <input className="input" type="number" min={1} value={qty} onChange={(x) => setQty(Number(x.target.value))} aria-label="Quantity" />
      </div>
      <button
        className="btn-primary mt-3"
        disabled={!itemId || !price || (!!item?.variations.length && !variationId)}
        onClick={async () => {
          try {
            await api.post(`/api/emails/${e.id}/confirm`, { itemId, variationId, salePrice: price, quantity: qty });
            toast(`Sale recorded for ${money(price)} - other listings updated`);
            onDone();
          } catch (x) {
            toast((x as Error).message, "err");
          }
        }}
      >
        ✓ Confirm sale
      </button>
    </div>
  );
}

export default function EmailReview() {
  const { data, reload } = useFetch<{ imap: boolean; emails: Email[] }>("/api/emails?status=review");
  if (!data) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">Sale emails to confirm</h2>
        <span className="text-xs text-zinc-500">{data.imap ? "📬 Watching your inbox" : "📭 Email detection off - add IMAP settings to .env"}</span>
      </div>
      {data.emails.length === 0 ? <div className="text-xs text-zinc-500">Nothing to confirm.</div> : data.emails.map((e) => <Row key={e.id} e={e} onDone={reload} />)}
    </section>
  );
}
