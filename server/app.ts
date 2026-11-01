import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getItem, getSetting, hydrateItem, logActivity, setSetting, tx, type Db, type ItemRow, type ListingRow } from "./db.js";
import { MARKETPLACES, MARKETPLACE_IDS, isMarketplaceId, type MarketplaceId } from "./marketplaces/registry.js";
import { adapterFor } from "./marketplaces/adapters.js";
import { ebayConsentUrl, ebayExchangeCode, ebayHasAppKeys, ebayIsLive, fetchPolicies } from "./marketplaces/ebay.js";
import { aiIsLive, generateListing } from "./services/ai.js";
import { breakdown, recommend } from "./services/fees.js";
import { claimExtensionJob, completeJob, crosslist, enqueue, listingQty, processApiJobs, requestDelist } from "./services/jobs.js";
import { researchPrice } from "./services/pricing.js";
import { NeedsVariationError, recordSale, restock, saveVariations } from "./services/sync.js";
import { bulkPrice, relist, sendOffersToWatchers, staleListings } from "./services/ebayTools.js";
import { dashboard, toCsv } from "./services/reports.js";
import { notify } from "./services/alerts.js";
import { compsLibrary, importComps } from "./services/comps.js";
import { checkItem } from "./services/sourcing.js";
import { profitReport } from "./services/insights.js";
import { confirmEmail, imapConfigured, ingestEmail } from "./services/email.js";
import { simpleParser } from "mailparser";

const MarketplaceEnum = z.enum(MARKETPLACE_IDS as [MarketplaceId, ...MarketplaceId[]]);

