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

## Becoming a product (later)

What changes when other resellers use it:
- **One eBay developer app for everyone:** customers just click "Connect eBay"; no keys or relay page.
- **Accounts:** add users and sign-up, and give every table an `account_id`.
- **Database:** move from SQLite to Postgres; photos move to object storage (S3/R2).
- **Billing:** Stripe subscriptions.
- **eBay compliance:** keep the account-deletion endpoint running, and follow eBay's API License Agreement data rules.
