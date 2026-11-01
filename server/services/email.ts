/**
 * Sale detection from email - covers every marketplace, including the ones with
 * no API. Sources:
 *   1. IMAP polling (Gmail/Outlook/iCloud with an app password) - set IMAP_* in .env
 *   2. POST /api/ext/email (token auth) - for forwarding services / mail rules
 *
 * Matching doesn't depend on any site's email template: every live item's title
 * is scored against the whole email. Confident matches are recorded automatically;
 * anything uncertain goes to the Inbox for one-tap confirmation (a wrong auto-sale
 * would delist things that haven't sold).
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getItem, getSetting, logActivity, setSetting, type Db } from "../db.js";
import { ebayIsLive } from "../marketplaces/ebay.js";
import { MARKETPLACES, type MarketplaceId } from "../marketplaces/registry.js";
import { notify, raiseAlert } from "./alerts.js";
import { tokens } from "./comps.js";
import { NeedsVariationError, recordSale } from "./sync.js";
import { personalEnv } from "../context.js";

const SENDERS: [RegExp, MarketplaceId][] = [
  [/(^|[.@])ebay\.[a-z.]+$/i, "ebay"],
  [/(^|[.@])poshmark\.com$/i, "poshmark"],
  [/(^|[.@])mercari(app)?\.com$/i, "mercari"],
  [/(^|[.@])depop\.com$/i, "depop"],
  [/(^|[.@])vinted\.[a-z.]+$/i, "vinted"],
  [/(^|[.@])grailed\.com$/i, "grailed"],
  [/(^|[.@])(facebookmail|facebook)\.com$/i, "facebook"],
  [/(^|[.@])etsy\.com$/i, "etsy"],
  [/(^|[.@])shopify\.com$/i, "shopify"],
  [/(^|[.@])amazon\.[a-z.]+$/i, "amazon"],
  [/(^|[.@])whatnot\.com$/i, "whatnot"],
];

const SALE_RE =
  /(you (just )?made a sale|you('ve| have)? sold|your (item|listing) (has )?sold|item sold|it'?s sold|sold!|congrat\w*[^.\n]{0,40}sold|new order|you('ve| have) (got|received) an order|order (received|confirmed) for your|has been purchased|ship (it|your item|this item) (by|within)|time to ship|sold an item)/i;
const NOT_SALE_RE = /(price drop|liked your|new offer|sent you an offer|is now following|your order (has )?shipped|has been delivered|out for delivery|your purchase|you bought|thanks for your order|receipt for your order|weekly|newsletter|recommended for you)/i;

export function marketplaceFromSender(from: string): MarketplaceId | null {
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const domain = addr.split("@")[1] ?? addr;
  for (const [re, m] of SENDERS) if (re.test(domain)) return m;
  return null;
}

export interface ParsedSale {
  marketplace: MarketplaceId | null;
  isSale: boolean;
  price: number | null;
  orderId: string | null;
  quantity: number;
  size: string | null;
  buyer: string | null;
}

export function parseSaleEmail(from: string, subject: string, text: string): ParsedSale {
  const marketplace = marketplaceFromSender(from);
  const hay = `${subject}\n${text}`;
  const isSale = Boolean(marketplace) && SALE_RE.test(hay) && !NOT_SALE_RE.test(subject);
  const amount = (s: string) => Number(s.replace(/[,$\s]/g, ""));
  const labeled = hay.match(/(sold for|sale price|item price|price|order total|total|subtotal|you earned|earnings)[^$\n]{0,25}\$\s?([\d,]+(?:\.\d{2})?)/i);
  const any = hay.match(/\$\s?([\d,]+\.\d{2})/);
  const price = labeled ? amount(labeled[2]) : any ? amount(any[1]) : null;
  const orderId = hay.match(/order\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})/i)?.[1] ?? null;
  const quantity = Number(hay.match(/(?:quantity|qty)\s*[:x]?\s*(\d{1,3})\b/i)?.[1] ?? 1) || 1;
  const size = hay.match(/\bsize\s*[:\-]?\s*([A-Za-z0-9./]{1,8})\b/i)?.[1] ?? null;
  const buyer = hay.match(/(?:buyer|purchased by|sold to|bought by)\s*[:\-]?\s*@?([A-Za-z0-9_.\-]{3,30})/i)?.[1] ?? null;
  return { marketplace, isSale, price: price && price > 0 ? price : null, orderId, quantity, size, buyer };
}

export interface MatchCandidate {
  itemId: number;
  sku: string;
  title: string;
  score: number;
  listedThere: boolean;
}

/** Score every item that still has units against the email text. */
export function matchItems(db: Db, marketplace: MarketplaceId | null, subject: string, text: string): MatchCandidate[] {
  const words = new Set(tokens(`${subject} ${text}`));
  const rows = db
    .prepare(
      `SELECT i.id, i.sku, i.title, EXISTS(SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.marketplace = ? AND l.status IN ('active','ending')) AS there
       FROM items i WHERE i.status IN ('active','draft','sold') AND (i.quantity > 0 OR i.updated_at >= datetime('now','-2 days'))`,
    )
    .all(marketplace ?? "") as { id: number; sku: string; title: string; there: number }[];
  return rows
    .map((r) => {
      const tk = tokens(r.title);
      const hit = tk.filter((t) => words.has(t)).length;
      // SKU in the email (e.g. in a custom label) is a near-certain match.
      const skuHit = text.includes(r.sku) || subject.includes(r.sku);
      const score = skuHit ? 1 : tk.length ? hit / tk.length : 0;
      return { itemId: r.id, sku: r.sku, title: r.title, score: Math.round(score * 100) / 100, listedThere: Boolean(r.there) };
    })
    .filter((c) => c.score >= 0.34)
    .sort((a, b) => b.score - a.score || Number(b.listedThere) - Number(a.listedThere))
    .slice(0, 5);
}

