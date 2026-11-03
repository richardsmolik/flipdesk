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
| **AI while you shoot** | Photos from your phone (QR link or Shoot mode) trigger the AI a few seconds after your last shot. The draft (title, price, details, flaws to check) appears on your computer and phone. Only empty fields are filled; nothing you typed is overwritten. |
| **Phone app + Shoot mode** | Install FlipDesk to your home screen. Shoot mode works with no signal: items and photos are saved on the phone (shrunk to save space) and upload automatically when you're back online, then AI drafts them. Offline opening needs your online HTTPS address. |
| **Today: do these 3** | The dashboard picks your three most valuable jobs right now: oversells, late orders (oldest first), failed syncs, offers to watchers, the single best price drop (one-click **Do it** updates every site), drafts to finish, falling behind on a goal. Skip hides one until tomorrow. |
| **Weekly goals** | "List 30 items, sell 12, $500 profit": progress bars with a marker for where you should be by now, a daily "about N a day" catch-up number, and the result in your Monday summary. Weeks run Monday to Sunday in your time zone. |
| **Sample shop** | One click opens a separate shop full of fake items, sales and orders, to try everything or show someone. It never touches your real shop, eBay, mailbox or label account. Reset or delete it any time. |
| **Keyboard shortcuts** | `n` new listing, `/` search, `⌘/Ctrl+S` save, `g` then a letter to jump (`g i` inventory, `g h` shipping...), `?` for the full list. |
| **Accounts (host it for others)** | `FLIPDESK_MULTIUSER=1`: email sign-up (invite code), a private shop per person with its own sample shop, and your personal keys stay in your shop. A daily AI cap per person (you're unlimited), an owner **Accounts** page (usage, limits, reset links, delete), forgot-password emails, and change password. See `docs/DEPLOY.md`. |
| **Paid plans (Stripe)** | Optional: free trial, then a monthly plan through Stripe Checkout, card updates and cancelling in Stripe's portal. When a trial ends, the shop turns read-only (still viewable, downloadable, and sales still delist everywhere). Higher AI allowance with a plan; "free forever" switch per person. |
| **Invite links** | One link per person that works once. See who invited whom, and turn off unused links. |
| **Feedback** | "💬 Send feedback" sends the owner a note with the page and any recent errors, to the Accounts page, phone and email. |
| **Weekly email** | The Monday summary can also arrive by email. |
| **Backups and your data** | Nightly .zip of every shop and its photos (newest 7 kept), optional upload to Cloudflare R2 / Backblaze B2 / S3, **Back up now** and download. Anyone can download all their data (spreadsheets, photos, database) in one .zip. |
| **Announcements** | Post "New: …" or "Heads up: …" once; it shows at the top of everyone's dashboard until they close it. See how many saw it. |
| **How FlipDesk is doing** | For the owner: members, weekly active sellers, paying vs trial, trial → paid %, revenue estimate, AI requests and cost per week (charts with hover and a table view). |
| **Referrals** | Members make their own invite links; when a friend starts paying they get a free month (Stripe credit or extra trial days), once per friend. |
| **Restore in the app** | Pick a backup and what to put back (one shop, everyone, sign-ins, settings). An undo backup is made first and replaced files are kept. |
| **Status page** | "Is it me or FlipDesk?": your eBay connection, sync queue, extension check-ins and AI allowance, plus AI, eBay, email, backups and payments, from real recent results. |
| **Ask FlipDesk** | ❓ Help answers "how do I…" from FlipDesk's own guide (Claude with the docs cached, or guide search without a key), with links to the right page. |
| **Outage alerts** | When AI, eBay or email keeps failing, the owner gets a push + email and everyone sees a "Heads up" announcement, which comes down by itself when it's fixed. |
| **Owner's weekly report** | Members, active sellers, paying, AI cost, feedback, outages and backups, every week by push and email. |
| **Reminder emails** | Trial ending in 3 days, or 14 days away: a friendly email with the person's own numbers. Opt-out in Settings. |
| **Backup restore check** | Monthly (or on demand), the newest backup is unpacked and checked (database integrity + photo checksums), so you know it would actually restore. |
| **Calm alerts** | Short blips aren't paged, several problems arrive as one message, and quiet hours hold alerts overnight (with a "while you were away" note in the morning). |
| **Help insights** | Owner sees what people ask Help most, which questions had no good answer, and 👍/👎 ratings, to know what to explain or simplify. |
| **Win-back offer** | When a trial ends without a plan: one email with % off the first month, applied automatically at checkout. |
| **Uptime check** | `/healthz` for free uptime monitors (UptimeRobot, Better Stack), so you're texted if the whole server goes down. |
| **"What's new" drafts** | One click turns recent updates into a seller-friendly announcement to edit and post. |
| **Launch checklist** | Owner page that checks everything before real use (HTTPS, sign-in, keys, eBay, email with a test button, phone alerts, uptime monitor, backups, payments) with a fix for each. |
| **Help articles** | Turn a question Help couldn't answer into a short article (AI-drafted from your docs); Help and the AI use it from then on. |
| **Payments test mode** | Test and live Stripe keys side by side, a switch on the Accounts page, and a clear "TEST mode" bar for everyone. |
| **Cancellation reasons** | From Stripe's cancel page or one tap in FlipDesk; summarized for the owner. |
| **Day-3 check-in** | A "need a hand?" email when a new member hasn't added anything by day 3. |
| **Your first week** | A 7-day plan on the dashboard (one small step a day, ticked off automatically), a welcome email with the plan, and a guide Help can answer from (`docs/FIRST_WEEK.md`). |
| **Problem reports** | When a crosslist/delist/price change fails for good, FlipDesk saves exactly what happened (no tokens or buyer details): 📋 report on the Sync queue. `npx tsx scripts/replay.ts report.json` replays it to reproduce the bug. |
| **Security** | Reviewed before inviting others: owner lock for new servers, protection from other websites and rebinding, sign-in rate limits, strict content policy. See `docs/SECURITY.md`. |
| **Speed and phones** | Lists load in one batch (inventory 3x faster, stale-listing tool 8x), large shops page with "Show more", gzip. Every screen checked at phone size (`node scripts/phone-check.mjs`). `npx tsx scripts/perf.ts 2000` times every screen. |
| **Two-step sign-in** | Authenticator-app codes plus recovery codes, for every account (and single-password mode). |
| **Activity log** | Owner sees sign-ins (and failed ones), account changes, invites, backups/restores, payments and alert settings. |
| **Send problem reports** | The Inbox asks before anything is sent; a yes files a GitHub issue with the replayable report (members' reports go to the owner first). |
| **Nightly checks** | On the server: speed, database health, disk space, with alerts. On GitHub: tests, build, phone check and speed check every night, opening an issue on failure. |
| **eBay end-to-end test** | One click lists and ends a test item on eBay's sandbox, step by step, and cleans up. |
| **Passkeys** | Sign in with Face ID, a fingerprint, Windows Hello or your phone: no password, no code, can't be phished. |
| **New-device alerts** | A new browser signing in gets you an email or phone alert with a "this wasn't me" link that signs everyone out. |
| **Weekly eBay check** | Every week by itself: the full test on the sandbox, a read-only check on a real account (policies, location, categories, sales feed). |
| **Speed trend** | Status shows each screen this week vs last week; the weekly report and GitHub flag real slowdowns. |
| **Updates tried on a copy first** | Database updates run on a copy and are checked (nothing lost, nothing broken) before touching your data; `npm run rehearse` tries a new version on a backup before you deploy. |
| **Passkey-only sign-in** | Turn off password sign-in once you have two passkeys; recovery codes for emergencies. |
| **Suspicious sign-in codes** | A new device right after wrong passwords must also type a code sent by email or phone alert. |
| **Go back a version** | Status lists the versions that ran; one button (or automatically, if an update can't open your data) goes back to the last good one. |
| **Speed in real use** | Each screen's real loading time for the people using it, with an alert when one gets slow. |
| **Pick your AI** | Claude, ChatGPT, Gemini (AI Studio), Kimi or DeepSeek, in your order, falling back automatically; keys pasted in Settings. |
| **AI spending limits** | Real per-call costs by AI, feature and member; monthly and per-member limits with alerts. |
| **Public status page** | `/uptime` for anyone: what's working, 30-day uptime and past problems (opt-in). |
| **Fire drill** | Monthly practice recovery from your newest backup, with a "you'd be back in N minutes" estimate. |
| **AI backtest** | Each AI prices items you already sold, knowing only what you knew at listing time; scored against the real sale price and days to sell, next to your own prices. |
| **AI that learns from results** | Corrects each AI's measured price lean, gets a second AI's opinion on pricier items, compares AI titles with yours, a monthly AI report card, and AI cost per sale. |
| **Price-drop backtest** | Replays drop rules (including yours) on past sales: how much sooner, for how much less. Free, no AI. |
| **Why this price** | Each AI price shows its reasoning, range, confidence, the comps it saw, and any correction or second opinion. |
| **Fresh titles for old listings** | AI rewrites titles of 30+ day unsold items using titles that sold; live eBay listings update instantly; results tracked. |
| **Best AI per category** | The price test finds the best AI per category; items can go to it first. |
| **One-page AI summary** | Printable month: time saved, spend, cost per sale, accuracy, lessons. |
| **Edits reach every listing** | Saved changes update eBay, Etsy and Shopify at once; extension sites get a guided checklist with copy buttons. |
| **History, undo and "did it help?"** | Every change to an item, where it went, views before vs after, and one-tap undo on every site. |
| **Batched sending** | Gather edits and send them every 15 min / hour / 4 hours, or right away. |
| **Price-drop rules per category** | The drop test picks the best rule per category; automatic drops follow it. |
| **This week's 5 things** | One ranked to-do list on the dashboard and in the Monday summary. |
| **Monthly AI summary email** | Last month's summary with a PDF, in the first week of each month. |
| **Share a sample shop** | A read-only link to your sample shop that anyone can open without signing up. Shows how often it was opened; turn it off any time. |
| **Leaderboard** | Opt-in, for friends on the same FlipDesk: weekly goal progress and return on cost (percentages only, never dollars). |
| **Help videos** | Paste a Loom/YouTube link for any "Get started" step and it appears as "▶ Watch". |
| **Guided first run** | Three quick questions (where you sell, what you sell, how much) set your default marketplaces, sourcing targets and label choice (Pirate Ship if you don't sell on eBay). A dashboard checklist then ticks itself off from what you actually do: connect eBay, add an item, crosslist it, install the extension, phone alerts, first sale. Each step has "Show me how" instructions. |
| **Tidy navigation** | Sidebar grouped into Sell / Source / Ship / Money / Tools / Setup, with collapsible groups and live badges (inbox alerts, orders to ship, drafts, failed syncs). On phones, a bottom tab bar: Home, Shoot, Inventory, Ship, More. |
| **Switch to FlipDesk** | Guided move from Vendoo, List Perfectly, eBay or a spreadsheet: inventory and photos, then sold history, then connect marketplaces. |
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

- **Tested:** 251 tests (history with where each change went; undo restoring old values on eBay and keeping fields changed since; views/day before vs after, watchers, sold-after; batched updates merged and held for the extension and API sites until due or pushed), plus a browser run. Earlier: 246 tests (edits pushed to eBay with price and title, extension jobs carrying what changed, own prices kept, failed updates leave listings live, Shopify prices; category re-check; per-category drop rules applied with "none"; weekly 5 ranking and digest; monthly summary email with a valid PDF, once, opt-out), plus a browser run. Earlier: 238 tests (price-drop replay: schedule, floor, buyer wait, offers, your own rule; per-category winners and routing; Why-this-price saved; fresh title shown similar sold titles, applied and pushed to the live eBay listing; AI summary numbers), plus a browser run. Earlier: 231 tests (price correction from the backtest lean with the 10-item/5% rule and an off switch; second opinion only over the threshold and flagged when 25%+ apart; AI titles matched even with a word added, compared on days to sell and sell-through; monthly report card announcing a new best AI once a month; AI cost per sale for this shop only), plus a browser run. Earlier: 226 tests (AI backtest: only comps from before the listing day, no sale price or date in the prompt, scores and winner, honest baselines, stops at the spending limit; ChatGPT/Gemini/Kimi/DeepSeek requests checked field by field: strict schema or JSON mode, photos as data URLs, models picked from each provider's list, fallback in your order, refusals not retried, photo-blind models skipped; keys never shown back; budgets from real token counts with 80%/100% alerts and pausing; public status without error details; own sign-in history only; fire drill passing and catching a missing photo; newest backup chosen correctly when two share a second), plus a browser run. Earlier: 210 tests (passkey-only: needs two passkeys, password refused, passkeys still work, reset never signs in, recovery code works once and turns it off, owner switch for members, server reset in single mode; suspicious sign-ins: emailed or phoned code after 3 wrong passwords on a new browser, one use, not mixed up with two-step, known browsers untouched, can be turned off; versions remembered, the owner's go-back button switching the Fly machine image with its settings kept, safe mode page plus automatic go-back; real-use speed grouping, slowdown and too-slow rules, owner-only, one alert a day, weekly report line), plus a browser run on desktop and phone. Earlier: 198 tests (passkeys with a simulated authenticator: add, sign in without password or code, one-use challenges, look-alike site refused, per-account, removed with the account; new-device alerts once per browser, "this wasn't me" signs everyone out, removes new passkeys, sends a reset link and works once; weekly eBay check read-only on real accounts, catching a deleted policy, Inbox alert cleared on the next pass, full test on the sandbox; week-over-week speed with the 25%+30 ms rule; updates tried on a copy: passing, data loss stopped, broken links stopped, failed update leaves data untouched, automatic on start-up, newest 3 copies kept; the deploy rehearsal script), plus a browser run with a virtual passkey device. Earlier: 179 tests (two-step sign-in: setup, code step, no reuse, recovery codes, 5-try limit, reset never signs in, single-password mode kills the old cookie; activity log; problem reports to GitHub and through the owner; owner check covers every admin route; self-check and slowdown rule; eBay sandbox test passing, failing with a report and cleanup, refusing production), plus a browser run. Earlier: 167 tests (security headers, upload sandbox, host and cross-site checks, sign-in rate limit, owner lock, no route shadowing; every main screen under 1.5 s at 1,500 items and paged inventory; a failed eBay job saves a report that replays to the same error; extension failure reports; first-week steps and welcome email), plus a phone check of 23 screens and a browser run with the content policy on. Earlier: 156 tests (articles drafted from 👎 questions, searched first and given to the AI after the cached docs; day-3 email once and not for active people; cancellation reasons from the app and Stripe without double counting; test/live switch with per-mode webhooks and subscriptions; launch checklist turning green), plus a browser run. Earlier: 149 tests (/healthz up, strict, and 503 when data is unreadable; blips not paged, bundled alerts, quiet hours with a morning note; Help questions grouped, unanswered and 👎 flagged; win-back coupon made once and applied at checkout; what's-new from git, skipping internal updates, Claude draft links only to app pages), plus a browser run. Earlier: 140 tests (owner report content and once-a-week timing; outage opened after 3 failures with announcement, closed on recovery, owner-only option; reminder emails once each, with numbers, opt-out; help: guide search without AI, and the exact Claude request with cached docs, fallback and low effort; restore check passes, catches a damaged backup and alerts), plus a browser run. Earlier: 133 tests (announcements seen/closed/archived; usage weeks, cost estimate, conversion; referrals: member links, +30 trial days or a one-month Stripe credit, once per friend; status from real call results per shop; restore one person's shop with undo backup and kept files, restore sign-ins/settings and keep working), plus a browser run of all of it. Earlier: 126 tests (invite links: one use, who invited whom, turn off; Stripe: signature check, trial → read-only → Checkout → webhooks → active → cancel, comp, no charge during trial; feedback inbox; weekly email; zip round-trip; full data export reopens as a working database; nightly backups skip sample shops and are owner-only; S3 signing matches AWS's published example), plus a browser run of invite → sign-up → trial banner → plan page → feedback → owner inbox → backup. Earlier: 116 tests (AI cap per account incl. sample shop, owner unlimited, 429 before calling Claude; forgot/reset links only to PUBLIC_BASE_URL, one use, signs out everywhere; owner reset links, change password, delete account; read-only share links; opt-in leaderboard with no dollar amounts; help videos https-only), plus a browser run with an owner, a friend and a stranger opening a share link. Earlier: 109 tests (today's top 3 and one-click price drop, goals and Monday-start weeks across time zones, sample shop open/leave/reset/delete with uploads, phone links and extension tokens routed to the right shop, personal keys kept out of other shops, accounts: owner, invite code, privacy between accounts, login limits), plus a browser run of the sample shop, shortcuts, goals and sign-up. Earlier: 99 tests (first-run defaults that never overwrite your own settings, checklist ticking from real activity, nav badges), plus a browser run of the welcome, checklist and phone tab bar. Earlier: 95 tests (AI-while-you-shoot debounce and "only empty fields", phone-app files), plus a browser run of Shoot mode that went offline, reopened the app with no signal, and synced two items into AI drafts when back online. Earlier: 92 tests, including phone upload links (token-only, expiry, no other access), photo-fingerprint duplicates, and sold-history import feeding reports and price advice. Earlier: 86 tests, including real iPhone HEIC conversion, EXIF rotation and GPS stripping, bulk grouping, spreadsheet import with photo download, and private-network protection for photo links.
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
