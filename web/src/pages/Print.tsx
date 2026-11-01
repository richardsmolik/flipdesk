/**
 * Print pages (no app chrome): packing slips (4x6), pick list (letter), QR labels (2.25x1.25 thermal or 4x6).
 * Open in a new tab, then Print. Works with Rollo/Dymo/Zebra thermal printers and regular printers.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, type Item } from "../api";
import { useMarketplaces } from "../ui";

const binLabel = (loc: string) => (/^bin\b/i.test(loc.trim()) ? loc.trim() : `Bin ${loc.trim()}`);

interface Order {
  id: number; marketplace: string; quantity: number; sale_price: number; order_id: string | null; buyer: string | null; sold_at: string;
  ship_to: { name: string; line1: string; line2?: string; city: string; state: string; zip: string } | null;
  item_id: number; sku: string; title: string; location: string; photo: string | null; variation: string | null;
}

function Qr({ text, size = 96 }: { text: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => void QRCode.toDataURL(text, { margin: 0, width: size * 2, errorCorrectionLevel: "M" }).then(setSrc), [text, size]);
  return src ? <img src={src} alt={`QR code for ${text}`} style={{ width: size, height: size }} /> : null;
}

function Toolbar({ title, note }: { title: string; note?: string }) {
  return (
    <div className="no-print mb-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-800">
      <div><b>{title}</b>{note && <span className="ml-2 text-zinc-500">{note}</span>}</div>
      <div className="flex gap-2">
        <button className="rounded bg-zinc-900 px-3 py-1.5 text-white" onClick={() => window.print()}>🖨 Print</button>
        <button className="rounded border border-zinc-300 px-3 py-1.5" onClick={() => window.close()}>Close</button>
      </div>
    </div>
  );
}

const PRINT_CSS = (page: string) => `
  @media print { .no-print { display: none !important } body { background: white !important } .page { break-after: page } }
  @page { size: ${page}; margin: 0.25in }
`;

const origin = () => location.origin;

export function PackingSlips() {
  const [sp] = useSearchParams();
  const [data, setData] = useState<{ shop: { name: string; thankYou: string }; orders: Order[] } | null>(null);
  useEffect(() => void api.get<NonNullable<typeof data>>(`/api/print/orders?ids=${sp.get("ids") ?? ""}`).then(setData), [sp]);
  const { byId } = useMarketplaces();
  if (!data) return null;
  return (
    <div className="min-h-screen bg-white p-4 text-black">
      <style>{PRINT_CSS("4in 6in")}</style>
      <Toolbar title={`${data.orders.length} packing slip(s)`} note="4x6 - print on thermal labels or plain paper" />
      {data.orders.map((o) => (
        <div key={o.id} className="page mx-auto mb-6 flex h-[5.5in] w-[3.5in] flex-col border border-dashed border-zinc-300 p-3 text-[11px] print:border-0">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-base font-bold">{data.shop.name || "Packing slip"}</div>
              <div>Order {o.order_id?.split(":")[0] ?? `#${o.id}`} · {o.sold_at.slice(0, 10)}</div>
              <div>{byId[o.marketplace]?.name ?? o.marketplace}{o.buyer ? ` · ${o.buyer}` : ""}</div>
            </div>
            <Qr text={`${origin()}/items/${o.item_id}`} size={56} />
          </div>
          {o.ship_to?.line1 && (
            <div className="mt-2 border-t pt-2">
              <div className="font-semibold">Ship to</div>
              <div>{o.ship_to.name}</div>
              <div>{o.ship_to.line1}{o.ship_to.line2 ? `, ${o.ship_to.line2}` : ""}</div>
              <div>{o.ship_to.city}, {o.ship_to.state} {o.ship_to.zip}</div>
            </div>
          )}
          <div className="mt-2 flex gap-2 border-t pt-2">
            {o.photo && <img src={o.photo} alt="" className="h-16 w-16 rounded object-cover" />}
            <div>
              <div className="font-semibold">{o.quantity > 1 ? `${o.quantity} x ` : ""}{o.title}</div>
              {o.variation && <div>{o.variation}</div>}
              <div>SKU {o.sku}{o.location ? ` · ${binLabel(o.location)}` : ""}</div>
            </div>
          </div>
          <div className="mt-auto border-t pt-2 text-[10px] italic">{data.shop.thankYou}</div>
        </div>
      ))}
    </div>
  );
}

export function PickList() {
  const [sp] = useSearchParams();
  const [data, setData] = useState<{ orders: Order[] } | null>(null);
  useEffect(() => void api.get<NonNullable<typeof data>>(`/api/print/orders?ids=${sp.get("ids") ?? ""}`).then(setData), [sp]);
  const { byId } = useMarketplaces();
  if (!data) return null;
  return (
    <div className="min-h-screen bg-white p-6 text-black">
      <style>{PRINT_CSS("letter")}</style>
      <Toolbar title={`Pick list: ${data.orders.length} order(s)`} note="Sorted by bin so you walk each shelf once" />
      <h1 className="mb-2 text-xl font-bold">Pick list · {new Date().toLocaleDateString()}</h1>
      <table className="w-full border-collapse text-sm">
        <thead><tr className="border-b-2 border-black text-left"><th className="py-1">✓</th><th>Bin</th><th>Photo</th><th>Item</th><th>Qty</th><th>Site</th></tr></thead>
        <tbody>
          {data.orders.map((o) => (
            <tr key={o.id} className="border-b border-zinc-300">
              <td className="py-1.5"><span className="inline-block h-4 w-4 border border-black" /></td>
              <td className="font-bold">{o.location || "-"}</td>
              <td>{o.photo && <img src={o.photo} alt="" className="h-10 w-10 object-cover" />}</td>
              <td>{o.title}{o.variation ? ` (${o.variation})` : ""}<div className="text-xs text-zinc-500">{o.sku}</div></td>
              <td>{o.quantity}</td>
              <td>{byId[o.marketplace]?.name ?? o.marketplace}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** QR labels for bins (?bins=A1,A2) or items (?items=1,2). size=small (2.25x1.25) | large (4x6). */
