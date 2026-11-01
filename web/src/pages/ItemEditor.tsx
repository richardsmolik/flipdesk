import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, CONDITIONS, money, type Item } from "../api";
import { Modal, MpBadge, QtyBar, timeAgo, toast, useFetch, useMarketplaces } from "../ui";
import VariationsCard from "../components/Variations";

interface Draft {
  title: string;
  short_title: string;
  description: string;
  brand: string;
  category: string;
  condition: string;
  color: string;
  size: string;
  item_specifics: { name: string; value: string }[];
  keywords: string[];
  flaws: string[];
  verify: string[];
  price: { recommended: number; low: number; high: number; quick_sale: number; confidence: string; reasoning: string };
  best_marketplaces: string[];
}

interface Rec {
  marketplace: string;
  price: number;
  fees: number;
  net: number;
  profit: number;
  marginPct: number;
  fitScore: number;
  reason: string;
}

function applyDraft(d: Draft): Partial<Item> {
  return {
    title: d.title,
    description: d.description,
    brand: d.brand,
    category: d.category,
    condition: d.condition,
    color: d.color,
    size: d.size,
    specifics: Object.fromEntries(d.item_specifics.map((s) => [s.name, s.value])),
    keywords: d.keywords,
    price: d.price.recommended,
    min_price: Math.round(d.price.quick_sale * 0.9 * 100) / 100,
  };
}

