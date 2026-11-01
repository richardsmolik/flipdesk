/**
 * Buy shipping labels inside FlipDesk via Shippo (discounted USPS/UPS/FedEx rates).
 * Set SHIPPO_API_KEY (use a test key "shippo_test_..." to try it free). Without a key: demo rates.
 */
import { getItem, getSetting, logActivity, type Db } from "../db.js";
import { ebayAddTracking, ebayIsLive } from "../marketplaces/ebay.js";
import { updateShipping, type Address, type ShippingSettings } from "./shipping.js";

export interface ShipFrom {
  name?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  email?: string;
}

export interface Rate {
  id: string;
  carrier: string;
  service: string;
  amount: number;
  days: number | null;
}

export const shippoLive = () => Boolean(process.env.SHIPPO_API_KEY);

async function shippo<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.goshippo.com${path}`, {
    method: "POST",
    headers: { Authorization: `ShippoToken ${process.env.SHIPPO_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { detail?: string };
  if (!res.ok) throw new Error(`Shippo ${path} -> ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

function saleForLabel(db: Db, saleId: number) {
  const s = db.prepare("SELECT id, item_id, marketplace, quantity, ship_to FROM sales WHERE id = ?").get(saleId) as
    | { id: number; item_id: number; marketplace: string; quantity: number; ship_to: string | null }
    | undefined;
  if (!s) throw new Error("Sale not found");
  const to = s.ship_to ? (JSON.parse(s.ship_to) as Address) : null;
  if (!to?.line1) throw new Error("Add the buyer's address first.");
  return { s, to };
}

export function parcelFor(db: Db, itemId: number, qty: number, override?: { weightOz?: number; length?: number; width?: number; height?: number }) {
  const pkg = getSetting<ShippingSettings>(db, "shipping", {}).defaultPackage ?? {};
  const item = getItem(db, itemId);
  return {
    weightOz: override?.weightOz ?? (item?.weight_oz ?? pkg.weightOz ?? 16) * qty,
    length: override?.length ?? pkg.length ?? 10,
    width: override?.width ?? pkg.width ?? 8,
    height: override?.height ?? pkg.height ?? 4,
  };
}

export async function getRates(db: Db, saleId: number, override?: { weightOz?: number; length?: number; width?: number; height?: number }): Promise<{ rates: Rate[]; demo: boolean }> {
  const { s, to } = saleForLabel(db, saleId);
  const parcel = parcelFor(db, s.item_id, s.quantity, override);
  if (!shippoLive()) {
    const lb = parcel.weightOz / 16;
    return {
      demo: true,
      rates: [
        { id: "demo_usps_ga", carrier: "USPS", service: "Ground Advantage", amount: Math.round((4.6 + lb * 1.1) * 100) / 100, days: 4 },
        { id: "demo_usps_pm", carrier: "USPS", service: "Priority Mail", amount: Math.round((8.1 + lb * 1.4) * 100) / 100, days: 2 },
        { id: "demo_ups_ground", carrier: "UPS", service: "Ground Saver", amount: Math.round((7.2 + lb * 0.9) * 100) / 100, days: 5 },
      ].sort((a, b) => a.amount - b.amount),
    };
  }
  const from = getSetting<ShipFrom>(db, "shipFrom", {});
  if (!from.street1 || !from.zip) throw new Error("Set your ship-from address in Settings, Shipping.");
  const shipment = await shippo<{ rates: { object_id: string; amount: string; provider: string; servicelevel: { name: string }; estimated_days?: number }[] }>("/shipments/", {
    address_from: { ...from, country: from.country || "US" },
    address_to: { name: to.name, street1: to.line1, street2: to.line2 || undefined, city: to.city, state: to.state, zip: to.zip, country: to.country || "US", phone: to.phone || undefined, email: to.email || undefined },
    parcels: [{ length: String(parcel.length), width: String(parcel.width), height: String(parcel.height), distance_unit: "in", weight: String(parcel.weightOz), mass_unit: "oz" }],
    async: false,
  });
  return {
    demo: false,
    rates: shipment.rates
      .map((r) => ({ id: r.object_id, carrier: r.provider, service: r.servicelevel.name, amount: Number(r.amount), days: r.estimated_days ?? null }))
      .sort((a, b) => a.amount - b.amount),
  };
}

export async function buyLabel(db: Db, saleId: number, rate: Rate) {
  const { s, to } = saleForLabel(db, saleId);
  let tracking: string;
  let labelUrl: string | null;
  if (!shippoLive() || rate.id.startsWith("demo_")) {
    tracking = `DEMO${Date.now()}`;
    labelUrl = null;
  } else {
    const t = await shippo<{ status: string; tracking_number: string; label_url: string; messages?: { text: string }[] }>("/transactions/", {
      rate: rate.id,
      label_file_type: "PDF_4x6",
      async: false,
    });
    if (t.status !== "SUCCESS") throw new Error(`Label failed: ${(t.messages ?? []).map((m) => m.text).join("; ") || t.status}`);
    tracking = t.tracking_number;
    labelUrl = t.label_url;
  }
  updateShipping(db, saleId, { cost: rate.amount, tracking, carrier: rate.carrier, source: "shippo", shipped: true });
  db.prepare("UPDATE sales SET label_url = ? WHERE id = ?").run(labelUrl, saleId);
  let trackingUploaded = false;
  if (s.marketplace === "ebay" && to.ebayOrderId && to.lineItemId && ebayIsLive(db) && !tracking.startsWith("DEMO")) {
    try {
      await ebayAddTracking(db, to.ebayOrderId, to.lineItemId, s.quantity, rate.carrier, tracking);
      trackingUploaded = true;
    } catch (e) {
      console.warn("[ebay tracking]", (e as Error).message);
    }
  }
  logActivity(db, "shipping", `Bought ${rate.carrier} ${rate.service} label for $${rate.amount.toFixed(2)}${trackingUploaded ? " - tracking sent to eBay" : ""}`, s.item_id);
  return { tracking, labelUrl, cost: rate.amount, trackingUploaded, demo: labelUrl === null };
}
