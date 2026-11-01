# 📦 FlipDesk

A reseller command center. Create a listing once, post it to **11 marketplaces**, and FlipDesk keeps them in sync.

| | |
|---|---|
| **AI listing writer** | Drop photos, and Claude writes the title, description, item specifics, keywords and a price range. It also lists **flaws it spotted** and **things to double-check** (like "check the inside tag for size"). |
| **Crosslisting** | eBay, Poshmark, Mercari, Depop, Vinted, Grailed, Facebook Marketplace, Etsy, Shopify, Amazon, Whatnot |
| **Auto-delist** | When an item sells anywhere, it comes down everywhere else. Delists always run before new listings. |
| **Multi-quantity** | Tracks units **purchased / sold / left**. Partial sales sync the remaining quantity to every site. Sites that only allow 1 per listing get relisted automatically. Restocking recalculates your average cost per unit. |
| **Variations** | Sizes and colors, each with its own purchased / sold / left counts and optional price. eBay (inventory item groups) and Shopify get one listing with every option; other sites get one listing per option. An option that sells out comes down everywhere, and restocking it relists it. |
| **Oversell safety net** | If something sells twice, you get a critical alert, an urgent phone push and a ready-to-send buyer message. On eBay the message asks the buyer to request the cancellation, which avoids the seller penalty for cancelling as "out of stock". |
| **Sale detection from email** | Watches your inbox (IMAP) or accepts forwarded emails. Catches sales on **every** site, including ones without an API. Confident matches are recorded automatically; uncertain ones go to the Inbox for one-tap confirmation. |
| **Sourcing mode** | Phone screen for deciding in a store: snap or type the item, enter the price on the tag, and get **BUY / MAYBE / PASS** plus the most you should pay for your profit and return targets. "I bought it" saves a draft. |
| **Reports** | Profit, return on cost, sell-through and days to sell by **source, brand, category and marketplace**, cash tied up by inventory age, profit per hour, and plain-English "buy more of / avoid" advice |
| **Terapeak import** | Import Terapeak (or any sold-listings) CSV exports. Real sold prices then drive every price suggestion and sourcing mode. |
| **Phone notifications** | Free push notifications via ntfy for sales, oversells and sale emails to confirm |
| **Barcode scanning** | Scan a UPC/ISBN in sourcing mode with your phone camera, a photo of the barcode, or a Bluetooth scanner. Books are looked up on Open Library, other products on UPCitemdb, and eBay comps by exact barcode. The code is saved as UPC/ISBN on the item so eBay matches its product catalog. |
| **Bundles** | Lot listings made of several items, kept in sync both ways (lot sells: its items come down; an item sells alone: the lot comes down; restock: the lot can be filled again). Suggestions for natural groups (same brand, size or category, similar prices, stale stock first). eBay multi-buy discounts ("buy 2 save 10%") via the Marketing API. |
| **Weekly summary** | Monday-morning push (day, hour and time zone are configurable): sales and profit vs last week, top sale, best source, stock going stale, a bundle idea and this week's to-dos |
| **Shipping labels** | Choose per marketplace: the site's prepaid label (Poshmark, Depop, Vinted, Whatnot...), **eBay labels** (exact cost pulled from eBay's Finances API), or **Pirate Ship** (export orders as CSV, then import shipment history to attach costs and tracking, which go back to eBay automatically). Profit updates with the real label cost. |
| **Photo views** | Photo grid with tabs for **Inventory / Selling / Not sold yet** (oldest first, with days-listed badges) **/ Drafts / Sold**, and a full-screen photo viewer (arrow keys or swipe, thumbnails, links to each live listing). A list layout is still available. |
| **Packing slips, pick list, labels** | 4x6 packing slips with item photo, SKU, bin and your thank-you note; a pick list sorted by bin; QR labels for bins and items (2.25x1.25 thermal or 4x6). Scan a bin's QR to see everything in it, with photos. |
| **Returns tracking** | Returns, cancellations and partial refunds recorded with reason, refund, return label and fees kept. Return rate by site and category, top reasons, and alerts when one site's returns run high. |
| **Mileage** | Save stores with round-trip miles and log trips with one tap (also from sourcing mode). Each trip becomes a mileage expense at your rate, with an IRS-ready log (date, destination, purpose, miles) as CSV. Reports show profit per store after gas money. |
| **Buy labels in FlipDesk** | Shippo: compare USPS/UPS/FedEx rates, buy a 4x6 label, save the cost and tracking, and send tracking to eBay. Demo rates without a key. |
| **Uploads** | iPhone HEIC photos converted to JPEG automatically. Every upload is auto-rotated, resized to 2400px, and **stripped of hidden GPS location data**. Drag to reorder photos, upload progress bars, remove before upload. |
| **Bulk upload** | Drop a folder or a pile of photos for many items: FlipDesk splits them into items (one folder per item, by the pause between shots, or every N photos). Fix splits with a click, then create all the drafts, with AI writing them if you have a key. |
| **Inventory import** | Bring items over from Vendoo, List Perfectly, eBay's listings report or any spreadsheet (CSV). Columns are detected by name, with a preview first; photo links download in the background; eBay item numbers are tracked as live eBay listings. |
| **Phone uploads** | Scan a QR code on your computer and take photos on your phone; they land in that item live. The link works for 30 minutes, only for that item, with no login on the phone. Also "📱 Use phone" on New listing. |
| **Duplicate detection** | Photo fingerprints (catch re-shot photos at different size or brightness) and title matching warn you before you list the same thing twice: on the item page, in bulk upload results and in import previews. |
| **Sold-history import** | Bring past sales from Vendoo, List Perfectly, eBay or a sheet. Recorded quietly (no delisting or notifications, marked shipped), so Reports, insights and price advice work from day one. |
| **Photo editor** | ✨ AI auto-enhance (Claude decides rotation, straightening, crop, light, color and background; FlipDesk applies it). Paint to **remove items** or **fix wrinkles** (Clipdrop AI, or a basic built-in version). Remove background (Photoroom / remove.bg / Clipdrop). Crop (free, 1:1, 4:5), rotate, flip, straighten, brightness, contrast, saturation, warmth, sharpen, square on white. Originals are always kept, so you can revert. |
| **Smart price advice** | Learns from your sales, per category, how long items take to sell and how far below their first price they sell. Each unsold item gets "wait", "small nudge" or "drop X% to $Y". Smart automatic drops can use it. |
| **eBay traffic diagnosis** | Impressions, click-through and views per eBay listing (Analytics API, or the Seller Hub traffic CSV), turned into a clear fix: not seen (title/specifics), seen but not clicked (cover photo), or clicked but not bought (price/shipping/details). |
| **eBay setup checklist** | Step-by-step with buttons: connect (sign-in comes back automatically via a free relay page), turn on business policies, choose policies, register a ship-from location. Before listing it shows any missing required item specifics, and eBay errors appear in plain words. Photos go to eBay's own photo hosting. See `docs/EBAY_SETUP.md`. |
| **Cancellations and returns** | Remove a cancelled or oversold sale, or put a returned item back in stock, so profit stays honest |
| **Profit-first** | Per-site fee math (with your own overrides), a "where you keep the most" ranking for every item, true profit after fees, shipping and cost of goods |
| **eBay power tools** | Stale-listing radar with a recommended fix for each listing, offers to watchers, relisting, bulk repricing, automatic price drops that never go below your floor price |
| **Books** | Sales, expenses and inventory as CSV exports for taxes; dashboard with sell-through and average days to sell |

