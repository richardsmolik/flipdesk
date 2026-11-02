import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getItem, getSetting, hydrateItem, hydrateItems, logActivity, setSetting, tx, type Db, type ItemRow, type JobRow, type ListingRow } from "./db.js";
import { getProblem, listProblems, problemForJob, saveProblem } from "./services/replay.js";
import { ebaySmokeTest, runWeeklyEbay, weeklyEbay } from "./services/ebaySmoke.js";
import { MARKETPLACES, MARKETPLACE_IDS, isMarketplaceId, type MarketplaceId } from "./marketplaces/registry.js";
import { adapterFor } from "./marketplaces/adapters.js";
import { accountDeletionChallenge, ebayRequiredAspects, suggestCategory, ebayConsentUrl, ebayCreateLocation, ebayEnvironment, ebayExchangeCode, ebayHasAppKeys, ebayIsLive, ebayLocations, ebayOptInBusinessPolicies, ebayOptedInPrograms, fetchPolicies, parseEbayRedirect } from "./marketplaces/ebay.js";
import { aiIsLive, generateListing } from "./services/ai.js";
import { breakdown, recommend } from "./services/fees.js";
import { claimExtensionJob, completeJob, crosslist, enqueue, listingQty, processApiJobs, requestDelist } from "./services/jobs.js";
import { researchPrice } from "./services/pricing.js";
import { NeedsVariationError, cancelSale, recordSale, restock, saveVariations } from "./services/sync.js";
import { bulkPrice, relist, sendOffersToWatchers, staleListings } from "./services/ebayTools.js";
import { dashboard, toCsv } from "./services/reports.js";
import { notify } from "./services/alerts.js";
import { compsLibrary, importComps } from "./services/comps.js";
import { checkItem } from "./services/sourcing.js";
import { isImageUpload, normalizeUploads } from "./services/uploads.js";
import { importInventory, previewInventory } from "./services/inventoryImport.js";
import { findDuplicates } from "./services/duplicates.js";
import { onboarding, saveProfile } from "./services/onboarding.js";
import { goalProgress, saveGoals } from "./services/goals.js";
import { firstWeek, startFirstWeek } from "./services/firstWeek.js";
import { candidates, skipToday, today } from "./services/today.js";
import { aiStatus, scheduleAutoWrite } from "./services/autowrite.js";
import { importSales, previewSales } from "./services/salesImport.js";
import { checkUploadToken, createUploadToken, MAX_PER_TOKEN, phoneAddresses } from "./services/phone.js";
import { advise, learn, recordPriceChange } from "./services/priceAdvice.js";
import { diagnose, importTrafficCsv, latestTraffic, syncEbayTraffic } from "./services/traffic.js";
import { adviceToOps, aiAdvice, capabilities as photoCaps, editPhoto, retouchPhoto, revertPhoto, type EditOp } from "./services/photos.js";
import { buyLabel, getRates, shippoLive } from "./services/shippo.js";
import { deleteTrip, logTrip, mileageSummary, savePlace } from "./services/mileage.js";
import { parseAddress, pirateShipExport, pirateShipImport, providerFor, syncEbayLabelCosts, toShip, updateShipping } from "./services/shipping.js";
import { buildDigest, sendDigest } from "./services/digest.js";
import { bundleParts, createBundle, createMultiBuy, endPromotion, suggestBundles } from "./services/bundles.js";
import { lookupBarcode, specificKeyFor, normalizeCode } from "./services/barcode.js";
import { profitReport } from "./services/insights.js";
import { confirmEmail, imapConfigured, ingestEmail } from "./services/email.js";
import { simpleParser } from "mailparser";
import { currentWorkspace, enterWorkspace, personalEnv, uploadUrl, type WorkspaceContext } from "./context.js";
import { touch } from "./health.js";

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
  if (personalEnv("FLIPDESK_TOKEN") && personalEnv("FLIPDESK_TOKEN") !== "change-me") return personalEnv("FLIPDESK_TOKEN")!;
  const prefix = currentWorkspace()?.tokenPrefix ?? "";
  let t = getSetting<string | null>(db, "extensionToken", null);
  if (!t || (prefix && !t.startsWith(prefix))) {
    t = prefix + crypto.randomBytes(18).toString("base64url");
    setSetting(db, "extensionToken", t);
  }
  return t;
}

