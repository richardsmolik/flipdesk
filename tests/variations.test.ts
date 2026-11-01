import { beforeEach, describe, expect, it } from "vitest";
import { getItem, openDb, type Db } from "../server/db.js";
import { claimExtensionJob, completeJob, crosslist, processApiJobs } from "../server/services/jobs.js";
import { NeedsVariationError, recordSale, restock, saveVariations } from "../server/services/sync.js";

let db: Db;
beforeEach(() => {
  delete process.env.EBAY_CLIENT_ID;
  db = openDb(":memory:");
});

function tee() {
  const id = Number(
    db.prepare("INSERT INTO items (sku, title, cost, price, quantity, quantity_purchased) VALUES ('TEE', 'Band Tee', 5, 25, 0, 0)").run().lastInsertRowid,
  );
  return saveVariations(db, id, [
    { attrs: { Size: "S" }, quantity: 1 },
    { attrs: { Size: "M" }, quantity: 3 },
    { attrs: { Size: "L" }, quantity: 2, price: 28 },
  ])!;
}
const L = (itemId: number) => getItem(db, itemId)!.listings;

describe("variations", () => {
  it("item totals are the sum of variations; SKUs generated", () => {
    const t = tee();
    expect(t.quantity).toBe(6);
    expect(t.quantity_purchased).toBe(6);
    expect(t.variations.map((v) => v.sku)).toEqual(["TEE-S", "TEE-M", "TEE-L"]);
    expect(t.variations[1].name).toBe("Size: M");
  });

  it("one combined listing on eBay, one per size on Mercari (each qty 1) and Poshmark", async () => {
    const t = tee();
    crosslist(db, t.id, ["ebay", "mercari", "poshmark"]);
    const ls = L(t.id);
    const ebay = ls.filter((l) => l.marketplace === "ebay");
    expect(ebay).toHaveLength(1);
    expect(ebay[0].variation_id).toBeNull();
    expect(ebay[0].quantity).toBe(6);
    const merc = ls.filter((l) => l.marketplace === "mercari");
    expect(merc).toHaveLength(3);
    expect(merc.every((l) => l.quantity === 1)).toBe(true);
    const posh = ls.filter((l) => l.marketplace === "poshmark");
    expect(posh.map((l) => l.quantity).sort()).toEqual([1, 2, 3]);
    expect(posh.find((l) => l.quantity === 2)!.price).toBe(28); // L price override
  });

  it("extension job carries the variation (title suffix + size)", () => {
    const t = tee();
    crosslist(db, t.id, ["mercari"]);
    const j = claimExtensionJob(db, ["mercari"])!;
    expect(j.variation).toBeTruthy();
    expect(j.item!.title).toMatch(/Band Tee [SML]$/);
    expect(j.item!.specifics.Size).toBeTruthy();
  });

  it("selling the last Small delists Small everywhere but keeps M/L live", async () => {
    const t = tee();
    crosslist(db, t.id, ["ebay", "mercari"]);
    await processApiJobs(db);
    let j;
    while ((j = claimExtensionJob(db, ["mercari"]))) completeJob(db, j.job.id, true, { externalId: `m${j.job.id}` });
    const small = t.variations[0];
    const r = recordSale(db, { itemId: t.id, marketplace: "ebay", salePrice: 25, variationId: small.id });
    expect("remaining" in r && r.remaining).toBe(5);
    const merc = L(t.id).filter((l) => l.marketplace === "mercari");
    expect(merc.find((l) => l.variation_id === small.id)!.status).toBe("ending");
    expect(merc.filter((l) => l.status === "active")).toHaveLength(2);
    expect(getItem(db, t.id)!.variations[0].quantity_sold).toBe(1);
  });

  it("a Medium sold on Mercari relists Medium there and syncs eBay", async () => {
    const t = tee();
    crosslist(db, t.id, ["ebay", "mercari"]);
    await processApiJobs(db);
    let j;
    while ((j = claimExtensionJob(db, ["mercari"]))) completeJob(db, j.job.id, true, { externalId: `m${j.job.id}` });
    const med = t.variations[1];
    const mercMed = L(t.id).find((l) => l.marketplace === "mercari" && l.variation_id === med.id)!;
    const r = recordSale(db, { itemId: t.id, marketplace: "mercari", salePrice: 25, listingId: mercMed.id });
    expect("relisted" in r && r.relisted).toEqual(["mercari"]);
    expect("synced" in r && r.synced).toContain("ebay");
    expect(L(t.id).find((l) => l.marketplace === "ebay")!.quantity).toBe(5);
  });

  it("asks which variation sold when ambiguous", () => {
    const t = tee();
    expect(() => recordSale(db, { itemId: t.id, marketplace: "ebay", salePrice: 25 })).toThrow(NeedsVariationError);
  });

  it("restocking a sold-out size re-lists it on separate-listing sites", async () => {
    const t = tee();
    crosslist(db, t.id, ["mercari"]);
    let j;
    while ((j = claimExtensionJob(db, ["mercari"]))) completeJob(db, j.job.id, true, { externalId: `m${j.job.id}` });
    const small = t.variations[0];
    recordSale(db, { itemId: t.id, marketplace: "mercari", salePrice: 25, variationId: small.id });
    // finish the delist job
    while ((j = claimExtensionJob(db, ["mercari"]))) completeJob(db, j.job.id, true);
    const after = restock(db, t.id, 2, 5, small.id)!;
    expect(after.variations[0].quantity).toBe(2);
    expect(after.variations[0].quantity_purchased).toBe(3);
    expect(L(t.id).find((l) => l.variation_id === small.id)!.status).toBe("queued");
  });

  it("can't delete a variation that has sales", () => {
    const t = tee();
    recordSale(db, { itemId: t.id, marketplace: "ebay", salePrice: 25, variationId: t.variations[0].id });
    expect(() => saveVariations(db, t.id, [{ id: t.variations[1].id, attrs: { Size: "M" }, quantity: 3 }])).toThrow(/has sales/);
  });
});

describe("oversell safety net", () => {
  it("raises a critical alert with a drafted buyer message", () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, cost, price, quantity) VALUES ('X1', 'Coach Bag', 10, 100, 1)").run().lastInsertRowid);
    recordSale(db, { itemId: id, marketplace: "poshmark", salePrice: 100 });
    const r = recordSale(db, { itemId: id, marketplace: "ebay", salePrice: 100, buyer: "jane_doe" });
    expect("oversold" in r && r.oversold).toBe(true);
    const a = db.prepare("SELECT * FROM alerts WHERE kind = 'oversell'").get() as { severity: string; data: string; title: string };
    expect(a.severity).toBe("critical");
    const msg = JSON.parse(a.data).message as string;
    expect(msg).toMatch(/Hi jane_doe/);
    expect(msg).toMatch(/request a cancellation/); // eBay: buyer-requested cancel avoids a seller defect
  });
});
