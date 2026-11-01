import { beforeEach, describe, expect, it, afterEach } from "vitest";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { getItem, openDb, setSetting, type Db } from "../server/db.js";
import { createApp, extensionToken } from "../server/app.js";
import { detectColumns, findLocalComps, importComps, parseCsv } from "../server/services/comps.js";
import { researchPrice } from "../server/services/pricing.js";
import { checkItem } from "../server/services/sourcing.js";
import { profitReport } from "../server/services/insights.js";
import { ingestEmail, marketplaceFromSender, parseSaleEmail, confirmEmail } from "../server/services/email.js";
import { crosslist, processApiJobs, claimExtensionJob, completeJob } from "../server/services/jobs.js";
import { recordSale, saveVariations } from "../server/services/sync.js";

let db: Db;
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FLIPDESK_PASSWORD;
  db = openDb(":memory:");
});

const TERAPEAK = `Listing title,Avg sold price,Avg shipping,Total sold,Item sales,Date last sold
"Patagonia Better Sweater 1/4 Zip Fleece Mens L Navy","$62.50","$8.10",4,"$250.00",Oct 21 2026
"Patagonia Better Sweater Full Zip Mens Large Grey","$58.00",,2,"$116.00",Oct 02 2026
"Patagonia Better Sweater Womens M","$45.00",,3,"$135.00",Sep 30 2026
"Nike Dunk Low Panda Size 10","$95.00",,10,"$950.00",Oct 28 2026
,"$12.00",,1,,`;

describe("sold comps / Terapeak import", () => {
  it("parses quoted CSV and detects Terapeak columns", () => {
    const rows = parseCsv(TERAPEAK);
    expect(rows[1][0]).toBe("Patagonia Better Sweater 1/4 Zip Fleece Mens L Navy");
    const c = detectColumns(rows[0]);
    expect(c.title).toBe(0);
    expect(c.avgPrice).toBe(1);
    expect(c.quantity).toBe(3);
  });

  it("imports, skips bad rows, and matches by title", () => {
    const r = importComps(db, TERAPEAK, "terapeak", "test");
    expect(r.imported).toBe(4);
    expect(r.skipped).toBe(1);
    const m = findLocalComps(db, "Patagonia Better Sweater fleece mens");
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m.every((x) => /patagonia/i.test(x.title))).toBe(true);
  });

  it("pricing uses real sold data (weighted by units) over demo", async () => {
    importComps(db, TERAPEAK, "terapeak", "t");
    const p = await researchPrice(db, "Patagonia Better Sweater");
    expect(p.demo).toBe(false);
    expect(p.sources).toContain("sold-library");
    expect(p.soldStats!.median).toBeGreaterThan(44);
    expect(p.demand!.soldUnits).toBe(9);
  });

  it("rejects files without title/price columns", () => {
    expect(() => importComps(db, "foo,bar\n1,2", "csv")).toThrow(/title and price/);
  });
});

describe("sourcing mode", () => {
  it("BUY / MAYBE / PASS with max buy honoring profit + ROI targets", async () => {
    importComps(db, TERAPEAK, "terapeak", "t");
    setSetting(db, "sourcing", { minProfit: 10, minRoiPct: 100 });
    const cheap = await checkItem(db, { query: "Nike Dunk Low Panda", askPrice: 15 });
    expect(cheap.expectedPrice).toBe(95);
    expect(cheap.priceBasis).toBe("your sold data");
    expect(cheap.verdict).toBe("buy");
    expect(cheap.maxBuy).toBeGreaterThan(30);
    expect(cheap.maxBuy).toBeLessThan(50); // ROI target caps it (net / 2)
    const pricey = await checkItem(db, { query: "Nike Dunk Low Panda", askPrice: 90 });
    expect(pricey.verdict).toBe("pass");
    const noAsk = await checkItem(db, { query: "Nike Dunk Low Panda" });
    expect(noAsk.verdict).toBe("check");
  });
});