export function createApp(db: Db, opts: { uploadDir?: string; password?: string; workspace?: WorkspaceContext } = {}) {
  const uploadDir = opts.uploadDir ?? "data/uploads";
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".jpg"}`),
    }),
    limits: { fileSize: 30 * 1024 * 1024, files: 60 },
    fileFilter: (_req, file, cb) => cb(null, isImageUpload(file)), // HEIC often arrives as application/octet-stream
  });

  const app = express();
  // Several shops on one server: every request to this app runs "inside" its shop (see context.ts).
  if (opts.workspace) app.use(enterWorkspace(opts.workspace));
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

  // Phone upload links (token-only; works without logging in on the phone).
  app.get("/api/m/:token", (req, res) => {
    try {
      const t = checkUploadToken(db, String(req.params.token));
      const item = getItem(db, t.item_id)!;
      const ai = aiStatus(db, item.id);
      res.json({ title: item.title || "New item", sku: item.sku, price: item.price, photos: item.photos.map((p) => p.url), expiresAt: t.expires_at, remaining: MAX_PER_TOKEN - t.uploads, ai: ai.state });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
    }
  });
  app.post("/api/m/:token/photos", (req, res, next) => {
    try {
      checkUploadToken(db, String(req.params.token));
      next();
    } catch (e) {
      res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
    }
  }, upload.array("photos", 20), normalizeUploads, (req, res) => {
    const t = checkUploadToken(db, String(req.params.token));
    const files = ((req.files as Express.Multer.File[]) ?? []).slice(0, Math.max(0, MAX_PER_TOKEN - t.uploads));
    const start = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM photos WHERE item_id = ?").get(t.item_id) as { p: number }).p;
    files.forEach((f, i) => db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, ?)").run(t.item_id, f.path, start + i));
    db.prepare("UPDATE upload_tokens SET uploads = uploads + ? WHERE token = ?").run(files.length, t.token);
    db.prepare("UPDATE items SET updated_at = datetime('now') WHERE id = ?").run(t.item_id);
    const autoWriting = files.length ? scheduleAutoWrite(db, t.item_id) : false;
    res.json({ autoWriting, added: files.length, total: (db.prepare("SELECT COUNT(*) AS n FROM photos WHERE item_id = ?").get(t.item_id) as { n: number }).n });
  });

  // eBay Marketplace Account Deletion notifications (required for production keysets when hosted). No login: eBay calls it.
  app.get("/api/ebay/account-deletion", async (req, res) => {
    const code = String(req.query.challenge_code ?? "");
    if (!code) return void res.status(400).end();
    res.json({ challengeResponse: await accountDeletionChallenge(code) });
  });
  app.post("/api/ebay/account-deletion", (req, res) => {
    const username = (req.body as { notification?: { data?: { username?: string } } })?.notification?.data?.username;
    if (username) {
      // Forget that eBay user's personal data: buyer name and shipping address on their orders.
      db.prepare("UPDATE sales SET buyer = NULL, ship_to = NULL WHERE marketplace = 'ebay' AND buyer = ?").run(username);
      logActivity(db, "privacy", "Removed an eBay buyer's personal data at eBay's request");
    }
    res.status(200).end();
  });

  const api = express.Router();
  app.use("/api", api);

  // ---------------- Optional password (required when reachable from your phone/LAN) ----------------
  // Hosted for several people: accounts are checked before a request reaches this shop (see workspaces.ts).
  const password = opts.password !== undefined ? opts.password : process.env.FLIPDESK_PASSWORD;
  const sessionValue = password ? crypto.createHmac("sha256", password).update("flipdesk-session").digest("base64url") : "";
  const readCookie = (req: Request, name: string) =>
    (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
  api.post("/login", (req, res) => {
    if (!password) return void res.json({ ok: true });
    const given = String(req.body?.password ?? "");
    const ok = given.length === password.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password));
    if (!ok) return void res.status(401).json({ error: "Wrong password" });
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `fd_session=${sessionValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
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
  api.get("/onboarding", (_req, res) => void res.json(onboarding(db)));
  api.post("/onboarding/profile", (req, res) => {
    const b = z
      .object({ marketplaces: z.array(z.string()).max(11), sells: z.array(z.string()).max(10).default([]), experience: z.enum(["new", "growing", "fulltime"]).default("growing") })
      .parse(req.body);
    saveProfile(db, b as Parameters<typeof saveProfile>[1]);
    res.json(onboarding(db));
  });
  api.post("/onboarding/dismiss", (req, res) => {
    const b = z.object({ dismissed: z.boolean().optional(), checklist: z.boolean().optional() }).parse(req.body ?? {});
    if (b.checklist !== undefined) setSetting(db, "checklistHidden", b.checklist);
    else setSetting(db, "onboardingDismissed", b.dismissed ?? true);
    res.json(onboarding(db));
  });
  api.get("/today", (_req, res) => void res.json(today(db)));
  api.post("/today/skip", (req, res) => {
    skipToday(db, z.object({ key: z.string().max(80) }).parse(req.body).key);
    res.json(today(db));
  });
  api.post("/today/do", (req, res) => {
    const key = z.object({ key: z.string().max(80) }).parse(req.body).key;
    const t = candidates(db).find((c) => c.key === key);
    if (!t?.action) return void res.status(400).json({ error: "Nothing to do automatically for this one" });
    bulkPrice(db, [t.action.itemId], { set: t.action.price }, "today");
    res.json(today(db));
  });
  api.get("/goals", (_req, res) => void res.json(goalProgress(db)));
  api.put("/goals", (req, res) => {
    const n = z.number().min(0).max(1e7).optional();
    saveGoals(db, z.object({ listed: n, sales: n, profit: n }).parse(req.body));
    res.json(goalProgress(db));
  });
  api.get("/nav-counts", (_req, res) => {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    res.json({
      inbox: n("SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL"),
      toShip: n("SELECT COUNT(*) AS n FROM sales WHERE shipped_at IS NULL AND sold_at >= datetime('now','-30 days')"),
      drafts: n("SELECT COUNT(*) AS n FROM items WHERE status = 'draft'"),
      failed: n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= datetime('now','-7 days')"),
    });
  });
  api.get("/reports", (req, res) => {
    if (!getSetting(db, "reportsViewed", false)) setSetting(db, "reportsViewed", true); // first-week step 7
    res.json(profitReport(db, Number(req.query.days ?? 365)));
  });
  api.get("/first-week", (_req, res) => {
    // Starts the first time someone opens the dashboard in a real shop (sample shops are already "lived in").
    if (!opts.workspace?.demo) startFirstWeek(db);
    res.json(firstWeek(db));
  });
  api.post("/first-week/hide", (_req, res) => (setSetting(db, "firstWeekHidden", true), res.json(firstWeek(db))));

  // ---------------- Items ----------------
  api.get("/items", (req, res) => {
    const { status, q, marketplace, view } = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const args: (string | number)[] = [];
    let order = "i.updated_at DESC, i.id DESC";
    const LIVE = "EXISTS (SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.status = 'active')";
    // Views: inventory (everything in stock) | selling (live somewhere) | unsold (live, never sold a unit; oldest first) | drafts | sold
    if (view === "inventory") where.push("i.status IN ('active','draft') AND i.quantity > 0");
    else if (view === "selling") where.push(`i.status = 'active' AND i.quantity > 0 AND ${LIVE}`);
    else if (view === "unsold") {
      where.push(`i.status = 'active' AND i.quantity > 0 AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.item_id = i.id)`);
      order = "(SELECT MIN(l.listed_at) FROM listings l WHERE l.item_id = i.id AND l.status = 'active') ASC";
    } else if (view === "drafts") where.push("i.status = 'draft'");
    else if (view === "sold") {
      where.push("EXISTS (SELECT 1 FROM sales s WHERE s.item_id = i.id)");
      order = "(SELECT MAX(sold_at) FROM sales s WHERE s.item_id = i.id) DESC";
    } else if (status && status !== "all") (where.push("i.status = ?"), args.push(status));
    if (q) {
      where.push("(i.title LIKE ? OR i.sku LIKE ? OR i.brand LIKE ? OR i.location LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (marketplace) (where.push("EXISTS (SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.marketplace = ? AND l.status = 'active')"), args.push(marketplace));
    // Paged: ?limit (default 500, max 5000) & ?offset; X-Total-Count says how many match in all.
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 500));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM items i ${whereSql}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT i.* FROM items i ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as ItemRow[];
    res.setHeader("X-Total-Count", String(total));
    res.json(hydrateItems(db, rows));
  });

  api.get("/items-counts", (_req, res) => {
    const LIVE = "EXISTS (SELECT 1 FROM listings l WHERE l.item_id = i.id AND l.status = 'active')";
    const c = (where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${where}`).get() as { n: number }).n;
    res.json({
      inventory: c("i.status IN ('active','draft') AND i.quantity > 0"),
      selling: c(`i.status = 'active' AND i.quantity > 0 AND ${LIVE}`),
      unsold: c(`i.status = 'active' AND i.quantity > 0 AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.item_id = i.id)`),
      drafts: c("i.status = 'draft'"),
      sold: c("EXISTS (SELECT 1 FROM sales s WHERE s.item_id = i.id)"),
    });
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
    if (body.price !== undefined && body.price !== item.price && item.price > 0) recordPriceChange(db, id, item.price, body.price, "manual");
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

  api.post("/items/:id/photos", upload.array("photos", 24), normalizeUploads, (req, res) => {
    const id = Number(req.params.id);
    if (!getItem(db, id)) return void res.status(404).json({ error: "Not found" });
    const files = (req.files as Express.Multer.File[]) ?? [];
    const start = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM photos WHERE item_id = ?").get(id) as { p: number }).p;
    files.forEach((f, i) => db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, ?)").run(id, f.path, start + i));
    const skipped = (req as typeof req & { skippedUploads?: string[] }).skippedUploads ?? [];
    res.json({ ...getItem(db, id), skippedUploads: skipped });
  });

  api.get("/items/:id/ai-status", (req, res) => void res.json(aiStatus(db, Number(req.params.id))));
  // Shoot mode: write the draft right away (no pause), in the background.
  api.post("/items/:id/auto-write", (req, res) => {
    const id = Number(req.params.id);
    if (!getItem(db, id)) return void res.status(404).json({ error: "Not found" });
    if (scheduleAutoWrite(db, id, 0)) return void res.json({ queued: true });
    res.json({ queued: false, reason: "Item already has a title" });
  });

  api.get("/items/:id/duplicates", async (req, res) => void res.json(await findDuplicates(db, Number(req.params.id))));

  api.post("/items/:id/phone-link", (req, res) => {
    const id = Number(req.params.id);
    if (!getItem(db, id)) return void res.status(404).json({ error: "Not found" });
    res.json({ ...createUploadToken(db, id), ...phoneAddresses() });
  });

  api.post("/items/:id/photos/order", (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number()) }).parse(req.body);
    ids.forEach((pid, i) => db.prepare("UPDATE photos SET position = ? WHERE id = ? AND item_id = ?").run(i, pid, Number(req.params.id)));
    res.json(getItem(db, Number(req.params.id)));
  });

  // ---------------- Photo editor ----------------
  api.get("/photos/capabilities", (_req, res) => void res.json(photoCaps()));
  const Op = z.discriminatedUnion("type", [
    z.object({ type: z.literal("rotate"), deg: z.number().min(-360).max(360) }),
    z.object({ type: z.literal("flip"), axis: z.enum(["h", "v"]) }),
    z.object({ type: z.literal("crop"), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    z.object({ type: z.literal("adjust"), brightness: z.number().optional(), contrast: z.number().optional(), saturation: z.number().optional(), warmth: z.number().optional(), sharpen: z.boolean().optional() }),
    z.object({ type: z.literal("auto") }),
    z.object({ type: z.literal("square"), size: z.number().optional() }),
    z.object({ type: z.literal("removeBackground") }),
  ]);
  api.post("/photos/:id/edit", async (req, res) => {
    const { ops } = z.object({ ops: z.array(Op).min(1).max(20) }).parse(req.body);
    await editPhoto(db, Number(req.params.id), ops as EditOp[], uploadDir);
    const p = db.prepare("SELECT item_id FROM photos WHERE id = ?").get(Number(req.params.id)) as { item_id: number };
    res.json(getItem(db, p.item_id));
  });
  const maskUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  api.post("/photos/:id/retouch", maskUpload.single("mask"), async (req, res) => {
    const tool = z.enum(["removeObject", "fixWrinkles"]).parse(req.body.tool);
    if (!req.file) return void res.status(400).json({ error: "Paint over the area first." });
    const r = await retouchPhoto(db, Number(req.params.id), tool, req.file.buffer, uploadDir);
    const p = db.prepare("SELECT item_id FROM photos WHERE id = ?").get(Number(req.params.id)) as { item_id: number };
    res.json({ ...r, item: getItem(db, p.item_id) });
  });
  api.post("/photos/:id/ai-enhance", async (req, res) => {
    const { allowBackground } = z.object({ allowBackground: z.boolean().default(true) }).parse(req.body ?? {});
    const id = Number(req.params.id);
    const { advice, demo } = await aiAdvice(db, id);
    const caps = photoCaps();
    const ops = demo ? ([{ type: "auto" }] as EditOp[]) : adviceToOps(advice, allowBackground && caps.backgroundRemoval);
    await editPhoto(db, id, ops, uploadDir);
    const p = db.prepare("SELECT item_id FROM photos WHERE id = ?").get(id) as { item_id: number };
    res.json({ advice, demo, applied: ops.map((o) => o.type), backgroundSkipped: advice.remove_background && !caps.backgroundRemoval, item: getItem(db, p.item_id) });
  });
  api.post("/photos/:id/revert", (req, res) => {
    revertPhoto(db, Number(req.params.id));
    const p = db.prepare("SELECT item_id FROM photos WHERE id = ?").get(Number(req.params.id)) as { item_id: number };
    res.json(getItem(db, p.item_id));
  });

  api.delete("/photos/:id", (req, res) => {
    const p = db.prepare("SELECT * FROM photos WHERE id = ?").get(Number(req.params.id)) as { path: string; original_path: string | null } | undefined;
    if (p && !p.path.startsWith("http")) fs.rmSync(p.path, { force: true });
    if (p?.original_path) fs.rmSync(p.original_path, { force: true });
    db.prepare("DELETE FROM photos WHERE id = ?").run(Number(req.params.id));
    res.status(204).end();
  });

  // ---------------- AI + pricing ----------------
  api.post("/ai/generate", upload.array("photos", 8), normalizeUploads, async (req, res) => {
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

  api.post("/sales/:id/cancel", async (req, res) => {
    const b = z
      .object({
        restock: z.boolean().default(false),
        reason: z.string().optional(),
        kind: z.enum(["return", "cancel", "oversell", "partial_refund"]).optional(),
        refund: z.number().min(0).optional(),
        returnShipping: z.number().min(0).optional(),
        feesLost: z.number().min(0).optional(),
      })
      .parse(req.body);
    const item = cancelSale(db, Number(req.params.id), b);
    await processApiJobs(db);
    res.json(item);
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

  const memUploadShip = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  // ---------------- Bins & printing ----------------
  api.get("/bins", (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT TRIM(location) AS name, COUNT(*) AS items, SUM(quantity) AS units, ROUND(SUM(price * quantity), 2) AS value,
                  MAX(CAST(julianday('now') - julianday(COALESCE(sourced_at, created_at)) AS INTEGER)) AS oldest_days
           FROM items WHERE TRIM(location) != '' AND status IN ('active','draft') AND quantity > 0
           GROUP BY TRIM(location) ORDER BY TRIM(location)`,
        )
        .all(),
    );
  });
  api.get("/bins/:name", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM items WHERE TRIM(location) = ? AND status IN ('active','draft') AND quantity > 0 ORDER BY title")
      .all(String(req.params.name).trim()) as unknown as ItemRow[];
    res.json(rows.map((r) => hydrateItem(db, r)));
  });
  // Packing slips / pick list data for sales (default: everything not shipped yet).
  api.get("/print/orders", (req, res) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map(Number)
      .filter(Boolean);
    const rows = db
      .prepare(
        `SELECT s.id, s.marketplace, s.quantity, s.sale_price, s.order_id, s.buyer, s.sold_at, s.ship_to, s.variation_id,
                i.id AS item_id, i.sku, i.title, i.location, i.condition,
                (SELECT path FROM photos p WHERE p.item_id = i.id ORDER BY position LIMIT 1) AS photo,
                (SELECT attrs FROM variations v WHERE v.id = s.variation_id) AS attrs
         FROM sales s JOIN items i ON i.id = s.item_id
         WHERE ${ids.length ? `s.id IN (${ids.map(() => "?").join(",")})` : "s.shipped_at IS NULL AND s.sold_at >= datetime('now','-30 days')"}
         ORDER BY i.location, i.title`,
      )
      .all(...ids) as Record<string, unknown>[];
    res.json({
      shop: getSetting(db, "shop", { name: "", thankYou: "Thank you for your order! If anything isn't right, message me before leaving feedback and I'll make it right." }),
      orders: rows.map((r) => ({
        ...r,
        ship_to: r.ship_to ? JSON.parse(String(r.ship_to)) : null,
        variation: r.attrs ? Object.entries(JSON.parse(String(r.attrs))).map(([k, v]) => `${k}: ${v}`).join(" / ") : null,
        photo: r.photo ? (String(r.photo).startsWith("http") ? r.photo : uploadUrl(String(r.photo))) : null,
      })),
    });
  });

  // ---------------- Shipping ----------------
  api.get("/shipping", (req, res) => {
    res.json({
      rows: toShip(db, Number(req.query.days ?? 30)),
      providers: Object.fromEntries(MARKETPLACE_IDS.map((m) => [m, providerFor(db, m)])),
      ebayLive: ebayIsLive(db),
      shippoLive: shippoLive(),
    });
  });
  api.post("/sales/:id/shipping", (req, res) => {
    const b = z
      .object({ cost: z.number().min(0).optional(), tracking: z.string().optional(), carrier: z.string().optional(), shipped: z.boolean().optional(), address: z.string().optional() })
      .parse(req.body);
    let shipTo;
    if (b.address) {
      shipTo = parseAddress(b.address);
      if (!shipTo) return void res.status(400).json({ error: 'Couldn\'t read that address. Use: name, street, (apt), "City, ST 12345" on separate lines.' });
    }
    res.json(updateShipping(db, Number(req.params.id), { cost: b.cost, tracking: b.tracking || undefined, carrier: b.carrier, shipped: b.shipped, shipTo: shipTo ?? undefined, source: b.cost !== undefined ? "manual" : undefined }));
  });
  api.post("/shipping/pirateship/export", (req, res) => {
    const { saleIds } = z.object({ saleIds: z.array(z.number().int()).min(1) }).parse(req.body);
    const r = pirateShipExport(db, saleIds);
    if (!r.count) return void res.status(400).json({ error: `No addresses yet for: ${r.missing.join(", ")}. Add them first.` });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="pirateship-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("X-Missing-Addresses", r.missing.join(","));
    res.send(r.csv);
  });
  api.post("/shipping/pirateship/import", memUploadShip.single("file"), async (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose your Pirate Ship export CSV." });
    const r = await pirateShipImport(db, req.file.buffer.toString("utf8"));
    res.json(r);
  });
  const Parcel = z.object({ weightOz: z.number().positive().optional(), length: z.number().positive().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() });
  api.post("/sales/:id/rates", async (req, res) => void res.json(await getRates(db, Number(req.params.id), Parcel.parse(req.body ?? {}))));
  api.post("/sales/:id/label", async (req, res) => {
    const { rate } = z.object({ rate: z.object({ id: z.string(), carrier: z.string(), service: z.string(), amount: z.number(), days: z.number().nullable() }) }).parse(req.body);
    res.json(await buyLabel(db, Number(req.params.id), rate));
  });
  api.post("/shipping/ebay-sync", async (_req, res) => void res.json({ updated: await syncEbayLabelCosts(db) }));

  // ---------------- Bundles & promotions ----------------
  api.get("/bundles/suggestions", (req, res) => void res.json(suggestBundles(db, Number(req.query.discount ?? 15))));
  api.post("/bundles", (req, res) => {
    const b = z
      .object({
        parts: z.array(z.object({ itemId: z.number().int(), quantity: z.number().int().min(1).optional() })).min(2),
        title: z.string().optional(),
        price: z.number().positive().optional(),
        discountPct: z.number().min(0).max(80).optional(),
      })
      .parse(req.body);
    res.status(201).json(createBundle(db, b.parts, b));
  });
  api.get("/items/:id/bundle", (req, res) => void res.json(bundleParts(db, Number(req.params.id))));
  api.get("/promotions", (_req, res) => void res.json(db.prepare("SELECT * FROM promotions ORDER BY id DESC LIMIT 50").all()));
  api.post("/promotions/multibuy", async (req, res) => {
    const b = z
      .object({ itemIds: z.array(z.number().int()).min(2), tiers: z.array(z.object({ minQuantity: z.number().int().min(2), pctOff: z.number().min(1).max(80) })).min(1), name: z.string().optional() })
      .parse(req.body);
    res.json(await createMultiBuy(db, b.itemIds, b.tiers, b.name));
  });
  api.post("/promotions/:id/end", async (req, res) => {
    await endPromotion(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------------- Sourcing mode ----------------
  api.post("/source/check", upload.single("photo"), normalizeUploads, async (req, res) => {
    const askPrice = req.body.askPrice !== undefined && req.body.askPrice !== "" ? Number(req.body.askPrice) : undefined;
    const query = typeof req.body.q === "string" ? req.body.q.trim() : undefined;
    const photo = (req.file as Express.Multer.File | undefined)?.path;
    const barcode = typeof req.body.barcode === "string" && req.body.barcode.trim() ? req.body.barcode.trim() : undefined;
    if (!photo && !query && !barcode) return void res.status(400).json({ error: "Scan a barcode, snap a photo or type what it is." });
    const r = await checkItem(db, { photoPath: photo, query, askPrice, barcode });
    res.json({ ...r, photo: photo ? path.basename(photo) : null });
  });

  api.get("/barcode/:code", async (req, res) => void res.json(await lookupBarcode(db, String(req.params.code))));

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
        barcode: z.string().optional(),
        specifics: z.record(z.string(), z.string()).optional(),
      })
      .parse(req.body);
    const specifics: Record<string, string> = { ...(b.specifics ?? {}) };
    if (b.barcode) {
      const n = normalizeCode(b.barcode);
      if (n.valid) specifics[specificKeyFor(n.kind)] = n.code;
    }
    const id = Number(
      db
        .prepare(
          `INSERT INTO items (sku, title, brand, category, cost, price, quantity, quantity_purchased, source, sourced_at, status, notes, specifics)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), 'draft', ?, ?)`,
        )
        .run(nextSku(db), b.name, b.brand ?? "", b.category ?? "", b.cost, b.price ?? 0, b.quantity, b.quantity, b.source ?? "", b.notes ?? "", JSON.stringify(specifics))
        .lastInsertRowid,
    );
    if (b.photo) {
      const file = path.join(uploadDir, path.basename(b.photo)); // basename: no path traversal
      if (fs.existsSync(file)) db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, 0)").run(id, file);
    }
    logActivity(db, "sourced", `Bought ${b.quantity > 1 ? b.quantity + "x " : ""}${b.name} for $${b.cost.toFixed(2)}${b.source ? ` at ${b.source}` : ""}`, id);
    res.status(201).json(getItem(db, id));
  });

  // ---------------- Inventory spreadsheet import ----------------
  const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  api.post("/import/inventory/preview", csvUpload.single("file"), (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose a CSV file." });
    res.json(previewInventory(db, req.file.buffer.toString("utf8")));
  });
  api.post("/import/inventory", csvUpload.single("file"), async (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose a CSV file." });
    res.json(await importInventory(db, req.file.buffer.toString("utf8"), { uploadDir, downloadPhotos: req.body.photos !== "0" }));
  });

  const mpParam = (v: unknown) => (typeof v === "string" && isMarketplaceId(v) ? v : undefined);
  api.post("/import/sales/preview", csvUpload.single("file"), (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose a CSV file." });
    res.json(previewSales(db, req.file.buffer.toString("utf8"), mpParam(req.body.marketplace)));
  });
  api.post("/import/sales", csvUpload.single("file"), (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose a CSV file." });
    res.json(importSales(db, req.file.buffer.toString("utf8"), mpParam(req.body.marketplace)));
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
  api.get("/digest/preview", (_req, res) => void res.json(buildDigest(db)));
  api.post("/digest/send", async (_req, res) => void res.json(await sendDigest(db, { force: true })));
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
          return { ...row, photo: photo ? (photo.startsWith("http") ? photo : uploadUrl(photo)) : null };
        }),
    );
  });

  // eBay smoke test: list a test item on eBay's sandbox, end it, clean up (see services/ebaySmoke.ts).
  api.get("/ebay/smoke-test", (_req, res) => void res.json(getSetting(db, "ebaySmoke", null)));
  api.post("/ebay/smoke-test", async (req, res) => {
    const allowProduction = z.object({ allowProduction: z.boolean().default(false) }).parse(req.body ?? {}).allowProduction;
    const r = await ebaySmokeTest(db, uploadDir, { allowProduction });
    setSetting(db, "ebaySmoke", r);
    res.json(r);
  });

  // Weekly eBay check (full test on the sandbox, read-only on a real account).
  api.get("/ebay/weekly-check", (_req, res) => void res.json({ ...weeklyEbay(db), env: ebayEnvironment(), connected: ebayIsLive(db) }));
  api.put("/ebay/weekly-check", (req, res) => {
    const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    setSetting(db, "ebayWeekly", { ...weeklyEbay(db), enabled });
    res.json({ ...weeklyEbay(db), env: ebayEnvironment(), connected: ebayIsLive(db) });
  });
  api.post("/ebay/weekly-check", async (_req, res) => void res.json({ last: await runWeeklyEbay(db, uploadDir) }));

  // Problem reports (replayable): list, one as a JSON download.
  api.get("/problems", (_req, res) => void res.json(listProblems(db)));
  api.get("/problems/:id", (req, res) => {
    const p = getProblem(db, Number(req.params.id));
    if (!p) return void res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Disposition", `attachment; filename="flipdesk-problem-${req.params.id}.json"`);
    res.json(p);
  });
  api.get("/jobs", (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT j.*, i.sku, i.title FROM jobs j JOIN items i ON i.id = j.item_id
           ORDER BY CASE j.status WHEN 'pending' THEN 0 WHEN 'claimed' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, j.id DESC LIMIT 200`,
        )
        .all()
        .map((j) => ({ ...(j as Record<string, unknown>), problemId: (j as { status: string }).status === "failed" ? problemForJob(db, (j as { id: number }).id) : null })),
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

  // The sample shop never connects to your real eBay account.
  api.use("/connections/ebay", (_req, res, next) => {
    if (opts.workspace?.demo) return void res.status(400).json({ error: "This is the sample shop. Go back to your shop to connect eBay." });
    next();
  });
  api.get("/connections/ebay/auth-url", (req, res) => {
    if (!ebayHasAppKeys()) return void res.status(400).json({ error: "Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RU_NAME to .env first." });
    // state = nonce + where this FlipDesk runs, so the relay page can send eBay's answer back here automatically.
    const ret = String(req.query.return ?? process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
    if (!/^https?:\/\/[^/]+$/.test(ret)) return void res.status(400).json({ error: "Bad return address" });
    const state = `${crypto.randomBytes(12).toString("hex")}.${Buffer.from(ret).toString("base64url")}`;
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

  // No public HTTPS address? Paste the URL eBay redirected you to after you clicked "Agree".
  api.post("/connections/ebay/paste", async (req, res) => {
    const { url } = z.object({ url: z.string().min(10) }).parse(req.body);
    const { code, state } = parseEbayRedirect(url);
    if (state && state !== getSetting(db, "ebay.oauthState", "")) return void res.status(400).json({ error: "That link is from an older attempt. Click Connect eBay again and paste the new address." });
    await ebayExchangeCode(db, code);
    logActivity(db, "connected", "Connected eBay account");
    res.json({ ok: true });
  });

  /** One-time eBay setup checklist: what's done, what's missing, and how to fix it. */
  api.get("/ebay/setup", async (_req, res) => {
    const cfg = getSetting(db, "ebay", {} as { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string; merchantLocationKey?: string });
    const steps: { key: string; label: string; done: boolean; detail: string; action?: string }[] = [];
    const keys = ebayHasAppKeys();
    steps.push({ key: "keys", label: "eBay developer keys", done: keys, detail: keys ? `Using ${ebayEnvironment()} keys` : "Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME and EBAY_ENV=production to .env, then restart" });
    const live = ebayIsLive(db);
    steps.push({ key: "connect", label: "Connect your eBay seller account", done: live, detail: live ? "Connected" : "Click Connect eBay, sign in, click Agree", action: keys && !live ? "connect" : undefined });
    let opted = false;
    let locations: { key: string }[] = [];
    let err: string | null = null;
    if (live) {
      try {
        opted = (await ebayOptedInPrograms(db)).includes("SELLING_POLICY_MANAGEMENT");
        locations = await ebayLocations(db);
      } catch (e) {
        err = (e as Error).message;
      }
    }
    steps.push({ key: "optin", label: "Turn on eBay business policies", done: opted, detail: opted ? "On" : "Required for listing through the API. One click (eBay can take a few minutes to apply it)", action: live && !opted ? "optin" : undefined });
    const pol = Boolean(cfg.fulfillmentPolicyId && cfg.paymentPolicyId && cfg.returnPolicyId);
    steps.push({ key: "policies", label: "Choose shipping, payment and return policies", done: pol, detail: pol ? "Chosen" : "Settings, eBay listing policies: Load from eBay, then pick one of each (create them in Seller Hub, Account, Business policies, if you have none)", action: live && opted && !pol ? "policies" : undefined });
    const loc = Boolean(cfg.merchantLocationKey && (!live || locations.some((l) => l.key === cfg.merchantLocationKey)));
    steps.push({ key: "location", label: "Register where items ship from", done: loc, detail: loc ? `Location "${cfg.merchantLocationKey}"` : "Uses your ship-from address in Settings", action: live && !loc ? "location" : undefined });
    const pub = Boolean(process.env.PUBLIC_BASE_URL);
    steps.push({ key: "photos", label: "Photos reachable by eBay", done: true, detail: pub ? `Served from ${process.env.PUBLIC_BASE_URL}` : "Uploaded to eBay's photo hosting automatically when you list (JPG/PNG/WebP)" });
    res.json({ environment: ebayEnvironment(), ready: steps.every((x) => x.done), steps, error: err });
  });
  // Before listing: category + required item specifics this item is missing.
  api.get("/items/:id/ebay-check", async (req, res) => {
    const item = getItem(db, Number(req.params.id));
    if (!item) return void res.status(404).json({ error: "Not found" });
    if (!ebayHasAppKeys()) return void res.json({ demo: true, missing: [], category: null });
    const cat = item.specifics["_ebayCategoryId"]
      ? { id: item.specifics["_ebayCategoryId"], name: "(chosen)" }
      : (await suggestCategory(db, `${item.title} ${item.category}`))[0];
    if (!cat) return void res.json({ missing: [], category: null, warning: "eBay couldn't suggest a category - add a category to the item." });
    const req_ = await ebayRequiredAspects(db, cat.id);
    const have = new Set(Object.keys(item.specifics).map((k) => k.toLowerCase()).concat(item.brand ? ["brand"] : [], item.color ? ["color"] : [], item.size ? ["size"] : []));
    res.json({ category: cat, missing: req_.filter((a) => !have.has(a.name.toLowerCase())) });
  });

  api.post("/ebay/optin", async (_req, res) => {
    await ebayOptInBusinessPolicies(db);
    res.json({ ok: true });
  });
  api.post("/ebay/location", async (_req, res) => {
    const key = "flipdesk-main";
    const from = getSetting(db, "shipFrom", {} as Record<string, string>);
    try {
      await ebayCreateLocation(db, key, from);
    } catch (e) {
      // Already exists is fine; anything else bubbles up.
      if (!/already exists|25803|duplicate/i.test((e as Error).message)) throw e;
    }
    setSetting(db, "ebay", { ...getSetting(db, "ebay", {}), merchantLocationKey: key });
    res.json({ ok: true, key });
  });

  api.get("/ebay/policies", async (_req, res) => {
    if (!ebayIsLive(db)) return void res.status(400).json({ error: "Connect eBay first." });
    res.json(await fetchPolicies(db));
  });

  // ---------------- eBay power tools ----------------
  api.get("/tools/stale", (req, res) => {
    const rows = staleListings(db, Number(req.query.days ?? 30));
    const model = learn(db);
    const traffic = latestTraffic(db);
    // One batch load for all the items behind these listings (an item is often stale on several sites).
    const ids = [...new Set(rows.map((r) => r.itemId))];
    const items = new Map(
      hydrateItems(db, ids.length ? (db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as unknown as ItemRow[]) : []).map((i) => [i.id, i]),
    );
    res.json(
      rows.map((r) => {
        const item = items.get(r.itemId);
        const t = r.marketplace === "ebay" ? traffic.get(r.listingId) : undefined;
        return { ...r, advice: item ? advise(db, item, model, t) : null, traffic: t ?? null, diagnosis: t ? diagnose(t, r.daysListed) : null };
      }),
    );
  });
  api.get("/items/:id/price-advice", (req, res) => {
    const item = getItem(db, Number(req.params.id));
    if (!item) return void res.status(404).json({ error: "Not found" });
    const ebay = item.listings.find((l) => l.marketplace === "ebay" && l.status === "active");
    res.json(advise(db, item, learn(db), ebay ? latestTraffic(db).get(ebay.id) : undefined));
  });
  api.get("/price-model", (_req, res) => void res.json(learn(db)));
  api.post("/traffic/import", memUploadShip.single("file"), (req, res) => {
    if (!req.file) return void res.status(400).json({ error: "Choose the traffic report CSV." });
    res.json(importTrafficCsv(db, req.file.buffer.toString("utf8")));
  });
  api.post("/traffic/sync", async (_req, res) => void res.json({ updated: await syncEbayTraffic(db) }));
  api.get("/traffic/summary", (_req, res) => {
    const t = db.prepare("SELECT COUNT(DISTINCT external_id) AS listings, MAX(imported_at) AS last FROM listing_traffic").get() as { listings: number; last: string | null };
    res.json({ ...t, ebayLive: ebayIsLive(db) });
  });
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
  const SETTING_KEYS = ["shop", "mileage", "shipFrom", "weekly", "shipping", "notify", "minutesPerItem", "sourcing", "feeOverrides", "defaultShippingCost", "skuPrefix", "autoDrop", "ebay", "etsy", "defaultMarketplaces", "descriptionFooter"];
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
  // ---------------- Mileage ----------------
  api.get("/mileage", (req, res) => {
    const year = Number(req.query.year ?? new Date().getFullYear());
    res.json({
      summary: mileageSummary(db, year),
      places: db.prepare("SELECT * FROM places ORDER BY name").all(),
      trips: db.prepare("SELECT * FROM trips WHERE strftime('%Y', date) = ? ORDER BY date DESC, id DESC LIMIT 500").all(String(year)),
    });
  });
  api.post("/mileage/trips", (req, res) => {
    const b = z
      .object({
        date: z.string().optional(),
        place: z.string().min(1),
        purpose: z.string().optional(),
        miles: z.number().positive().optional(),
        odometerStart: z.number().min(0).optional(),
        odometerEnd: z.number().min(0).optional(),
        note: z.string().optional(),
        remember: z.boolean().optional(),
      })
      .parse(req.body);
    res.status(201).json(logTrip(db, b));
  });
  api.delete("/mileage/trips/:id", (req, res) => (deleteTrip(db, Number(req.params.id)), void res.status(204).end()));
  api.post("/mileage/places", (req, res) => {
    const b = z.object({ name: z.string().min(1), roundTripMiles: z.number().positive() }).parse(req.body);
    savePlace(db, b.name, b.roundTripMiles);
    res.status(201).json({ ok: true });
  });
  api.delete("/mileage/places/:id", (req, res) => (db.prepare("DELETE FROM places WHERE id = ?").run(Number(req.params.id)), void res.status(204).end()));

  api.get("/returns", (_req, res) => void res.json(db.prepare("SELECT * FROM returns ORDER BY id DESC LIMIT 200").all()));
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
    } else if (req.params.kind === "mileage") {
      rows = db.prepare("SELECT date, place AS destination, purpose, miles, rate, amount AS deduction, odometer_start, odometer_end, note FROM trips WHERE strftime('%Y', date) = ? ORDER BY date").all(year) as Record<string, unknown>[];
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
    const given = Buffer.from(String(req.headers["x-flipdesk-token"] ?? ""));
    const want = Buffer.from(extensionToken(db));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return void res.status(401).json({ error: "Bad extension token" });
    next();
  });
  ext.use((_req, _res, next) => (touch("extension"), next())); // for the Status page: "extension last seen"
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
    if (!b.ok) {
      // Keep a problem report for extension failures too (what the extension saw, plus the item).
      const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(Number(req.params.id)) as JobRow | undefined;
      if (job)
        try {
          const item = getItem(db, job.item_id);
          const listing = job.listing_id ? (db.prepare("SELECT * FROM listings WHERE id = ?").get(job.listing_id) as ListingRow | undefined) : undefined;
          saveProblem(db, { job, item, listing, error: b.error ?? "failed", mode: "extension" });
        } catch {
          /* reporting never breaks syncing */
        }
    }
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
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: message });
    console.error("[api]", message);
    res.status(500).json({ error: message });
  });

  return app;
}
