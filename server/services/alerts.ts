/**
 * Alerts (things that need you) + push notifications to your phone via ntfy.sh
 * (free; install the ntfy app and subscribe to your private topic name).
 */
import { getSetting, logActivity, type Db, type Item } from "../db.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";

export interface NotifySettings {
  ntfyTopic?: string;
  ntfyServer?: string; // default https://ntfy.sh
  onSale?: boolean;
  onOversell?: boolean;
  onEmailReview?: boolean;
  onWeekly?: boolean;
}

export function raiseAlert(
  db: Db,
  a: { kind: string; severity?: "info" | "warning" | "critical"; title: string; body?: string; itemId?: number; saleId?: number; data?: unknown },
) {
  const r = db
    .prepare("INSERT INTO alerts (kind, severity, title, body, item_id, sale_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(a.kind, a.severity ?? "warning", a.title, a.body ?? "", a.itemId ?? null, a.saleId ?? null, JSON.stringify(a.data ?? {}));
  return Number(r.lastInsertRowid);
}

export async function notify(db: Db, event: "sale" | "oversell" | "email_review" | "weekly" | "feedback", title: string, message: string) {
  const s = getSetting<NotifySettings>(db, "notify", {});
  if (!s.ntfyTopic) return false;
  const enabled =
    event === "sale" ? s.onSale !== false : event === "oversell" ? s.onOversell !== false : event === "weekly" ? s.onWeekly !== false : event === "feedback" ? true : s.onEmailReview !== false;
  if (!enabled) return false;
  try {
    const res = await fetch(`${(s.ntfyServer || "https://ntfy.sh").replace(/\/$/, "")}/${encodeURIComponent(s.ntfyTopic)}`, {
      method: "POST",
      headers: {
        Title: title.replace(/[^\x20-\x7E]/g, ""), // headers must be ASCII
        Priority: event === "oversell" ? "urgent" : "default",
        Tags: event === "sale" ? "moneybag" : event === "oversell" ? "rotating_light" : event === "weekly" ? "bar_chart" : event === "feedback" ? "speech_balloon" : "envelope",
      },
      body: message,
    });
    return res.ok;
  } catch (e) {
    console.warn("[notify]", (e as Error).message);
    return false;
  }
}

/** Polite message asking the second buyer to cancel. On eBay a buyer-requested
 *  cancellation avoids the "out of stock" seller defect a seller cancel causes. */
export function oversellMessage(item: Pick<Item, "title">, marketplace: MarketplaceId, buyer?: string | null) {
  const hi = buyer ? `Hi ${buyer},` : "Hi there,";
  const how =
    marketplace === "ebay"
      ? "Could you please request a cancellation from your Purchase History (choose \"I don't want it anymore\" or similar)? I'll approve it right away and you'll get a full refund."
      : "I'm cancelling the order now and you'll receive a full refund automatically.";
  return `${hi}

Thank you so much for your purchase of "${item.title}". I'm really sorry - this item sold on another platform moments before your order came through, and I only had one.

${how}

I apologize for the inconvenience. If you'd like, I'm happy to let you know when I find another one.

Thanks for understanding!`;
}

export function raiseOversell(
  db: Db,
  p: { item: Item; marketplace: MarketplaceId; saleId: number; buyer?: string | null; qty: number; available: number; variationName?: string },
) {
  const where = MARKETPLACES[p.marketplace].name;
  const title = `OVERSOLD: ${p.item.sku}${p.variationName ? ` (${p.variationName})` : ""} on ${where}`;
  const body = `Sold ${p.qty} on ${where} but only ${p.available} ${p.available === 1 ? "was" : "were"} left. Contact the buyer and cancel this order.`;
  const id = raiseAlert(db, {
    kind: "oversell",
    severity: "critical",
    title,
    body,
    itemId: p.item.id,
    saleId: p.saleId,
    data: { marketplace: p.marketplace, buyer: p.buyer ?? null, message: oversellMessage(p.item, p.marketplace, p.buyer) },
  });
  logActivity(db, "alert", `${title} - ${body}`, p.item.id);
  void notify(db, "oversell", title, body);
  return id;
}