describe("profit reports", () => {
  it("groups by source with ROI and produces insights", () => {
    const mk = (title: string, source: string, brand: string, cost: number) =>
      Number(db.prepare("INSERT INTO items (sku, title, source, brand, cost, price, quantity, quantity_purchased, status) VALUES (?, ?, ?, ?, ?, 50, 1, 1, 'active')").run(`S${Math.random()}`, title, source, brand, cost).lastInsertRowid);
    for (let i = 0; i < 3; i++) recordSale(db, { itemId: mk("Tee", "Goodwill", "Nike", 2), marketplace: "vinted", salePrice: 40 });
    for (let i = 0; i < 3; i++) recordSale(db, { itemId: mk("Tee", "Retail", "Gap", 30), marketplace: "vinted", salePrice: 40 });
    mk("Old thing", "Goodwill", "Gap", 9);
    db.prepare("UPDATE items SET created_at = datetime('now','-120 days') WHERE title = 'Old thing'").run();
    const r = profitReport(db, 365);
    const gw = r.bySource.find((s) => s.key === "Goodwill")!;
    expect(gw.unitsSold).toBe(3);
    expect(gw.unitsBought).toBe(4);
    expect(gw.roiPct).toBe(1900); // (40-2)/2
    expect(r.insights.some((i) => /Best source: Goodwill/.test(i.text))).toBe(true);
    expect(r.insights.some((i) => /Weakest source: Retail/.test(i.text))).toBe(true);
    expect(r.aging.find((a) => a.bucket === "90+ days")?.cost).toBe(9);
    expect(r.perHour).not.toBeNull();
  });
});

describe("email sale detection", () => {
  function listed(title: string, m: "poshmark" | "mercari" = "poshmark", qty = 1) {
    const id = Number(db.prepare("INSERT INTO items (sku, title, cost, price, quantity, quantity_purchased) VALUES (?, ?, 10, 60, ?, ?)").run(`E${Math.random()}`, title, qty, qty).lastInsertRowid);
    crosslist(db, id, [m]);
    const j = claimExtensionJob(db, [m])!;
    completeJob(db, j.job.id, true, { externalId: "x" + id });
    return id;
  }

  it("recognizes marketplace senders and sale wording", () => {
    expect(marketplaceFromSender("Poshmark <offers@poshmark.com>")).toBe("poshmark");
    expect(marketplaceFromSender("no-reply@mercariapp.com")).toBe("mercari");
    expect(marketplaceFromSender("someone@gmail.com")).toBeNull();
    const p = parseSaleEmail("support@poshmark.com", "Congratulations! You just made a sale", "Lululemon Align Leggings\nPrice: $48.00\nOrder #A1B2C3D4");
    expect(p.isSale).toBe(true);
    expect(p.price).toBe(48);
    expect(p.orderId).toBe("A1B2C3D4");
    expect(parseSaleEmail("x@poshmark.com", "Jane liked your listing", "price drop $5.00").isSale).toBe(false);
  });

  it("auto-records a confident match and delists elsewhere", async () => {
    const id = listed("Coach Tabby Shoulder Bag 26 Black Leather");
    crosslist(db, id, ["ebay"]);
    await processApiJobs(db);
    const r = ingestEmail(db, {
      messageId: "<m1@poshmark.com>",
      from: "Poshmark <support@poshmark.com>",
      subject: "You made a sale!",
      text: "Your listing Coach Tabby Shoulder Bag 26 Black Leather sold for $175.00. Ship within 7 days.",
    });
    expect(r.status).toBe("recorded");
    expect(getItem(db, id)!.status).toBe("sold");
    expect(getItem(db, id)!.listings.find((l) => l.marketplace === "ebay")!.status).toBe("ending");
    // Same message again is ignored.
    expect(ingestEmail(db, { messageId: "<m1@poshmark.com>", from: "support@poshmark.com", subject: "You made a sale!", text: "" }).status).toBe("seen");
  });

  it("uncertain matches go to review with an alert, then confirm records the sale", () => {
    const a = listed("Nike Air Max 90 Infrared Mens 10");
    listed("Nike Air Max 90 Triple White Mens 10");
    const r = ingestEmail(db, { messageId: "m2", from: "support@poshmark.com", subject: "You made a sale!", text: "Nike Air Max 90 Mens 10 sold for $90.00" });
    expect(r.status).toBe("review");
    const alert = db.prepare("SELECT * FROM alerts WHERE kind = 'email_review'").get() as { resolved_at: string | null };
    expect(alert.resolved_at).toBeNull();
    confirmEmail(db, (r as { id: number }).id, { itemId: a, salePrice: 90 });
    expect(getItem(db, a)!.quantity).toBe(0);
    expect((db.prepare("SELECT resolved_at FROM alerts WHERE kind = 'email_review'").get() as { resolved_at: string | null }).resolved_at).not.toBeNull();
  });

  it("picks the variation from 'Size: M' in the email", () => {
    const id = listed("Vintage Harley Davidson Tee", "mercari");
    saveVariations(db, id, [
      { attrs: { Size: "M" }, quantity: 1 },
      { attrs: { Size: "L" }, quantity: 1 },
    ]);
    const r = ingestEmail(db, { messageId: "m3", from: "no-reply@mercari.com", subject: "Your item sold!", text: "Vintage Harley Davidson Tee\nSize: M\nPrice: $45.00" });
    expect(r.status).toBe("recorded");
    const item = getItem(db, id)!;
    expect(item.variations.find((v) => v.attrs.Size === "M")!.quantity).toBe(0);
    expect(item.variations.find((v) => v.attrs.Size === "L")!.quantity).toBe(1);
  });

  it("ignores non-marketplace senders", () => {
    expect(ingestEmail(db, { from: "friend@gmail.com", subject: "You made a sale!", text: "$10.00" }).status).toBe("not_a_sale");
  });
});

