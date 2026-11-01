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

- **Tested:** `npm test` runs 39 tests covering fee math, crosslisting, auto-delist, multi-quantity, variations (per-option listings, sell-out delist, restock relist), oversell alerts, Terapeak import and pricing, sourcing verdicts, reports, email parsing/matching/confirmation, the password gate and the HTTP API. The database migration was checked on an existing database with no data lost, and the extension was tested end to end against a mock listing form.
- **Variations on Poshmark, Depop and Etsy** are listed as one listing per option for now. Those sites do support multi-size listings, but the extension can't reliably fill their multi-size forms yet.
- **Sale-email wording** is matched by common phrases plus title scoring, not by fixed templates. If a site's emails slip through, paste one into Settings, Sale emails, Test to see why.
- **Not yet tested against live accounts:** the eBay, Etsy and Shopify API calls (they need your keys), the live AI call, and the extension selectors on the real sites. Expect to tweak `extension/sites.js` the first time you use each site.
- **Amazon** runs in demo mode until you have SP-API approval. Listings must match an existing Amazon product (ASIN) and many categories are gated.
- **Sales on extension-only sites** are recorded with **Mark sold**, or by the extension calling `POST /api/ext/sold`. Detecting them automatically is on the roadmap.
- **Single user, local only:** the server binds to 127.0.0.1. Accounts, auth and billing come with "product mode".

## Roadmap ideas

- Sold-comps pricing through eBay's Marketplace Insights API (needs partner approval)
- Multi-size listings filled by the extension on Poshmark and Depop
- Barcode / UPC scan in sourcing mode for books, media and toys
- Shipping labels and packing slips, plus a printable SKU/bin label
- Product mode: users, Postgres, Stripe billing, hosted image CDN