export interface IngestInput {
  messageId?: string | null;
  from: string;
  subject: string;
  text: string;
  date?: string | null;
}

export function ingestEmail(db: Db, e: IngestInput, opts: { dryRun?: boolean } = {}) {
  if (e.messageId && !opts.dryRun) {
    const seen = db.prepare("SELECT id, status FROM sale_emails WHERE message_id = ?").get(e.messageId) as { id: number; status: string } | undefined;
    if (seen) return { status: "seen" as const, id: seen.id };
  }
  const parsed = parseSaleEmail(e.from, e.subject, e.text);
  if (!parsed.isSale || !parsed.marketplace) return { status: "not_a_sale" as const, parsed };
  const candidates = matchItems(db, parsed.marketplace, e.subject, e.text);
  const [top, second] = candidates;
  const confident = Boolean(top && top.score >= 0.75 && top.listedThere && (!second || top.score - second.score >= 0.15) && parsed.price);

  let status: "recorded" | "review" | "ignored" | "duplicate" = confident ? "recorded" : "review";
  let note = "";
  if (parsed.marketplace === "ebay" && ebayIsLive(db)) {
    status = "ignored";
    note = "eBay sales are imported from the eBay API";
  }
  if (opts.dryRun) return { status: status === "recorded" ? "would_record" : status, parsed, candidates };

  let saleId: number | null = null;
  let variationId: number | null = null;
  if (status === "recorded" && top) {
    // Same item + site + price in the last 2 days? Probably already recorded (e.g. by the extension).
    const dup = db
      .prepare("SELECT id FROM sales WHERE item_id = ? AND marketplace = ? AND ABS(sale_price - ?) < 0.01 AND sold_at >= datetime('now','-2 days')")
      .get(top.itemId, parsed.marketplace, parsed.price) as { id: number } | undefined;
    if (dup) {
      status = "duplicate";
      saleId = dup.id;
    } else {
      const item = getItem(db, top.itemId)!;
      const v = parsed.size ? item.variations.find((x) => Object.values(x.attrs).some((a) => a.toLowerCase() === parsed.size!.toLowerCase())) : undefined;
      try {
        const r = recordSale(db, {
          itemId: top.itemId,
          variationId: v?.id,
          marketplace: parsed.marketplace,
          salePrice: parsed.price! * (parsed.quantity > 1 && !/total/i.test(e.text) ? parsed.quantity : 1),
          quantity: parsed.quantity,
          orderId: parsed.orderId ? `email:${parsed.orderId}` : undefined,
          buyer: parsed.buyer ?? undefined,
          soldAt: e.date ?? undefined,
        });
        if ("duplicate" in r) status = "duplicate";
        else saleId = r.saleId;
        variationId = v?.id ?? null;
      } catch (err) {
        if (err instanceof NeedsVariationError) {
          status = "review";
          note = "Which size/color sold?";
        } else throw err;
      }
    }
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO sale_emails (message_id, received_at, sender, subject, marketplace, parsed, status, item_id, variation_id, sale_id, confidence, note)
         VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.messageId ?? null,
        e.date ?? null,
        e.from,
        e.subject.slice(0, 300),
        parsed.marketplace,
        JSON.stringify({ ...parsed, candidates, snippet: e.text.replace(/\s+/g, " ").slice(0, 600) }),
        status,
        top?.itemId ?? null,
        variationId,
        saleId,
        top?.score ?? null,
        note,
      ).lastInsertRowid,
  );

  const mp = MARKETPLACES[parsed.marketplace].name;
  if (status === "review") {
    raiseAlert(db, {
      kind: "email_review",
      severity: "warning",
      title: `Possible sale on ${mp}${parsed.price ? ` for $${parsed.price.toFixed(2)}` : ""} - confirm the item`,
      body: e.subject,
      itemId: top?.itemId,
      data: { emailId: id },
    });
    void notify(db, "email_review", `Confirm a ${mp} sale`, `${e.subject}${top ? ` - best guess: ${top.title}` : ""}`);
  } else if (status === "recorded") {
    logActivity(db, "email", `Detected sale from ${mp} email: ${e.subject}`, top?.itemId);
  }
  return { status, id, parsed, candidates };
}