describe("HTTP: password gate, sourcing buy, forwarded email", () => {
  const up = path.join(os.tmpdir(), "fd-test-uploads2");
  afterEach(() => delete process.env.FLIPDESK_PASSWORD);

  it("requires login when FLIPDESK_PASSWORD is set; extension token still works", async () => {
    process.env.FLIPDESK_PASSWORD = "hunter22";
    const app = createApp(db, { uploadDir: up });
    await request(app).get("/api/items").expect(401);
    await request(app).post("/api/login").send({ password: "nope" }).expect(401);
    const login = await request(app).post("/api/login").send({ password: "hunter22" }).expect(200);
    const cookie = login.headers["set-cookie"];
    await request(app).get("/api/items").set("Cookie", cookie).expect(200);
    await request(app).get("/api/ext/ping").set("X-FlipDesk-Token", extensionToken(db)).expect(200);
  });

  it("sourcing buy creates a draft; forwarded raw email gets parsed", async () => {
    const app = createApp(db, { uploadDir: up });
    const r = await request(app).post("/api/source/buy").send({ name: "Pyrex Bowl Set", cost: 4, quantity: 2, source: "Estate sale", price: 60 }).expect(201);
    expect(r.body.status).toBe("draft");
    expect(r.body.quantity_purchased).toBe(2);
    expect(r.body.source).toBe("Estate sale");

    const raw = "From: Mercari <no-reply@mercari.com>\r\nSubject: Your item sold!\r\nMessage-ID: <abc@mercari.com>\r\n\r\nPyrex Bowl Set sold for $55.00\r\n";
    const e = await request(app).post("/api/ext/email").set("X-FlipDesk-Token", extensionToken(db)).set("Content-Type", "message/rfc822").send(raw).expect(200);
    expect(e.body.status).toBe("review"); // draft isn't listed on Mercari -> needs a human
    expect(e.body.parsed.price).toBe(55);
  });
});
