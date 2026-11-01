/** Demo data: `npm run seed` (wipes data/flipdesk.db). */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db.js";
import type { MarketplaceId } from "./marketplaces/registry.js";
import { breakdown } from "./services/fees.js";

const DB = process.env.FLIPDESK_DB ?? "data/flipdesk.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(DB);
const UP = "data/uploads";
fs.mkdirSync(UP, { recursive: true });

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];

const PALETTE = ["#1e3a8a", "#7c2d12", "#14532d", "#581c87", "#9a3412", "#0f766e", "#3f3f46", "#be123c", "#854d0e", "#1d4ed8"];
function photo(label: string, emoji: string, i: number) {
  const c = PALETTE[i % PALETTE.length];
  const file = path.join(UP, `seed-${i}.svg`);
  fs.writeFileSync(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#0b0b0f"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><text x="300" y="300" font-size="180" text-anchor="middle" dominant-baseline="middle">${emoji}</text><text x="300" y="520" font-size="28" fill="#fff" font-family="system-ui" text-anchor="middle" opacity=".85">${label.replace(/&/g, "&amp;").slice(0, 34)}</text></svg>`,
  );
  return file;
}

type Seed = [title: string, brand: string, category: string, emoji: string, cost: number, price: number, qty: number, mps: MarketplaceId[]];
const ITEMS: Seed[] = [
  ["Patagonia Better Sweater 1/4 Zip Fleece Mens L Navy", "Patagonia", "Clothing > Men > Sweaters", "🧥", 8, 64.99, 1, ["ebay", "poshmark", "mercari", "depop"]],
  ["Nike Air Jordan 1 Mid Chicago Toe Size 10.5", "Nike", "Shoes > Men > Sneakers", "👟", 45, 119.99, 1, ["ebay", "grailed", "mercari", "poshmark"]],
  ["Levi's 501 Vintage Jeans 32x30 Made in USA 90s", "Levi's", "Clothing > Men > Jeans > vintage", "👖", 6, 59.99, 1, ["ebay", "depop", "etsy", "grailed"]],
  ["Pokemon TCG Scarlet Violet 151 Booster Bundle Sealed", "Pokemon", "Collectibles > cards > Sealed", "🃏", 28, 54.99, 6, ["ebay", "whatnot", "mercari", "facebook"]],
  ["Apple AirPods Pro 2nd Gen USB-C Tested Working", "Apple", "electronics > Headphones", "🎧", 70, 139.99, 1, ["ebay", "mercari", "facebook", "amazon"]],
  ["Coach Tabby Shoulder Bag 26 Black Leather", "Coach", "handbags > Shoulder Bags", "👜", 35, 189, 1, ["ebay", "poshmark", "mercari", "vinted"]],
  ["Lululemon Align Leggings 25\" Size 6 Black", "Lululemon", "Clothing > Women > Leggings", "🩱", 9, 48, 3, ["poshmark", "mercari", "depop", "vinted", "ebay"]],
  ["Pyrex 4-Piece Primary Colors Mixing Bowl Set Vintage", "Pyrex", "home > Kitchen > vintage", "🥣", 12, 95, 1, ["ebay", "etsy", "facebook"]],
  ["Carhartt Detroit Jacket J97 Brown Duck Blanket Lined XL", "Carhartt", "Clothing > Men > Coats > workwear", "🧥", 30, 149.99, 1, ["ebay", "grailed", "depop", "poshmark"]],
  ["Nintendo Switch OLED White Console Bundle", "Nintendo", "electronics > Video Games > Consoles", "🎮", 140, 249.99, 1, ["ebay", "mercari", "facebook"]],
  ["Funko Pop Star Wars Grogu #368 Vaulted", "Funko", "collectibles > toys > Funko", "🧸", 4, 24.99, 8, ["ebay", "mercari", "whatnot"]],
  ["Dewalt 20V Max Drill/Driver Kit DCD771C2 Tested", "DeWalt", "tools > Power Tools", "🔧", 35, 89.99, 1, ["ebay", "facebook", "mercari"]],
  ["Anthropologie Maeve Midi Dress Floral Size M NWT", "Anthropologie", "Clothing > Women > Dresses", "👗", 12, 68, 1, ["poshmark", "mercari", "depop", "vinted"]],
  ["Harry Potter Sorcerer's Stone 1st American Edition 1998", "Scholastic", "books > Rare", "📕", 3, 175, 1, ["ebay", "etsy", "amazon"]],
  ["Stanley Quencher H2.0 40oz Tumbler Rose Quartz", "Stanley", "home > Drinkware", "🥤", 15, 39.99, 4, ["ebay", "mercari", "poshmark", "facebook"]],
  ["Ray-Ban Wayfarer RB2140 Black Polarized", "Ray-Ban", "accessories > Sunglasses", "🕶️", 18, 79.99, 1, ["ebay", "poshmark", "mercari", "grailed"]],
  ["Vintage 1994 Grateful Dead Tour T-Shirt XL Single Stitch", "Liquid Blue", "Clothing > Men > T-Shirts > vintage", "👕", 5, 120, 1, ["ebay", "depop", "grailed", "etsy"]],
  ["LEGO Star Wars Millennium Falcon 75257 Complete", "LEGO", "toys > Building", "🚀", 60, 129.99, 1, ["ebay", "mercari", "facebook", "whatnot"]],
  ["Mid Century Modern Teak Side Table", "Unbranded", "furniture > Tables > vintage", "🪑", 20, 180, 1, ["facebook", "etsy", "ebay"]],
  ["Canon AE-1 Program 35mm Film Camera 50mm f/1.8", "Canon", "electronics > Cameras > vintage", "📷", 55, 219.99, 1, ["ebay", "etsy", "mercari"]],
  ["Sony WH-1000XM4 Wireless Headphones Black", "Sony", "electronics > Headphones", "🎧", 80, 159.99, 1, ["ebay", "mercari", "amazon"]],
  ["Free People Movement Hot Shot Onesie Size S", "Free People", "Clothing > Women > activewear", "🩳", 7, 42, 2, ["poshmark", "depop", "mercari", "vinted"]],
  ["Supreme Box Logo Hoodie FW16 Grey Medium", "Supreme", "Clothing > Men > Hoodies > streetwear", "🧢", 150, 420, 1, ["ebay", "grailed", "depop"]],
  ["Hot Wheels Treasure Hunt Lot of 10", "Hot Wheels", "collectibles > toys > Diecast", "🏎️", 12, 45, 1, ["ebay", "whatnot", "mercari"]],
  ["Le Creuset 5.5qt Round Dutch Oven Flame", "Le Creuset", "home > Kitchen > Cookware", "🍲", 40, 199, 1, ["ebay", "facebook", "mercari", "poshmark"]],
  ["Dr. Martens 1460 Smooth Leather Boots Black US W8", "Dr. Martens", "Shoes > Women > Boots", "🥾", 22, 89, 1, ["poshmark", "depop", "ebay", "vinted"]],
];