// ---------------- New item: photos -> AI -> draft ----------------
function NewItem() {
  const nav = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [hint, setHint] = useState("");
  const [cost, setCost] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const create = async (useAi: boolean) => {
    try {
      setBusy("Creating item…");
      const units = Math.max(1, Number(qty) || 1);
      const item = await api.post<Item>("/api/items", { cost: Number(cost) || 0, quantity: units, quantity_purchased: units, notes: hint });
      if (files.length) {
        const fd = new FormData();
        files.forEach((f) => fd.append("photos", f));
        await api.post(`/api/items/${item.id}/photos`, fd);
      }
      if (useAi) {
        setBusy("AI is writing your listing…");
        const fd = new FormData();
        fd.append("itemId", String(item.id));
        if (hint) fd.append("hint", hint);
        if (cost) fd.append("cost", cost);
        const r = await api.post<{ draft: Draft; demo: boolean }>("/api/ai/generate", fd);
        await api.patch(`/api/items/${item.id}`, applyDraft(r.draft));
        sessionStorage.setItem(`draft-${item.id}`, JSON.stringify(r.draft));
        toast(r.demo ? "Demo draft created - add ANTHROPIC_API_KEY for real AI" : "Listing written - review and crosslist");
      }
      nav(`/items/${item.id}`);
    } catch (e) {
      toast((e as Error).message, "err");
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">New listing</h1>
        <p className="text-sm text-zinc-400">Drop your photos. AI writes the title, description, item specifics and a price - you review and crosslist in one click.</p>
      </div>
      <div
        className="card flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 border-dashed p-6 text-center hover:border-brand"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setFiles((f) => [...f, ...Array.from(e.dataTransfer.files).filter((x) => x.type.startsWith("image/"))]);
        }}
      >
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])} />
        {files.length ? (
          <div className="grid grid-cols-4 gap-2">
            {files.map((f, i) => (
              <div key={i} className="relative">
                <img src={URL.createObjectURL(f)} alt="" className="h-24 w-24 rounded-md object-cover" />
                {i === 0 && <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">Cover</span>}
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="text-4xl">📸</div>
            <div className="text-sm text-zinc-300">Drag photos here or click to choose</div>
            <div className="text-xs text-zinc-500">Front, back, tags/labels, flaws. Up to 8 are read by the AI.</div>
          </>
        )}
      </div>
      <div>
        <label className="label">Notes for the AI (optional)</label>
        <input className="input" placeholder='e.g. "size L, small stain on cuff, smoke-free home"' value={hint} onChange={(e) => setHint(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">What you paid per unit</label>
          <input className="input" type="number" step="0.01" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} />
        </div>
        <div>
          <label className="label">Units purchased</label>
          <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
      </div>
      <div className="flex gap-2">
        <button className="btn-primary flex-1" disabled={!!busy || (!files.length && !hint)} onClick={() => create(true)}>
          {busy ?? "✨ Generate listing with AI"}
        </button>
        <button className="btn-ghost" disabled={!!busy} onClick={() => create(false)}>Fill in manually</button>
      </div>
    </div>
  );
}

// ---------------- Existing item ----------------
export default function ItemEditor() {
  const { id } = useParams();
  if (!id) return <NewItem />;
  return <EditItem id={Number(id)} />;
}

function EditItem({ id }: { id: number }) {
  const nav = useNavigate();
  const { data: item, reload, setData } = useFetch<Item>(`/api/items/${id}`);
  const [form, setForm] = useState<Partial<Item>>({});
  const [draft, setDraft] = useState<Draft | null>(() => JSON.parse(sessionStorage.getItem(`draft-${id}`) ?? "null"));
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "sold" | "restock" | "comps">(null);
  const { byId } = useMarketplaces();
  const shipping = 0;
  const { data: recs, reload: reloadRecs } = useFetch<Rec[]>(`/api/items/${id}/recommend?shipping=${shipping}`, [item?.price, item?.cost]);
  const [picked, setPicked] = useState<string[]>([]);
  const photoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (item) setForm(item);
  }, [item]);
  useEffect(() => {
    if (recs && !picked.length) {
      const live = new Set(item?.listings.filter((l) => ["active", "queued"].includes(l.status)).map((l) => l.marketplace));
      setPicked((draft?.best_marketplaces ?? recs.slice(0, 4).map((r) => r.marketplace)).filter((m) => !live.has(m)).slice(0, 4));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs]);

  if (!item) return <div className="text-zinc-500">Loading…</div>;
  const set = <K extends keyof Item>(k: K, v: Item[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(item);

  const save = async () => {
    const { title, description, brand, category, condition, color, size, specifics, keywords, cost, price, min_price, quantity, quantity_purchased, weight_oz, location, source, notes } = form;
    const r = await api.patch<Item>(`/api/items/${id}`, { title, description, brand, category, condition, color, size, specifics, keywords, cost, price, min_price, quantity, quantity_purchased, weight_oz, location, source, notes });
    setData(r);
    reloadRecs();
    toast("Saved");
    return r;
  };

  const regenerate = async () => {
    setBusy("AI is rewriting…");
    try {
      const fd = new FormData();
      fd.append("itemId", String(id));
      if (form.notes) fd.append("hint", form.notes);
      if (form.cost) fd.append("cost", String(form.cost));
      const r = await api.post<{ draft: Draft; demo: boolean }>("/api/ai/generate", fd);
      setDraft(r.draft);
      sessionStorage.setItem(`draft-${id}`, JSON.stringify(r.draft));
      setForm((f) => ({ ...f, ...applyDraft(r.draft) }));
      toast("New draft applied - review, then Save");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  const doCrosslist = async () => {
    if (dirty) await save();
    setBusy("Crosslisting…");
    try {
      const r = await api.post<{ queued: unknown[]; item: Item }>(`/api/items/${id}/crosslist`, { marketplaces: picked });
      setData(r.item);
      setPicked([]);
      toast(`Sent to ${r.queued.length} marketplace(s). API sites post instantly; the rest post via the extension.`);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  const listingFor = (m: string) => item.listings.find((l) => l.marketplace === m);
  const specifics = Object.entries(form.specifics ?? {});

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/inventory" className="text-xs text-zinc-500 hover:text-zinc-300">← Inventory</Link>
          <h1 className="mt-1 max-w-3xl text-xl font-semibold">{form.title || "Untitled draft"}</h1>
          <div className="text-xs text-zinc-500">{item.sku} · {item.status} · updated {timeAgo(item.updated_at)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={regenerate} disabled={!!busy}>✨ {busy?.startsWith("AI") ? busy : "AI rewrite"}</button>
          {item.quantity > 0 && <button className="btn-ghost" onClick={() => setModal("sold")}>💵 Mark sold</button>}
          <button className="btn-primary" disabled={!dirty} onClick={save}>Save</button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          {/* Photos */}
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Photos ({item.photos.length})</h2>
              <button className="text-xs text-brand hover:underline" onClick={() => photoInput.current?.click()}>+ Add photos</button>
              <input
                ref={photoInput}
                type="file"
                multiple
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const fd = new FormData();
                  Array.from(e.target.files ?? []).forEach((f) => fd.append("photos", f));
                  setData(await api.post<Item>(`/api/items/${id}/photos`, fd));
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {item.photos.map((p, i) => (
                <div key={p.id} className="group relative">
                  <img src={p.url} alt="" className="h-24 w-24 rounded-md object-cover" />
                  {i === 0 && <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">Cover</span>}
                  <button className="absolute right-1 top-1 hidden rounded bg-black/70 px-1 text-xs group-hover:block" onClick={async () => (await api.del(`/api/photos/${p.id}`), reload())} aria-label="Remove photo">✕</button>
                  {i > 0 && (
                    <button
                      className="absolute bottom-1 left-1 hidden rounded bg-black/70 px-1 text-[10px] group-hover:block"
                      onClick={async () => {
                        const ids = item.photos.map((x) => x.id);
                        ids.splice(i, 1);
                        ids.unshift(p.id);
                        setData(await api.post<Item>(`/api/items/${id}/photos/order`, { ids }));
                      }}
                    >
                      Make cover
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {draft && (draft.flaws.length > 0 || draft.verify.length > 0 || draft.price) && (
            <div className="card border-blue-900/70 p-4 text-sm">
              <h2 className="mb-2 font-semibold text-blue-200">✨ AI notes</h2>
              {draft.verify.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs uppercase tracking-wide text-amber-300">Check before listing</div>
                  <ul className="ml-4 list-disc text-zinc-300">{draft.verify.map((v) => <li key={v}>{v}</li>)}</ul>
                </div>
              )}
              {draft.flaws.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs uppercase tracking-wide text-red-300">Flaws spotted (disclosed in description)</div>
                  <ul className="ml-4 list-disc text-zinc-300">{draft.flaws.map((v) => <li key={v}>{v}</li>)}</ul>
                </div>
              )}
              <div className="text-zinc-400">
                Price range {money(draft.price.low)}-{money(draft.price.high)} · quick sale {money(draft.price.quick_sale)} · confidence {draft.price.confidence}. {draft.price.reasoning}
              </div>
            </div>
          )}

          {/* Listing details */}
          <div className="card space-y-4 p-4">
            <div>
              <div className="flex justify-between">
                <label className="label">Title</label>
                <span className={`text-xs ${(form.title?.length ?? 0) > 80 ? "text-red-400" : "text-zinc-500"}`}>{form.title?.length ?? 0}/80 (eBay)</span>
              </div>
              <input className="input" value={form.title ?? ""} onChange={(e) => set("title", e.target.value)} />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea className="input min-h-40 font-mono text-[13px]" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <div><label className="label">Brand</label><input className="input" value={form.brand ?? ""} onChange={(e) => set("brand", e.target.value)} /></div>
              <div className="md:col-span-2"><label className="label">Category</label><input className="input" value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} /></div>
              <div>
                <label className="label">Condition</label>
                <select className="input" value={form.condition} onChange={(e) => set("condition", e.target.value)}>
                  {Object.entries(CONDITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div><label className="label">Color</label><input className="input" value={form.color ?? ""} onChange={(e) => set("color", e.target.value)} /></div>
              <div><label className="label">Size</label><input className="input" value={form.size ?? ""} onChange={(e) => set("size", e.target.value)} /></div>
            </div>
            <div>
              <label className="label">Item specifics</label>
              <div className="grid gap-2 md:grid-cols-2">
                {specifics.map(([k, v]) => (
                  <div key={k} className="flex gap-1">
                    <input className="input w-2/5" value={k} readOnly />
                    <input className="input" value={v} onChange={(e) => set("specifics", { ...form.specifics, [k]: e.target.value })} />
                    <button className="px-2 text-zinc-500 hover:text-red-400" aria-label={`Remove ${k}`} onClick={() => { const s = { ...form.specifics }; delete s[k]; set("specifics", s); }}>✕</button>
                  </div>
                ))}
                <button className="btn-ghost text-xs" onClick={() => { const k = prompt("Specific name (e.g. Material)"); if (k) set("specifics", { ...form.specifics, [k]: "" }); }}>+ Add specific</button>
              </div>
            </div>
            <div>
              <label className="label">Keywords / tags</label>
              <input className="input" value={(form.keywords ?? []).join(", ")} onChange={(e) => set("keywords", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-5">
          <div className="card space-y-3 p-4">
            <h2 className="text-sm font-semibold">Quantity</h2>
            {item.variations.length === 0 && (
              <>
                <QtyBar purchased={form.quantity_purchased ?? 0} sold={item.quantity_sold} left={form.quantity ?? 0} />
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="label">Purchased</label>
                    <input className="input" type="number" min={0} value={form.quantity_purchased ?? 0} onChange={(e) => set("quantity_purchased", Number(e.target.value))} />
                  </div>
                  <div>
                    <label className="label">Sold</label>
                    <input className="input opacity-70" value={item.quantity_sold} readOnly title="Counted from recorded sales" />
                  </div>
                  <div>
                    <label className="label">Left</label>
                    <input className="input" type="number" min={0} value={form.quantity ?? 0} onChange={(e) => set("quantity", Number(e.target.value))} />
                  </div>
                </div>
              </>
            )}
            <VariationsCard item={item} onSaved={setData} />
            <button className="btn-ghost w-full" onClick={() => setModal("restock")}>📦 Restock (bought more)</button>
            <p className="text-[11px] text-zinc-500">When a unit sells, the new count syncs to every site. Sites that only allow quantity 1 (Mercari, Vinted, Grailed, Facebook) get relisted automatically while units remain.</p>
          </div>

          <div className="card space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Pricing</h2>
              <button className="text-xs text-brand hover:underline" onClick={() => setModal("comps")}>🔎 Research comps</button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div><label className="label">Price</label><input className="input" type="number" step="0.01" value={form.price ?? 0} onChange={(e) => set("price", Number(e.target.value))} /></div>
              <div><label className="label">Floor</label><input className="input" type="number" step="0.01" value={form.min_price ?? ""} placeholder="min" onChange={(e) => set("min_price", e.target.value === "" ? null : Number(e.target.value))} /></div>
              <div><label className="label">Cost/unit</label><input className="input" type="number" step="0.01" value={form.cost ?? 0} onChange={(e) => set("cost", Number(e.target.value))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Bin / location</label><input className="input" value={form.location ?? ""} onChange={(e) => set("location", e.target.value)} /></div>
              <div><label className="label">Weight (oz)</label><input className="input" type="number" value={form.weight_oz ?? ""} onChange={(e) => set("weight_oz", e.target.value === "" ? null : Number(e.target.value))} /></div>
            </div>
          </div>

          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Marketplaces</h2>
              <span className="text-[11px] text-zinc-500">profit per unit at {money(item.price)}</span>
            </div>
            <ul className="divide-y divide-zinc-800">
              {recs?.map((r, i) => {
                const all = item.listings.filter((x) => x.marketplace === r.marketplace);
                const liveAll = all.filter((x) => ["active", "queued", "ending"].includes(x.status));
                const l = liveAll[0] ?? listingFor(r.marketplace);
                const live = liveAll.length > 0;
                return (
                  <li key={r.marketplace} className="flex items-center gap-2 py-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={!!live || item.quantity < 1}
                      checked={picked.includes(r.marketplace)}
                      onChange={() => setPicked((p) => (p.includes(r.marketplace) ? p.filter((x) => x !== r.marketplace) : [...p, r.marketplace]))}
                      aria-label={`Select ${r.marketplace}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <MpBadge id={r.marketplace} mp={byId[r.marketplace]} status={l?.status} />
                        {i < 3 && !live && <span className="text-[10px] text-blue-300">top pick</span>}
                        {liveAll.length > 1 && <span className="text-[10px] text-zinc-400">{liveAll.length} listings (1 per option)</span>}
                      </div>
                      <div className="truncate text-[11px] text-zinc-500" title={r.reason}>{l?.error ? <span className="text-red-400">{l.error}</span> : r.reason}</div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className={r.profit >= 0 ? "text-zinc-100" : "text-red-400"}>{money(r.profit)}</div>
                      <div className="text-[10px] text-zinc-500">fees {money(r.fees)}</div>
                    </div>
                    {live && l && (
                      <div className="flex flex-col items-end gap-0.5">
                        {l.url && <a href={l.url} target="_blank" rel="noreferrer" className="text-[11px] text-brand hover:underline">view</a>}
                        <button
                          className="text-[11px] text-zinc-500 hover:text-red-400"
                          onClick={async () => {
                            let last: Item | null = null;
                            for (const x of liveAll) last = await api.post<Item>(`/api/listings/${x.id}/delist`);
                            if (last) setData(last);
                          }}
                        >
                          end{liveAll.length > 1 ? " all" : ""}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <button className="btn-primary mt-3 w-full" disabled={!picked.length || !!busy || item.quantity < 1} onClick={doCrosslist}>
              {item.quantity < 1 ? "No units left - restock first" : busy === "Crosslisting…" ? busy : `🔁 Crosslist to ${picked.length} site${picked.length === 1 ? "" : "s"}`}
            </button>
          </div>

          <button className="w-full text-xs text-zinc-600 hover:text-red-400" onClick={async () => { if (confirm("Delete this item and its listing records?")) { await api.del(`/api/items/${id}`); nav("/inventory"); } }}>
            Delete item
          </button>
        </div>
      </div>

      <SoldModal open={modal === "sold"} item={item} onClose={() => setModal(null)} onDone={(i) => (setData(i), setModal(null))} />
      <RestockModal open={modal === "restock"} item={item} onClose={() => setModal(null)} onDone={(i) => (setData(i), setModal(null))} />
      <CompsModal open={modal === "comps"} query={[form.brand, form.title].filter(Boolean).join(" ").slice(0, 80)} onClose={() => setModal(null)} onUse={(p) => (set("price", p), setModal(null))} />
    </div>
  );
}

function SoldModal({ open, item, onClose, onDone }: { open: boolean; item: Item; onClose: () => void; onDone: (i: Item) => void }) {
  const { marketplaces } = useMarketplaces();
  const live = item.listings.filter((l) => l.status === "active").map((l) => l.marketplace);
  const [m, setM] = useState(live[0] ?? "ebay");
  const [qty, setQty] = useState(1);
  const inStock = item.variations.filter((v) => v.quantity > 0);
  const [variationId, setVariationId] = useState<number | undefined>(inStock[0]?.id);
  const [price, setPrice] = useState(item.price);
  const [shipCharged, setShipCharged] = useState(0);
  const [shipCost, setShipCost] = useState(0);
  return (
    <Modal open={open} onClose={onClose} title="Record a sale">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">Sold on</label>
          <select className="input" value={m} onChange={(e) => setM(e.target.value)}>
            {marketplaces.map((x) => <option key={x.id} value={x.id}>{x.name}{live.includes(x.id) ? " (listed)" : ""}</option>)}
          </select>
        </div>
        {item.variations.length > 0 && (
          <div className="col-span-2">
            <label className="label">Which one sold?</label>
            <select className="input" value={variationId} onChange={(e) => setVariationId(Number(e.target.value))}>
              {item.variations.map((v) => <option key={v.id} value={v.id}>{v.name} - {v.quantity} left</option>)}
            </select>
          </div>
        )}
        <div><label className="label">Units sold</label><input className="input" type="number" min={1} max={item.quantity} value={qty} onChange={(e) => (setQty(Number(e.target.value)), setPrice(item.price * Number(e.target.value)))} /></div>
        <div><label className="label">Total sale price</label><input className="input" type="number" step="0.01" value={price} onChange={(e) => setPrice(Number(e.target.value))} /></div>
        <div><label className="label">Shipping buyer paid</label><input className="input" type="number" step="0.01" value={shipCharged} onChange={(e) => setShipCharged(Number(e.target.value))} /></div>
        <div><label className="label">Your label cost</label><input className="input" type="number" step="0.01" value={shipCost} onChange={(e) => setShipCost(Number(e.target.value))} /></div>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        {item.quantity - qty <= 0 ? "That's the last unit - FlipDesk will delist it everywhere else." : `${item.quantity - qty} unit(s) will remain; quantities sync on every site.`}
      </p>
      <button
        className="btn-primary mt-4 w-full"
        onClick={async () => {
          try {
            const r = await api.post<{ profit: number; item: Item; delisted: string[]; oversold?: boolean }>(`/api/items/${item.id}/sold`, { marketplace: m, salePrice: price, quantity: qty, variationId, shippingCharged: shipCharged, shippingCost: shipCost });
            if (r.oversold) toast("Oversold! See the alert on the dashboard - a buyer message is drafted for you.", "err");
            else toast(`Sale recorded - profit ${money(r.profit)}${r.delisted?.length ? `; delisting from ${r.delisted.length} site(s)` : ""}`);
            onDone(r.item);
          } catch (e) {
            toast((e as Error).message, "err");
          }
        }}
      >
        Record sale
      </button>
    </Modal>
  );
}

function RestockModal({ open, item, onClose, onDone }: { open: boolean; item: Item; onClose: () => void; onDone: (i: Item) => void }) {
  const [units, setUnits] = useState(1);
  const [unitCost, setUnitCost] = useState(item.cost);
  const [variationId, setVariationId] = useState<number | undefined>(item.variations[0]?.id);
  const avg = (item.cost * item.quantity + unitCost * units) / Math.max(1, item.quantity + units);
  return (
    <Modal open={open} onClose={onClose} title="Restock">
      {item.variations.length > 0 && (
        <div className="mb-3">
          <label className="label">Which option?</label>
          <select className="input" value={variationId} onChange={(e) => setVariationId(Number(e.target.value))}>
            {item.variations.map((v) => <option key={v.id} value={v.id}>{v.name} - {v.quantity} left</option>)}
          </select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Units bought</label><input className="input" type="number" min={1} value={units} onChange={(e) => setUnits(Number(e.target.value))} /></div>
        <div><label className="label">Cost per unit</label><input className="input" type="number" step="0.01" value={unitCost} onChange={(e) => setUnitCost(Number(e.target.value))} /></div>
      </div>
      <p className="mt-3 text-sm text-zinc-400">
        {item.quantity} → <span className="text-zinc-100">{item.quantity + units}</span> left · average cost becomes <span className="text-zinc-100">{money(Math.round(avg * 100) / 100)}</span>/unit
      </p>
      <button className="btn-primary mt-4 w-full" onClick={async () => { const i = await api.post<Item>(`/api/items/${item.id}/restock`, { units, unitCost, variationId }); toast(`Restocked +${units}`); onDone(i); }}>
        Add {units} unit(s)
      </button>
    </Modal>
  );
}

interface PriceResearch {
  demo: boolean;
  sources: string[];
  demand: { soldUnits: number; activeListings: number; sellThrough: number | null } | null;
  comps: { title: string; price: number; sold: boolean; url?: string; source: string }[];
  soldStats: { median: number; p25: number; p75: number; count: number } | null;
  activeStats: { median: number; count: number } | null;
  suggestion: { recommended: number; quickSale: number; stretch: number } | null;
}

function CompsModal({ open, query, onClose, onUse }: { open: boolean; query: string; onClose: () => void; onUse: (p: number) => void }) {
  const [q, setQ] = useState(query);
  const [r, setR] = useState<PriceResearch | null>(null);
  useEffect(() => {
    if (open) {
      setQ(query);
      setR(null);
      if (query) api.get<PriceResearch>(`/api/pricing?q=${encodeURIComponent(query)}`).then(setR);
    }
  }, [open, query]);
  return (
    <Modal open={open} onClose={onClose} title="Price research">
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), api.get<PriceResearch>(`/api/pricing?q=${encodeURIComponent(q)}`).then(setR))}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-ghost">Search</button>
      </form>
      {r && (
        <div className="mt-3 space-y-3 text-sm">
          {r.demo && <div className="rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">Demo comps. Import Terapeak data (Power tools page) or add eBay API keys for real prices.</div>}
          {!r.demo && <div className="text-xs text-zinc-500">Sources: {r.sources.map((x) => (x === "sold-library" ? "your sold data" : x === "ebay-active" ? "eBay active listings" : x)).join(" + ")}{r.demand ? ` · ${r.demand.soldUnits} sold${r.demand.sellThrough !== null ? ` · ${r.demand.sellThrough}% sell-through` : ""}` : ""}</div>}
          {r.suggestion && (
            <div className="grid grid-cols-3 gap-2 text-center">
              {([["Quick sale", r.suggestion.quickSale], ["Recommended", r.suggestion.recommended], ["Stretch", r.suggestion.stretch]] as const).map(([l, v]) => (
                <button key={l} className="card p-2 hover:border-brand" onClick={() => onUse(v)}>
                  <div className="text-[11px] text-zinc-500">{l}</div>
                  <div className="font-semibold tabular-nums">{money(v)}</div>
                </button>
              ))}
            </div>
          )}
          <ul className="max-h-60 divide-y divide-zinc-800 overflow-auto">
            {r.comps.map((c, i) => (
              <li key={i} className="flex justify-between gap-2 py-1.5">
                <span className="truncate text-zinc-300">{c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.title}</a> : c.title}</span>
                <span className="shrink-0 tabular-nums">{c.sold ? <span className="mr-1 text-[10px] text-green-400">SOLD</span> : <span className="mr-1 text-[10px] text-zinc-500">ACTIVE</span>}{money(c.price)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