const ItemInput = z.object({
  sku: z.string().min(1).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  condition: z.string().optional(),
  color: z.string().optional(),
  size: z.string().optional(),
  specifics: z.record(z.string(), z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  cost: z.number().min(0).optional(),
  price: z.number().min(0).optional(),
  min_price: z.number().min(0).nullable().optional(),
  quantity: z.number().int().min(0).optional(),
  quantity_purchased: z.number().int().min(0).optional(),
  weight_oz: z.number().min(0).nullable().optional(),
  location: z.string().optional(),
  source: z.string().optional(),
  sourced_at: z.string().nullable().optional(),
  status: z.enum(["draft", "active", "sold", "archived"]).optional(),
  notes: z.string().optional(),
});

function nextSku(db: Db) {
  const prefix = getSetting(db, "skuPrefix", "FD");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n + 1;
  let sku = `${prefix}-${String(n).padStart(5, "0")}`;
  while (db.prepare("SELECT 1 FROM items WHERE sku = ?").get(sku)) sku = `${prefix}-${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
  return sku;
}

export function extensionToken(db: Db) {
  if (process.env.FLIPDESK_TOKEN && process.env.FLIPDESK_TOKEN !== "change-me") return process.env.FLIPDESK_TOKEN;
  let t = getSetting<string | null>(db, "extensionToken", null);
  if (!t) {
    t = crypto.randomBytes(18).toString("base64url");
    setSetting(db, "extensionToken", t);
  }
  return t;
}

export function createApp(db: Db, opts: { uploadDir?: string } = {}) {
  const uploadDir = opts.uploadDir ?? "data/uploads";
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname).toLowerCase() || ".jpg"}`),
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 24 },
    fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // CORS only for the Chrome extension endpoints + photos it needs to upload.
  app.use(["/api/ext", "/uploads"], (req, res, next) => {
    const origin = req.headers.origin ?? "";
    if (origin.startsWith("chrome-extension://") || /^https:\/\/([a-z0-9-]+\.)*(poshmark|mercari|depop|vinted|grailed|facebook|whatnot)\.com$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FlipDesk-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });
  app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

  const api = express.Router();
  app.use("/api", api);

  // ---------------- Optional password (required when reachable from your phone/LAN) ----------------
  const password = process.env.FLIPDESK_PASSWORD;
  const sessionValue = password ? crypto.createHmac("sha256", password).update("flipdesk-session").digest("base64url") : "";
  const readCookie = (req: Request, name: string) =>
    (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
  api.post("/login", (req, res) => {
    if (!password) return void res.json({ ok: true });
    const given = String(req.body?.password ?? "");
    const ok = given.length === password.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password));
    if (!ok) return void res.status(401).json({ error: "Wrong password" });
    res.setHeader("Set-Cookie", `fd_session=${sessionValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    res.json({ ok: true });
  });
  api.use((req, res, next) => {
    if (!password || req.path.startsWith("/ext/") || req.path === "/health") return next();
    if (readCookie(req, "fd_session") === sessionValue) return next();
    res.status(401).json({ error: "login required" });
  });

  api.get("/health", (_req, res) => {
    res.json({ ok: true, imap: imapConfigured(), ai: aiIsLive() ? "live" : "demo", ebay: ebayIsLive(db) ? "live" : ebayHasAppKeys() ? "keys-only" : "demo" });
  });

  api.get("/dashboard", (_req, res) => void res.json(dashboard(db)));
  api.get("/reports", (req, res) => void res.json(profitReport(db, Number(req.query.days ?? 365))));

  // ---------------- Items ----------------
  api.get("/items", (req, res) => {
    const { status, q, marketplace } = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (status && status !== "all") (where.push("i.status = ?"), args.push(status));
    if (q) {
      where.push("(i.title LIKE ? OR i.sku LIKE ? OR i.brand LIKE ? OR i.location LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (marketplace) (where.push("EXISTS (SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.marketplace = ? AND l.status = 'active')"), args.push(marketplace));
    const rows = db
      .prepare(`SELECT i.* FROM items i ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.updated_at DESC, i.id DESC LIMIT 500`)
      .all(...args) as unknown as ItemRow[];
    res.json(rows.map((r) => hydrateItem(db, r)));
  });

  api.post("/items", (req, res) => {
    const body = ItemInput.parse(req.body);
    const sku = body.sku ?? nextSku(db);
    const r = db
      .prepare(
        `INSERT INTO items (sku, title, description, brand, category, condition, color, size, specifics, keywords, cost, price, min_price, quantity, quantity_purchased, weight_oz, location, source, sourced_at, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sku,
        body.title ?? "",
        body.description ?? "",
        body.brand ?? "",
        body.category ?? "",
        body.condition ?? "used_good",
        body.color ?? "",
        body.size ?? "",
        JSON.stringify(body.specifics ?? {}),
        JSON.stringify(body.keywords ?? []),
        body.cost ?? 0,
        body.price ?? 0,
        body.min_price ?? null,
        body.quantity ?? 1,
        body.quantity_purchased ?? Math.max(body.quantity ?? 1, 1),
        body.weight_oz ?? null,
        body.location ?? "",
        body.source ?? "",
        body.sourced_at ?? null,
        body.status ?? "draft",
        body.notes ?? "",
      );
    const id = Number(r.lastInsertRowid);
    logActivity(db, "created", `Created ${sku}`, id);
    res.status(201).json(getItem(db, id));
  });

  api.get("/items/:id", (req, res) => {
    const item = getItem(db, Number(req.params.id));
    if (!item) return void res.status(404).json({ error: "Not found" });
    res.json(item);
  });

  api.patch("/items/:id", (req, res) => {
    const id = Number(req.params.id);
    const item = getItem(db, id);
    if (!item) return void res.status(404).json({ error: "Not found" });
    const body = ItemInput.parse(req.body);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(k === "specifics" || k === "keywords" ? JSON.stringify(v) : (v as string | number | null));
    }
    if (sets.length) db.prepare(`UPDATE items SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...args, id);
    if (body.quantity !== undefined && body.quantity !== item.quantity) {
      for (const l of item.listings.filter((x) => x.status === "active")) {
        const want = listingQty(l.marketplace as MarketplaceId, body.quantity);
        if (body.quantity === 0) requestDelist(db, l, "quantity set to 0");
        else if (want !== l.quantity) {
          db.prepare("UPDATE listings SET quantity = ? WHERE id = ?").run(want, l.id);
          enqueue(db, l.marketplace as MarketplaceId, "update", id, l.id);
        }
      }
      void processApiJobs(db);
    }
    res.json(getItem(db, id));
  });

  api.delete("/items/:id", (req, res) => {
    db.prepare("DELETE FROM items WHERE id = ?").run(Number(req.params.id));
    res.status(204).end();
  });

  api.post("/items/:id/photos", upload.array("photos", 24), (req, res) => {
    const id = Number(req.params.id);
    if (!getItem(db, id)) return void res.status(404).json({ error: "Not found" });
    const files = (req.files as Express.Multer.File[]) ?? [];
    const start = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM photos WHERE item_id = ?").get(id) as { p: number }).p;
    files.forEach((f, i) => db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, ?)").run(id, f.path, start + i));
    res.json(getItem(db, id));
  });

  api.post("/items/:id/photos/order", (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number()) }).parse(req.body);
    ids.forEach((pid, i) => db.prepare("UPDATE photos SET position = ? WHERE id = ? AND item_id = ?").run(i, pid, Number(req.params.id)));
    res.json(getItem(db, Number(req.params.id)));
  });

  api.delete("/photos/:id", (req, res) => {
    const p = db.prepare("SELECT * FROM photos WHERE id = ?").get(Number(req.params.id)) as { path: string } | undefined;
    if (p && !p.path.startsWith("http")) fs.rmSync(p.path, { force: true });
    db.prepare("DELETE FROM photos WHERE id = ?").run(Number(req.params.id));
    res.status(204).end();
  });

  // ---------------- AI + pricing ----------------
  api.post("/ai/generate", upload.array("photos", 8), async (req, res) => {
    const itemId = req.body.itemId ? Number(req.body.itemId) : undefined;
    let photoPaths = ((req.files as Express.Multer.File[]) ?? []).map((f) => f.path);
    if (!photoPaths.length && itemId) {
      photoPaths = (db.prepare("SELECT path FROM photos WHERE item_id = ? ORDER BY position").all(itemId) as { path: string }[])
        .map((p) => p.path)
        .filter((p) => !p.startsWith("http") && /\.(jpe?g|png|webp|gif)$/i.test(p) && fs.existsSync(p));
    }
    const hint = typeof req.body.hint === "string" ? req.body.hint : undefined;
    if (!photoPaths.length && !hint) return void res.status(400).json({ error: "Add at least one photo or a short description." });
    const comps = hint ? (await researchPrice(db, hint)).comps : [];
    const cost = req.body.cost ? Number(req.body.cost) : undefined;
    const result = await generateListing({ photoPaths, hint, cost, comps: comps.some((c) => c.source !== "demo") ? comps : undefined });
    res.json({ ...result, uploaded: photoPaths });
  });

  api.get("/pricing", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return void res.status(400).json({ error: "q required" });
    res.json(await researchPrice(db, q));
  });

  api.get("/items/:id/recommend", (req, res) => {
    const item = getItem(db, Number(req.params.id));
    if (!item) return void res.status(404).json({ error: "Not found" });
    const shipping = Number(req.query.shipping ?? getSetting(db, "defaultShippingCost", 0));
    res.json(recommend(item, getSetting(db, "feeOverrides", {}), shipping));
  });

  api.get("/fees", (req, res) => {
    const price = Number(req.query.price ?? 0);
    const cost = Number(req.query.cost ?? 0);
    const shippingCost = Number(req.query.shipping ?? 0);
    const o = getSetting(db, "feeOverrides", {});
    res.json(MARKETPLACE_IDS.map((m) => breakdown(m, { price, cost, shippingCost }, o)));
  });

  // ---------------- Crosslisting ----------------
  api.post("/items/:id/crosslist", async (req, res) => {
    const { marketplaces, prices } = z
      .object({ marketplaces: z.array(MarketplaceEnum).min(1), prices: z.record(z.string(), z.number()).optional() })
      .parse(req.body);
    const out = crosslist(db, Number(req.params.id), marketplaces, prices as Partial<Record<MarketplaceId, number>>);
    await processApiJobs(db);
    res.json({ queued: out, item: getItem(db, Number(req.params.id)) });
  });

  api.post("/bulk/crosslist", async (req, res) => {
    const { itemIds, marketplaces } = z.object({ itemIds: z.array(z.number()).min(1), marketplaces: z.array(MarketplaceEnum).min(1) }).parse(req.body);
    let n = 0;
    for (const id of itemIds) n += crosslist(db, id, marketplaces).length;
    await processApiJobs(db, 50);
    res.json({ queued: n });
  });

  api.post("/listings/:id/delist", async (req, res) => {
    const l = db.prepare("SELECT * FROM listings WHERE id = ?").get(Number(req.params.id)) as ListingRow | undefined;
    if (!l) return void res.status(404).json({ error: "Not found" });
    requestDelist(db, l);
    await processApiJobs(db);
    res.json(getItem(db, l.item_id));
  });

  api.post("/items/:id/sold", async (req, res) => {
    const b = z
      .object({
        marketplace: MarketplaceEnum,
        salePrice: z.number().positive(),
        shippingCharged: z.number().min(0).optional(),
        shippingCost: z.number().min(0).optional(),
        fees: z.number().min(0).optional(),
        quantity: z.number().int().min(1).optional(),
        variationId: z.number().int().optional(),
        listingId: z.number().int().optional(),
        buyer: z.string().optional(),
        orderId: z.string().optional(),
      })
      .parse(req.body);
    const r = recordSale(db, { itemId: Number(req.params.id), ...b });
    await processApiJobs(db);
    res.json({ ...r, item: getItem(db, Number(req.params.id)) });
  });

  api.post("/items/:id/restock", async (req, res) => {
    const b = z.object({ units: z.number().int().min(1), unitCost: z.number().min(0).optional(), variationId: z.number().int().optional() }).parse(req.body);
    const item = restock(db, Number(req.params.id), b.units, b.unitCost, b.variationId);
    await processApiJobs(db);
    res.json(item);
  });

  api.put("/items/:id/variations", async (req, res) => {
    const { variations } = z
      .object({
        variations: z.array(
          z.object({
            id: z.number().int().optional(),
            attrs: z.record(z.string(), z.string()),
            quantity: z.number().int().min(0),
            quantity_purchased: z.number().int().min(0).optional(),
            price: z.number().min(0).nullable().optional(),
          }),
        ),
      })
      .parse(req.body);
    const item = saveVariations(db, Number(req.params.id), variations);
    await processApiJobs(db);
    res.json(item);
  });

  // ---------------- Sourcing mode ----------------
  api.post("/source/check", upload.single("photo"), async (req, res) => {
    const askPrice = req.body.askPrice !== undefined && req.body.askPrice !== "" ? Number(req.body.askPrice) : undefined;
    const query = typeof req.body.q === "string" ? req.body.q.trim() : undefined;
    const photo = (req.file as Express.Multer.File | undefined)?.path;
    if (!photo && !query) return void res.status(400).json({ error: "Snap a photo or type what it is." });
    const r = await checkItem(db, { photoPath: photo, query, askPrice });
    res.json({ ...r, photo: photo ? path.basename(photo) : null });
  });

  api.post("/source/buy", async (req, res) => {
    const b = z
      .object({
        name: z.string().min(1),
        brand: z.string().optional(),
        category: z.string().optional(),
        cost: z.number().min(0),
        quantity: z.number().int().min(1).default(1),
        price: z.number().min(0).optional(),
        source: z.string().optional(),
        photo: z.string().nullable().optional(),
        notes: z.string().optional(),
      })
      .parse(req.body);
    const id = Number(
      db
        .prepare(
          `INSERT INTO items (sku, title, brand, category, cost, price, quantity, quantity_purchased, source, sourced_at, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), 'draft', ?)`,
        )
        .run(nextSku(db), b.name, b.brand ?? "", b.category ?? "", b.cost, b.price ?? 0, b.quantity, b.quantity, b.source ?? "", b.notes ?? "")
        .lastInsertRowid,
    );
    if (b.photo) {
      const file = path.join(uploadDir, path.basename(b.photo)); // basename: no path traversal
      if (fs.existsSync(file)) db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, 0)").run(id, file);
    }
    logActivity(db, "sourced", `Bought ${b.quantity > 1 ? b.quantity + "x " : ""}${b.name} for $${b.cost.toFixed(2)}${b.source ? ` at ${b.source}` : ""}`, id);
    res.status(201).json(getItem(db, id));
  });

  // ---------------- Sold comps library (Terapeak etc) ----------------
  const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  api.post("/comps/import", memUpload.single("file"), (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose a CSV file." });
    const source = typeof req.body.source === "string" && req.body.source ? req.body.source : "terapeak";
    const label = typeof req.body.batch === "string" && req.body.batch ? req.body.batch : `${req.file.originalname} ${new Date().toISOString().slice(0, 10)}`;
    const r = importComps(db, req.file.buffer.toString("utf8"), source, label);
    logActivity(db, "import", `Imported ${r.imported} sold comps (${label})`);
    res.json(r);
  });
  api.get("/comps", (_req, res) => void res.json(compsLibrary(db)));
  api.delete("/comps/batch", (req, res) => {
    db.prepare("DELETE FROM sold_comps WHERE batch = ?").run(String(req.query.batch ?? ""));
    res.status(204).end();
  });

  // ---------------- Sale emails ----------------
  api.get("/emails", (req, res) => {
    const status = String(req.query.status ?? "review");
    const rows = db
      .prepare(`SELECT * FROM sale_emails ${status === "all" ? "" : "WHERE status = ?"} ORDER BY id DESC LIMIT 100`)
      .all(...(status === "all" ? [] : [status])) as Record<string, unknown>[];
    res.json({ imap: imapConfigured(), emails: rows.map((r) => ({ ...r, parsed: JSON.parse(String(r.parsed || "{}")) })) });
  });
  api.post("/emails/:id/confirm", async (req, res) => {
    const b = z.object({ itemId: z.number().int(), variationId: z.number().int().optional(), salePrice: z.number().positive(), quantity: z.number().int().min(1).optional() }).parse(req.body);
    const r = confirmEmail(db, Number(req.params.id), b);
    await processApiJobs(db);
    res.json(r);
  });
  api.post("/emails/:id/ignore", (req, res) => {
    db.prepare("UPDATE sale_emails SET status = 'ignored' WHERE id = ?").run(Number(req.params.id));
    db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE kind = 'email_review' AND json_extract(data, '$.emailId') = ? AND resolved_at IS NULL").run(Number(req.params.id));
    res.json({ ok: true });
  });
  // Paste an email to see what FlipDesk would do (records nothing).
  api.post("/emails/test", (req, res) => {
    const b = z.object({ from: z.string(), subject: z.string().default(""), text: z.string().default("") }).parse(req.body);
    res.json(ingestEmail(db, b, { dryRun: true }));
  });

  // ---------------- Alerts ----------------
  api.get("/alerts", (req, res) => {
    const all = req.query.all === "1";
    res.json(
      db
        .prepare(`SELECT a.*, i.sku, i.title AS item_title FROM alerts a LEFT JOIN items i ON i.id = a.item_id ${all ? "" : "WHERE a.resolved_at IS NULL"} ORDER BY a.id DESC LIMIT 200`)
        .all()
        .map((r) => ({ ...(r as Record<string, unknown>), data: JSON.parse(((r as Record<string, unknown>).data as string) || "{}") })),
    );
  });
  api.post("/alerts/:id/resolve", (req, res) => {
    db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
    res.json({ ok: true });
  });
  api.post("/notify/test", async (_req, res) => {
    const ok = await notify(db, "sale", "FlipDesk test", "Push notifications are working!");
    res.status(ok ? 200 : 400).json({ ok, error: ok ? undefined : "Set an ntfy topic in Settings first (or the push failed)." });
  });

  api.get("/sales", (req, res) => {
    const days = Number(req.query.days ?? 365);
    res.json(
      db
        .prepare(
          `SELECT s.*, i.sku, i.title, (SELECT path FROM photos p WHERE p.item_id = i.id ORDER BY position LIMIT 1) AS photo
           FROM sales s JOIN items i ON i.id = s.item_id
           WHERE s.sold_at >= datetime('now', ?) ORDER BY s.sold_at DESC`,
        )
        .all(`-${days} days`)
        .map((r) => {
          const row = r as Record<string, unknown>;
          const photo = row.photo as string | null;
          return { ...row, photo: photo ? (photo.startsWith("http") ? photo : `/uploads/${path.basename(photo)}`) : null };
        }),
    );
  });

  api.get("/jobs", (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT j.*, i.sku, i.title FROM jobs j JOIN items i ON i.id = j.item_id
           ORDER BY CASE j.status WHEN 'pending' THEN 0 WHEN 'claimed' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, j.id DESC LIMIT 200`,
        )
        .all(),
    );
  });
  api.post("/jobs/process", async (_req, res) => void res.json({ processed: await processApiJobs(db, 100) }));
  api.post("/jobs/:id/retry", (req, res) => {
    db.prepare("UPDATE jobs SET status = 'pending', attempts = 0 WHERE id = ? AND status = 'failed'").run(Number(req.params.id));
    res.json({ ok: true });
  });

  api.get("/activity", (_req, res) => void res.json(db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 100").all()));

  // ---------------- Marketplaces & connections ----------------
  api.get("/marketplaces", (_req, res) => {
    const conns = Object.fromEntries(
      (db.prepare("SELECT marketplace, status, username, connected_at FROM connections").all() as {
        marketplace: string;
        status: string;
        username: string | null;
        connected_at: string | null;
      }[]).map((c) => [c.marketplace, c]),
    );
    const counts = Object.fromEntries(
      (db.prepare("SELECT marketplace, COUNT(*) AS n FROM listings WHERE status = 'active' GROUP BY marketplace").all() as { marketplace: string; n: number }[]).map(
        (r) => [r.marketplace, r.n],
      ),
    );
    res.json(
      MARKETPLACE_IDS.map((id) => ({
        ...MARKETPLACES[id],
        connection: conns[id] ?? { status: "disconnected" },
        live: adapterFor(id).isLive(db),
        activeListings: counts[id] ?? 0,
      })),
    );
  });

  api.post("/connections/:m", (req, res) => {
    const m = req.params.m;
    if (!isMarketplaceId(m)) return void res.status(404).json({ error: "Unknown marketplace" });
    const { status, username } = z.object({ status: z.enum(["connected", "disconnected"]), username: z.string().optional() }).parse(req.body);
    db.prepare(
      `INSERT INTO connections (marketplace, status, username, connected_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(marketplace) DO UPDATE SET status = excluded.status, username = COALESCE(excluded.username, connections.username)`,
    ).run(m, status, username ?? null);
    res.json({ ok: true });
  });

  api.get("/connections/ebay/auth-url", (_req, res) => {
    if (!ebayHasAppKeys()) return void res.status(400).json({ error: "Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RU_NAME to .env first." });
    const state = crypto.randomBytes(12).toString("hex");
    setSetting(db, "ebay.oauthState", state);
    res.json({ url: ebayConsentUrl(state) });
  });

  // Set this URL as your RuName "auth accepted URL" in the eBay developer portal.
  api.get("/connections/ebay/callback", async (req, res) => {
    const { code, state } = req.query as Record<string, string>;
    if (!code || state !== getSetting(db, "ebay.oauthState", "")) return void res.status(400).send("Invalid OAuth state");
    await ebayExchangeCode(db, code);
    logActivity(db, "connected", "Connected eBay account");
    res.redirect("/connections?ebay=connected");
  });

  api.get("/ebay/policies", async (_req, res) => {
    if (!ebayIsLive(db)) return void res.status(400).json({ error: "Connect eBay first." });
    res.json(await fetchPolicies(db));
  });

  // ---------------- eBay power tools ----------------
  api.get("/tools/stale", (req, res) => void res.json(staleListings(db, Number(req.query.days ?? 30))));
  api.post("/tools/bulk-price", (req, res) => {
    const b = z.object({ itemIds: z.array(z.number()).min(1), pct: z.number().optional(), amount: z.number().optional(), set: z.number().optional() }).parse(req.body);
    const r = bulkPrice(db, b.itemIds, b);
    void processApiJobs(db, 100);
    res.json(r);
  });
  api.post("/tools/send-offers", async (req, res) => {
    const b = z.object({ itemIds: z.array(z.number()).min(1), pctOff: z.number().min(1).max(80), message: z.string().default("Thanks for watching! Here's a special offer just for you.") }).parse(req.body);
    res.json(await sendOffersToWatchers(db, b.itemIds, b.pctOff, b.message));
  });
  api.post("/tools/relist", async (req, res) => {
    const { listingIds } = z.object({ listingIds: z.array(z.number()).min(1) }).parse(req.body);
    const n = relist(db, listingIds);
    await processApiJobs(db, 100);
    res.json({ relisted: n });
  });

  // ---------------- Settings ----------------
  const SETTING_KEYS = ["notify", "minutesPerItem", "sourcing", "feeOverrides", "defaultShippingCost", "skuPrefix", "autoDrop", "ebay", "etsy", "defaultMarketplaces", "descriptionFooter"];
  api.get("/settings", (_req, res) => {
    res.json({
      ...Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k, null)])),
      extensionToken: extensionToken(db),
      status: { ai: aiIsLive(), ebayKeys: ebayHasAppKeys(), ebayLive: ebayIsLive(db) },
    });
  });
  api.put("/settings", (req, res) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    tx(db, () => {
      for (const [k, v] of Object.entries(body)) if (SETTING_KEYS.includes(k)) setSetting(db, k, v);
    });
    res.json({ ok: true });
  });

  // ---------------- Expenses & exports ----------------
  api.get("/expenses", (_req, res) => void res.json(db.prepare("SELECT * FROM expenses ORDER BY date DESC, id DESC").all()));
  api.post("/expenses", (req, res) => {
    const b = z.object({ date: z.string().optional(), category: z.string(), amount: z.number(), note: z.string().optional() }).parse(req.body);
    db.prepare("INSERT INTO expenses (date, category, amount, note) VALUES (COALESCE(?, date('now')), ?, ?, ?)").run(b.date ?? null, b.category, b.amount, b.note ?? "");
    res.status(201).json({ ok: true });
  });
  api.delete("/expenses/:id", (req, res) => {
    db.prepare("DELETE FROM expenses WHERE id = ?").run(Number(req.params.id));
    res.status(204).end();
  });

  api.get("/export/:kind.csv", (req, res) => {
    const year = String(req.query.year ?? new Date().getFullYear());
    let rows: Record<string, unknown>[];
    if (req.params.kind === "sales") {
      rows = db
        .prepare(
          `SELECT s.sold_at AS date, i.sku, i.title, s.marketplace, s.order_id, s.quantity, s.sale_price, s.shipping_charged, s.fees, s.shipping_cost, s.cost AS cost_of_goods, s.profit
           FROM sales s JOIN items i ON i.id = s.item_id WHERE strftime('%Y', s.sold_at) = ? ORDER BY s.sold_at`,
        )
        .all(year) as Record<string, unknown>[];
    } else if (req.params.kind === "inventory") {
      rows = db
        .prepare(`SELECT sku, title, brand, category, condition, quantity_purchased, (SELECT COALESCE(SUM(quantity),0) FROM sales s WHERE s.item_id = items.id) AS quantity_sold, quantity AS quantity_left, cost AS unit_cost, price, location, source, sourced_at, status, created_at FROM items ORDER BY id`)
        .all() as Record<string, unknown>[];
    } else if (req.params.kind === "expenses") {
      rows = db.prepare("SELECT date, category, amount, note FROM expenses WHERE strftime('%Y', date) = ? ORDER BY date").all(year) as Record<string, unknown>[];
    } else return void res.status(404).end();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="flipdesk-${req.params.kind}-${year}.csv"`);
    res.send(toCsv(rows));
  });

  // ---------------- Chrome extension API (token auth) ----------------
  const ext = express.Router();
  api.use("/ext", ext);
  ext.use((req, res, next) => {
    if (req.headers["x-flipdesk-token"] !== extensionToken(db)) return void res.status(401).json({ error: "Bad extension token" });
    next();
  });
  ext.get("/ping", (_req, res) => void res.json({ ok: true }));
  ext.get("/next", (req, res) => {
    const ms = String(req.query.m ?? "")
      .split(",")
      .filter(isMarketplaceId);
    const footer = getSetting(db, "descriptionFooter", "");
    const job = claimExtensionJob(db, ms);
    if (job?.item && footer) job.item.description = `${job.item.description}\n\n${footer}`;
    res.json(job);
  });
  ext.post("/jobs/:id/complete", (req, res) => {
    const b = z.object({ ok: z.boolean(), externalId: z.string().optional(), url: z.string().optional(), error: z.string().optional() }).parse(req.body);
    completeJob(db, Number(req.params.id), b.ok, b);
    res.json({ ok: true });
  });
  // Forwarded sale emails (mail rules, Zapier, Cloudflare Email Workers...): raw RFC822 or JSON.
  ext.post("/email", express.text({ type: ["text/plain", "message/rfc822"], limit: "5mb" }), async (req, res) => {
    let input: { messageId?: string | null; from: string; subject: string; text: string; date?: string | null };
    if (typeof req.body === "string") {
      const mail = await simpleParser(req.body);
      input = {
        messageId: mail.messageId ?? null,
        from: mail.from?.value?.[0]?.address ?? "",
        subject: mail.subject ?? "",
        text: mail.text ?? (typeof mail.html === "string" ? mail.html.replace(/<[^>]+>/g, " ") : ""),
        date: mail.date ? mail.date.toISOString().replace("T", " ").slice(0, 19) : null,
      };
    } else {
      input = z.object({ messageId: z.string().nullable().optional(), from: z.string(), subject: z.string().default(""), text: z.string().default(""), date: z.string().nullable().optional() }).parse(req.body);
    }
    const r = ingestEmail(db, input);
    await processApiJobs(db);
    res.json(r);
  });

  // Extension reports a sale it saw on a marketplace (sold page / notification).
  ext.post("/sold", async (req, res) => {
    const b = z.object({ marketplace: MarketplaceEnum, externalId: z.string().optional(), sku: z.string().optional(), salePrice: z.number().positive(), quantity: z.number().int().min(1).optional(), orderId: z.string().optional() }).parse(req.body);
    const row = b.externalId
      ? (db.prepare("SELECT item_id AS id FROM listings WHERE marketplace = ? AND external_id = ?").get(b.marketplace, b.externalId) as { id: number } | undefined)
      : (db.prepare("SELECT id FROM items WHERE sku = ?").get(b.sku ?? "") as { id: number } | undefined);
    if (!row) return void res.status(404).json({ error: "No matching item" });
    const listing = b.externalId
      ? (db.prepare("SELECT id FROM listings WHERE marketplace = ? AND external_id = ?").get(b.marketplace, b.externalId) as { id: number } | undefined)
      : undefined;
    const r = recordSale(db, { itemId: row.id, listingId: listing?.id, marketplace: b.marketplace, salePrice: b.salePrice, quantity: b.quantity, orderId: b.orderId });
    await processApiJobs(db);
    res.json(r);
  });

  // ---------------- Errors ----------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return void res.status(400).json({ error: "Invalid input", issues: err.issues });
    if (err instanceof NeedsVariationError) return void res.status(409).json({ error: err.message, variations: err.options });
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api]", message);
    res.status(500).json({ error: message });
  });

  return app;
}