## Quick start

```bash
npm install
npm run seed      # optional: demo inventory, sales and listings
npm run dev       # web http://localhost:5173  ·  API http://localhost:8787
```

Everything works in **demo mode** without any keys. Add keys to `.env` (copy `.env.example`) to go live:

| Feature | What to set |
|---|---|
| AI listing writer | `ANTHROPIC_API_KEY` (console.anthropic.com) |
| eBay | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` from developer.ebay.com, then click **Connect eBay** on the Marketplaces page and choose your policies in Settings |
| Etsy | `ETSY_API_KEY`, `ETSY_SHOP_ID`, `ETSY_ACCESS_TOKEN` |
| Shopify | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` |
| Sale emails | `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` (Gmail: an app password from myaccount.google.com/apppasswords) |
| Phone access (sourcing) | `HOST=0.0.0.0` and `FLIPDESK_PASSWORD`, then `npm run build && npm start` and open `http://<computer-LAN-IP>:8787` on your phone. The server refuses to start on your network without a password. |
| Photo editor AI | `CLIPDROP_API_KEY` (remove items, fix wrinkles, backgrounds) and/or `PHOTOROOM_API_KEY` / `REMOVEBG_API_KEY` (backgrounds). AI auto-enhance uses your `ANTHROPIC_API_KEY`. |
| Labels in FlipDesk | `SHIPPO_API_KEY` (free test keys start with `shippo_test_`), plus your ship-from address in Settings |
| Phone notifications | Install the ntfy app, subscribe to a private topic name, and enter the same name in Settings |

eBay setup notes:
- Set your RuName's "auth accepted URL" to `http://localhost:8787/api/connections/ebay/callback`. eBay requires https in production, so use a tunnel such as ngrok or Cloudflare Tunnel.
- eBay must be able to download your photos. Set `PUBLIC_BASE_URL` to a public URL that serves `/uploads` (the same tunnel works).

## Chrome extension (Poshmark, Mercari, Depop, Vinted, Grailed, Facebook, Whatnot)

These sites have no public seller API, so FlipDesk uses the same approach as Vendoo and List Perfectly: a browser extension working in your logged-in browser.

1. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose the `extension/` folder.
2. In the extension popup, enter the server URL and the **extension token** shown on FlipDesk's Settings page.
3. When you crosslist, the extension opens each site's listing form and fills in the title, description, price, brand, quantity and **photos**. You pick the category and size, then click the site's own **List** button. FlipDesk detects the new listing and records its URL.

It's assisted on purpose: you click the final "List" button yourself. Fully automated posting on sites without an API is a common way to get accounts flagged. The site-specific field selectors live in `extension/sites.js`, so when a site redesigns its form, that's the only file to update.

## How it fits together

```
web/ (React + Tailwind)  ──►  server/ (Express + Node's built-in SQLite)
                                ├─ marketplaces/registry.ts   fees, limits, multi-qty, strengths per site
                                ├─ marketplaces/ebay.ts       Inventory, Account, Taxonomy, Fulfillment, Negotiation APIs
                                ├─ marketplaces/adapters.ts   Etsy, Shopify, Amazon + extension handoff
                                ├─ services/jobs.ts           job queue (publish / delist / update)
                                ├─ services/sync.ts           sales → quantity sync / auto-delist / restock
                                ├─ services/ai.ts             Claude vision → structured listing draft
                                └─ services/ebayTools.ts      stale radar, offers, relist, auto price drops
extension/ (Chrome MV3)  ──►  claims jobs for browser-only sites via /api/ext/*
```

Background schedule: API jobs every 30s, eBay order polling every 5 min (a sale on eBay delists everywhere else), automatic price drops hourly.

## Status and known gaps

- **Tested:** 92 tests, including phone upload links (token-only, expiry, no other access), photo-fingerprint duplicates, and sold-history import feeding reports and price advice. Earlier: 86 tests, including real iPhone HEIC conversion, EXIF rotation and GPS stripping, bulk grouping, spreadsheet import with photo download, and private-network protection for photo links.
- **Put it online:** see `docs/DEPLOY.md` (Cloudflare Tunnel from your computer, Fly.io, or any Docker host).
- **Tested:** `npm test` runs 76 tests, including photo edits (rotate/crop/square/brightness, revert, object removal changing only the painted area), eBay helpers (redirect parsing, friendly errors, account-deletion challenge, sign-in return address), smart price advice and traffic diagnosis. Earlier: 62 tests, including the inventory views, bins and packing-slip data, returns and partial refunds, the mileage log and after-gas profit, and Shippo label buying (demo mode). Of the earlier tests, 56, including barcodes, lots (both directions and restock), bundle suggestions, multi-buy, weekly summary scheduling, the Pirate Ship round trip and cancellations/returns. The earlier 39 tests cover covering fee math, crosslisting, auto-delist, multi-quantity, variations (per-option listings, sell-out delist, restock relist), oversell alerts, Terapeak import and pricing, sourcing verdicts, reports, email parsing/matching/confirmation, the password gate and the HTTP API. The database migration was checked on an existing database with no data lost, and the extension was tested end to end against a mock listing form.
- **Barcode lookups** (Open Library, UPCitemdb) couldn't be reached from the build sandbox, so they're tested with stand-in services. Live camera scanning needs HTTPS (or localhost); over plain home Wi-Fi the scanner reads a photo of the barcode instead.
- **Pirate Ship has no public API.** The integration uses its spreadsheet import and shipment-history export. Exported orders carry an "Order ID" of `FD-<sale>` so labels match back exactly.
- **eBay label costs** come from the Finances API (`sell.finances` scope). If you connected eBay before this update, reconnect once.
- **Variations on Poshmark, Depop and Etsy** are listed as one listing per option for now. Those sites do support multi-size listings, but the extension can't reliably fill their multi-size forms yet.
- **Sale-email wording** is matched by common phrases plus title scoring, not by fixed templates. If a site's emails slip through, paste one into Settings, Sale emails, Test to see why.
- **Not yet tested against live accounts:** the eBay, Etsy and Shopify API calls (they need your keys), the live AI call, and the extension selectors on the real sites. Expect to tweak `extension/sites.js` the first time you use each site.
- **Amazon** runs in demo mode until you have SP-API approval. Listings must match an existing Amazon product (ASIN) and many categories are gated.
- **Sales on extension-only sites** are recorded with **Mark sold**, or by the extension calling `POST /api/ext/sold`. Detecting them automatically is on the roadmap.
- **Single user, local only:** the server binds to 127.0.0.1. Accounts, auth and billing come with "product mode".

## Roadmap ideas

- Sold-comps pricing through eBay's Marketplace Insights API (needs partner approval)
- Multi-size listings filled by the extension on Poshmark and Depop
- Live tests of Clipdrop / Photoroom / remove.bg and the eBay Media + Analytics APIs (coded to their documented APIs; this build had no keys)
- Live Shippo test against a real key (the code follows Shippo's documented shipments/transactions API, but this build ran in demo mode)
- Product mode: users, Postgres, Stripe billing, hosted image CDN
