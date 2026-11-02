# Put FlipDesk online (HTTPS)

Why bother: with a public HTTPS address,
- eBay sign-in returns straight to FlipDesk (no relay page needed),
- eBay can fetch your photos directly,
- your phone's camera can scan barcodes live in sourcing mode, from anywhere,
- it runs 24/7, so sales are caught and items delisted even when your laptop is closed,
- and it's the first step toward offering FlipDesk to other resellers.

FlipDesk **refuses to start on a public address without a password**, so your data is never exposed by accident.

---

## Option A: Keep it on your computer, add a free HTTPS address (Cloudflare Tunnel)

Best while it's just you. Free, and your data stays at home. The address only works while your computer is on.

1. Install `cloudflared` (macOS: `brew install cloudflared`; Windows/Linux: download from Cloudflare's site).
2. Build and start FlipDesk with a password:

   ```bash
   npm run build
   ```

   ```bash
   FLIPDESK_PASSWORD='pick-a-strong-one' npm start
   ```

3. In another terminal:

   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```

   It prints an `https://something.trycloudflare.com` address. For a permanent address on your own domain, create a named tunnel in the Cloudflare dashboard (Zero Trust, Networks, Tunnels).
4. Put that address in `.env` as `PUBLIC_BASE_URL=https://…` and restart FlipDesk.
5. eBay: set your RuName's **Auth accepted URL** to `https://…/api/connections/ebay/callback`.

## Option B: Host it on Fly.io (24/7, about $5-10/month)

Best for always-on, and the path to a product. Fly runs the included `Dockerfile` and keeps your database and photos on a persistent disk.

1. Install the Fly CLI and sign up:

   ```bash
   fly auth signup
   ```

2. Edit `fly.toml` and set `app = "flipdesk-yourname"` (must be unique).
3. Create the app, the disk and your secrets (paste your own values):

   ```bash
   fly launch --copy-config --no-deploy
   ```

   ```bash
   fly volumes create flipdesk_data --size 3
   ```

   ```bash
   fly secrets set FLIPDESK_PASSWORD='strong-password' PUBLIC_BASE_URL='https://flipdesk-yourname.fly.dev' ANTHROPIC_API_KEY='…' EBAY_ENV=production EBAY_CLIENT_ID='…' EBAY_CLIENT_SECRET='…' EBAY_RU_NAME='…'
   ```

4. Deploy:

   ```bash
   fly deploy
   ```

5. Open `https://flipdesk-yourname.fly.dev` and sign in with your password.
6. eBay: set your RuName's **Auth accepted URL** to `https://flipdesk-yourname.fly.dev/api/connections/ebay/callback`. For production keys, set the Marketplace Account Deletion endpoint to `https://flipdesk-yourname.fly.dev/api/ebay/account-deletion` and add the same verification token as a secret:

   ```bash
   fly secrets set EBAY_VERIFICATION_TOKEN='…'
   ```

**Backups:** Fly snapshots volumes daily. To take your own copy:

```bash
fly ssh sftp get /data/flipdesk.db ./flipdesk-backup.db
```

**Moving your existing data up:** copy your local `data/flipdesk.db` and the `data/uploads` folder onto the volume (`fly ssh sftp shell`, then `put`) before first use.

## Option C: Any Docker host (Render, Railway, a VPS)

```bash
docker build -t flipdesk .
```

```bash
docker run -d -p 8787:8787 -v flipdesk_data:/data -e FLIPDESK_PASSWORD='…' -e PUBLIC_BASE_URL='https://…' flipdesk
```

Put HTTPS in front (the host's built-in HTTPS, Caddy, or Cloudflare). Mount a persistent disk at `/data`.

---

## The Chrome extension with a hosted FlipDesk

In the extension popup, set the server URL to your HTTPS address and paste the extension token from Settings.

## Letting other resellers use it (accounts)

Set two values and redeploy:

```
FLIPDESK_MULTIUSER=1
FLIPDESK_INVITE_CODE=pick-a-long-code
```

- **Sign up first.** The first account becomes the owner. Sign-ups after that need the invite code. Leave the code blank to close sign-ups.
- **Every account is private.** Each has its own database and photo folder (`data/users/<id>/`) and its own sample shop. Photos have random, public addresses, because eBay and the extension need to fetch them.
- **Your personal keys stay yours.** Your mailbox (`IMAP_*`), Shippo, Etsy, Shopify and `FLIPDESK_TOKEN` only work in the owner's real shop. Everyone shares the app-level keys: your eBay developer app (each person still clicks Connect eBay with their own eBay login), Anthropic for the AI writer, and the photo AI keys. **You pay for their AI use**, so invite people you trust, or watch your Anthropic usage.
- **Phones and the extension just work.** Phone links and extension tokens start with the shop's id (like `u3.`), so the server knows where they belong.
- **Back up `data/`** (the Fly volume). It holds `accounts.db` and every shop.

- **AI spending cap.** Everyone except you gets `FLIPDESK_AI_DAILY_LIMIT` AI requests a day (default 40; listing writer, photo AI and sourcing each count one). Their sample shop shares the same allowance. Over the cap, they can still list by hand. Change it per person on the **Accounts** page.
- **Accounts page (owner only).** Who signed up, items, sales, AI used today, per-person AI limit, a **Reset link** button, and delete.
- **Forgot password.** With `SMTP_*` and `PUBLIC_BASE_URL` set, "Forgot password?" emails a 1-hour, one-time link. The link always uses `PUBLIC_BASE_URL`, never the address in the request, so nobody can make it point somewhere else. Without email, use the owner's Reset link button and send it yourself. Changing a password through a link signs that person out everywhere.
- **Share links.** Settings → Sample shop → Make a share link: a read-only view of your sample shop for anyone, no sign-up. Turn it off any time. It shows how many times it was opened.
- **Leaderboard (opt-in).** People who join with a nickname are ranked each week by how close they are to their goals, then return on cost. Only percentages and counts are shown, never dollars.
- **Help videos.** Settings → Help videos: paste a Loom/YouTube link per "Get started" step, and everyone sees "▶ Watch" under it.

- **Invite links.** Accounts → Invite links: one link per person (with a note like "Sam"). Each works once, the Accounts list shows who invited whom, and you can turn off unused links. The shared `FLIPDESK_INVITE_CODE` still works if you set it.
- **Feedback.** Everyone has "💬 Send feedback" in the sidebar. It lands on your Accounts page with the page they were on and any recent errors, and pings your phone (your ntfy topic) and email.

- **Announcements.** Accounts → Announcements: a title, optional details and a link (`/bundles` or `https://…`), shown once at the top of everyone's dashboard until they close it, for 3 days up to "until removed". You see how many saw and closed it.
- **How FlipDesk is doing.** The top of the Accounts page: members, active sellers per week, paying vs trial, trial → paid %, monthly revenue estimate (`FLIPDESK_PRICE_MONTHLY`), and AI requests per week with a cost estimate (`FLIPDESK_AI_COST_PER_CALL`, default $0.04).
- **Status page.** Tools → Status answers "is it me or FlipDesk?": your eBay connection, sync queue, Chrome extension check-ins, AI allowance, plus AI, eBay, email, backups and payments. It uses real results from the last calls and refreshes every 30 seconds. The feedback form points there first.

- **Your weekly report.** On your weekly-summary day and hour you get a push + email: members and new sign-ups, active sellers vs last week, paying and trials ending, AI requests and cost, open feedback, referrals, reminder emails sent, outages, and the last backup and restore check. Accounts page shows it live, with **Send it now**.
- **Outage alerts.** When AI, eBay or email fails 3 times in a row (`FLIPDESK_INCIDENT_AFTER`), you get a push and email, and everyone sees a "Heads up: eBay is having trouble right now" announcement pointing to Status (`FLIPDESK_AUTO_ANNOUNCE=0` to keep it to you). When it works again, the announcement comes down and you get "✅ working again (down for 12 min)". Status shows recent problems. A failed nightly backup alerts you too.
- **Reminder emails** (needs SMTP): a heads-up 3 days before a free trial ends, and a "we miss you" note after 14 days away (at most once a month). Both include the person's own numbers ("you added 34 items, sold 12, made $412") and the latest announcement. Each person can turn them off in Settings → Your account.
- **Ask FlipDesk.** The ❓ Help button (and Tools → Help) answers how-to questions from FlipDesk's own docs (this file, the README and the eBay guide). With an Anthropic key, Claude answers in plain steps with links to the right page; each question counts as one AI request. Without a key, it shows the best-matching guide sections.

## Charging for it (Stripe)

1. In Stripe: **Products → Add product**, monthly price (e.g. $19). Copy the price id (`price_...`).
2. **Developers → API keys**: copy the secret key (`sk_live_...`, or `sk_test_...` to try it with test cards).
3. **Developers → Webhooks → Add endpoint**: `https://<your address>/api/billing/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret (`whsec_...`).
4. **Settings → Billing → Customer portal**: turn it on (lets people update cards and cancel).
5. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, and optionally `FLIPDESK_TRIAL_DAYS` (14), `FLIPDESK_PRICE_LABEL` ("$19/month"), `FLIPDESK_AI_PAID_LIMIT` (200).

**Referrals:** members get their own invite links (Your plan → Invite a friend; on by default when billing is on, `FLIPDESK_MEMBER_INVITES=0` to turn off). When someone they invited **starts paying**, they get one free month, once per friend: a Stripe credit worth one month on their next bill if they're subscribed, otherwise 30 more days of trial. They get an email about it when email is set up.

How it behaves:
- New accounts start a free trial. Subscribing during the trial doesn't charge until the trial ends.
- When a trial ends without a plan, the shop turns **read-only**: everything stays viewable and downloadable, nothing new can be listed or edited, and sales still delist everywhere (no overselling). Subscribing turns it back on within seconds.
- People who joined before billing was turned on, and anyone you tick "free" for on the Accounts page, stay free.
- FlipDesk never sees card numbers: Stripe Checkout and the Stripe portal handle them.

## Backups

- **Nightly**, FlipDesk saves a .zip of every real shop (database + photos), the accounts and server settings to `data/backups/` and keeps the newest 7 (`BACKUP_KEEP`). Settings → Nightly backups shows the last one, has **Back up now**, and lets you download any copy.
- **Off-site:** set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` (and `BACKUP_S3_REGION`, "auto" for R2). Cloudflare R2 is free up to 10 GB: create a bucket, then an R2 API token with write access; the endpoint is `https://<account id>.r2.cloudflarestorage.com`.
- **Restore check (monthly):** FlipDesk unpacks the newest backup in a scratch folder, opens every database and runs SQLite's integrity check, and verifies photo checksums (up to 300). The result shows in Settings and on Status, and you're alerted if it fails. **Check** next to any backup runs it on demand.
- **Restore in the app:** Settings → Nightly backups → **Restore…** on any backup. Pick what to put back (your shop, one person's shop, sign-ins, server settings), type RESTORE. FlipDesk first makes a fresh backup (your undo) and moves the replaced files to `data/restore-trash/` instead of deleting them.
- **Restore by hand** (if the server won't start): stop FlipDesk, unzip the backup, copy `shop/flipdesk.db` to `data/flipdesk.db` and `shop/uploads/` to `data/uploads/` (accounts mode: `users/<id>/…` to `data/users/<id>/…`, plus `accounts.db` and `site.db` to `data/`), then start FlipDesk.
- **Everyone can download their own data** any time: Settings → Download all my data (spreadsheets, photos and the database in one .zip).

Still to do as it grows: moving to Postgres + object storage once you have more than a few dozen sellers.

## Becoming a product (later)

What changes when lots of resellers use it:
- **One eBay developer app for everyone:** customers just click "Connect eBay"; no keys or relay page. (Accounts mode already works this way.)
- **Database:** move from SQLite (one file per shop) to Postgres; photos move to object storage (S3/R2).
- **Billing:** Stripe subscriptions.
- **eBay compliance:** keep the account-deletion endpoint running (in accounts mode it clears buyer data in every shop), and follow eBay's API License Agreement data rules.