const conds = ["used_excellent", "used_good", "like_new", "new_with_tags", "used_good"];
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86400_000).toISOString().replace("T", " ").slice(0, 19);

let photoIdx = 0;
ITEMS.forEach(([title, brand, category, emoji, cost, price, qty, mps], idx) => {
  const sku = `FD-${String(idx + 1).padStart(5, "0")}`;
  const ageDays = Math.floor(rand() * 70) + 2;
  const id = Number(
    db
      .prepare(
        `INSERT INTO items (sku, title, description, brand, category, condition, cost, price, min_price, quantity, quantity_purchased, location, source, sourced_at, status, keywords, specifics, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        sku,
        title,
        `${title}\n\nGreat pre-owned condition - see photos for details.\nShips within 1 business day, carefully packed.`,
        brand,
        category,
        pick(conds),
        cost,
        price,
        Math.round(price * 0.75),
        qty,
        qty,
        `Bin ${String.fromCharCode(65 + (idx % 6))}${(idx % 9) + 1}`,
        pick(["Goodwill", "Estate sale", "Garage sale", "Facebook", "Thrift store", "Retail arbitrage"]),
        iso(ageDays + 3).slice(0, 10),
        JSON.stringify(title.toLowerCase().split(/\s+/).slice(0, 8)),
        JSON.stringify({ Brand: brand }),
        iso(ageDays + 1),
        iso(ageDays),
      ).lastInsertRowid,
  );
  db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, 0)").run(id, photo(title, emoji, photoIdx++));

  for (const m of mps) {
    const multi = ["ebay", "poshmark", "depop", "etsy", "shopify", "amazon", "whatnot"].includes(m);
    db.prepare(
      `INSERT INTO listings (item_id, marketplace, status, external_id, url, price, quantity, views, watchers, listed_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, m, `${m}-${id}`, null, price, multi ? qty : 1, Math.floor(rand() * 180), m === "ebay" ? Math.floor(rand() * 6) : 0, iso(ageDays));
  }

  // ~45% of items have sold (some multi-qty items partially).
  if (rand() < 0.45 || qty > 3) {
    const soldQty = qty > 1 ? Math.max(1, Math.floor(qty * (0.3 + rand() * 0.4))) : 1;
    const where = pick(mps);
    const unit = Math.round(price * (0.8 + rand() * 0.2) * 100) / 100;
    for (let k = 0; k < soldQty; k++) {
      const shipCost = 4 + Math.round(rand() * 900) / 100;
      const b = breakdown(where, { price: unit, shippingCost: shipCost, cost });
      db.prepare(
        `INSERT INTO sales (item_id, marketplace, quantity, order_id, sale_price, shipping_charged, shipping_cost, fees, cost, profit, buyer, sold_at)
         VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      ).run(id, where, `ORD-${id}-${k}`, unit, shipCost, b.fees, cost, b.profit, pick(["jess_finds", "mike.r", "thriftqueen", "collector22", "dvd_dan"]), iso(Math.floor(rand() * ageDays)));
    }
    const left = qty - soldQty;
    db.prepare("UPDATE items SET quantity = ?, status = ? WHERE id = ?").run(left, left === 0 ? "sold" : "active", id);
    if (left === 0) {
      db.prepare("UPDATE listings SET status = CASE marketplace WHEN ? THEN 'sold' ELSE 'ended' END, quantity = 0, ended_at = datetime('now') WHERE item_id = ?").run(where, id);
    } else {
      db.prepare("UPDATE listings SET quantity = CASE WHEN quantity > 1 THEN ? ELSE 1 END WHERE item_id = ?").run(left, id);
    }
  }
});

// A few drafts waiting to be listed.
for (const [t, e] of [["Vintage Polaroid SX-70 Land Camera", "📸"], ["Yeti Rambler 30oz Tumbler Navy", "🥤"], ["Kate Spade Wallet Pink Saffiano", "👛"]] as const) {
  const id = Number(
    db.prepare("INSERT INTO items (sku, title, brand, cost, price, status) VALUES (?, ?, ?, ?, ?, 'draft')").run(`FD-D${photoIdx}`, t, t.split(" ")[0], 6, 0).lastInsertRowid,
  );
  db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, 0)").run(id, photo(t, e, photoIdx++));
}

db.prepare("INSERT INTO expenses (date, category, amount, note) VALUES (date('now','-20 days'), 'supplies', 42.5, 'Poly mailers + tape'), (date('now','-9 days'), 'mileage', 18.76, '28 mi sourcing run')").run();
for (const m of ["ebay", "poshmark", "mercari", "depop", "grailed", "etsy", "facebook", "whatnot", "vinted"]) {
  db.prepare("INSERT INTO connections (marketplace, status, username, connected_at) VALUES (?, 'connected', 'demo_seller', datetime('now'))").run(m);
}
db.prepare("INSERT INTO activity (kind, message) VALUES ('info', 'Demo data loaded - connect real accounts on the Connections page')").run();
console.log(`Seeded ${ITEMS.length + 3} items into ${DB}`);