export function Labels() {
  const [sp] = useSearchParams();
  const size = sp.get("size") === "large" ? "large" : "small";
  const bins = (sp.get("bins") ?? "").split(",").filter(Boolean);
  const itemIds = (sp.get("items") ?? "").split(",").filter(Boolean);
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    if (itemIds.length) Promise.all(itemIds.map((id) => api.get<Item>(`/api/items/${id}`))).then(setItems);
  }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = [
    ...bins.map((b) => ({ key: `b${b}`, big: b.replace(/^bin\s*/i, ""), sub: "BIN", qr: `${origin()}/bins/${encodeURIComponent(b)}` })),
    ...items.map((i) => ({ key: `i${i.id}`, big: i.sku, sub: `${i.title.slice(0, 40)}${i.location ? ` · ${i.location}` : ""}`, qr: `${origin()}/items/${i.id}` })),
  ];
  const dims = size === "large" ? "w-[4in] h-[6in]" : "w-[2.25in] h-[1.25in]";
  return (
    <div className="min-h-screen bg-white p-4 text-black">
      <style>{PRINT_CSS(size === "large" ? "4in 6in" : "2.25in 1.25in")}</style>
      <Toolbar title={`${labels.length} label(s)`} note={size === "large" ? "4x6" : "2.25 x 1.25 in (Dymo / Rollo / Zebra)"} />
      <div className="flex flex-wrap gap-2 print:block">
        {labels.map((l) => (
          <div key={l.key} className={`page flex ${dims} items-center gap-2 overflow-hidden border border-dashed border-zinc-300 p-1.5 print:border-0 ${size === "large" ? "flex-col justify-center text-center" : ""}`}>
            <Qr text={l.qr} size={size === "large" ? 260 : 84} />
            <div className="min-w-0">
              <div className={`${size === "large" ? "text-5xl" : "text-xl"} font-black leading-none`}>{l.big}</div>
              <div className={`${size === "large" ? "mt-2 text-lg" : "text-[9px]"} leading-tight`}>{l.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