/** Confirm a sale email from the review queue. */
export function confirmEmail(db: Db, emailId: number, p: { itemId: number; variationId?: number; salePrice: number; quantity?: number }) {
  const row = db.prepare("SELECT * FROM sale_emails WHERE id = ?").get(emailId) as { marketplace: MarketplaceId; parsed: string; status: string } | undefined;
  if (!row) throw new Error("Email not found");
  if (row.status === "recorded") throw new Error("Already recorded");
  const parsed = JSON.parse(row.parsed) as ParsedSale;
  const r = recordSale(db, {
    itemId: p.itemId,
    variationId: p.variationId,
    marketplace: row.marketplace,
    salePrice: p.salePrice,
    quantity: p.quantity ?? parsed.quantity ?? 1,
    orderId: parsed.orderId ? `email:${parsed.orderId}` : undefined,
    buyer: parsed.buyer ?? undefined,
  });
  db.prepare("UPDATE sale_emails SET status = ?, item_id = ?, variation_id = ?, sale_id = ? WHERE id = ?").run(
    "duplicate" in r ? "duplicate" : "recorded",
    p.itemId,
    p.variationId ?? null,
    "duplicate" in r ? null : r.saleId,
    emailId,
  );
  db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE kind = 'email_review' AND json_extract(data, '$.emailId') = ? AND resolved_at IS NULL").run(emailId);
  return r;
}

// ---------------- IMAP polling ----------------
export function imapConfigured() {
  return Boolean(personalEnv("IMAP_HOST") && personalEnv("IMAP_USER") && personalEnv("IMAP_PASSWORD"));
}

export async function pollImap(db: Db) {
  if (!imapConfigured()) return { checked: 0, sales: 0 };
  const client = new ImapFlow({
    host: personalEnv("IMAP_HOST")!,
    port: Number(personalEnv("IMAP_PORT") ?? 993),
    secure: personalEnv("IMAP_SECURE") !== "false",
    auth: { user: personalEnv("IMAP_USER")!, pass: personalEnv("IMAP_PASSWORD")! },
    logger: false,
  });
  await client.connect();
  let checked = 0;
  let sales = 0;
  const lock = await client.getMailboxLock(personalEnv("IMAP_MAILBOX") ?? "INBOX");
  try {
    const lastUid = getSetting<number>(db, "imap.lastUid", 0);
    // First run: only look back 3 days.
    const uids = lastUid
      ? ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [])
      : ((await client.search({ since: new Date(Date.now() - 3 * 86400_000) }, { uid: true })) || []);
    let maxUid = lastUid;
    for (const uid of uids) {
      if (uid <= lastUid) continue;
      maxUid = Math.max(maxUid, uid);
      const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
      const from = msg && msg.envelope?.from?.[0]?.address;
      if (!from || !marketplaceFromSender(from)) continue; // only marketplace senders
      const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!full || !full.source) continue;
      const mail = await simpleParser(full.source);
      checked++;
      const r = ingestEmail(db, {
        messageId: mail.messageId ?? `imap:${uid}`,
        from,
        subject: mail.subject ?? "",
        text: mail.text ?? (typeof mail.html === "string" ? mail.html.replace(/<[^>]+>/g, " ") : ""),
        date: mail.date ? mail.date.toISOString().replace("T", " ").slice(0, 19) : null,
      });
      if (r.status === "recorded") sales++;
    }
    if (maxUid > lastUid) setSetting(db, "imap.lastUid", maxUid);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return { checked, sales };
}
