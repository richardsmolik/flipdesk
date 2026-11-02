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

Set these and redeploy:

```
FLIPDESK_MULTIUSER=1
FLIPDESK_OWNER_EMAIL=you@example.com
FLIPDESK_INVITE_CODE=pick-a-long-code   # optional: invite links work without it
```

`FLIPDESK_OWNER_EMAIL` is required on a public server: only that email can create the first (owner) account, so nobody can sign up before you and take over.

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

- **Calmer alerts.** Problems fixed within 10 minutes (`FLIPDESK_ALERT_AFTER_MINUTES`) are only logged, never paged. Several problems at once arrive as one message. **Quiet hours** (Settings → Problem alerts, default 10 pm-7 am in your time zone): nothing pings you at night; whatever is still broken when they end arrives then, and anything that fixed itself overnight comes as one "while you were away" note.
- **What people ask Help.** Accounts → shows the topics people ask about most, the questions with no good answer (nothing in the guide, the AI unsure, or a 👎), and how often answers helped. It's in your weekly report too. Use it to decide what to explain better, record a help video for, or simplify.
- **"What's new" drafts.** Accounts → Announcements → **✨ Draft from recent updates** reads the updates since your last "what's new" post (from git, or GitHub via `FLIPDESK_GITHUB_REPO` on Fly/Docker, plus `GITHUB_TOKEN` for a private repo), skips internal ones (tests, chores), and writes a seller-friendly announcement (Claude with a key, a plain list without). Edit it, then Post.

- **Help articles.** Next to each unanswered Help question: **✍️ Write an answer** drafts a short article from your docs (Claude with a key, a starter template without). Edit and save it: Help shows it first and the AI uses it from then on, and that question leaves the unanswered list. All your articles are listed there to edit or remove.
- **Day-3 check-in** (needs SMTP): someone who hasn't added an item by day 3 gets one "need a hand?" email with the three quickest ways to start (Shoot mode, import, sample shop).
- **Launch checklist** (Setup → Launch checklist, owner only): HTTPS address, sign-in, lasting disk, AI key, eBay keys/connection/policies, email (with a **Send test email** button), phone alerts, uptime monitor (✅ once UptimeRobot/Better Stack has checked `/healthz`), backups, off-site copy, restore check, invites, payments mode and webhook. Each item says how to fix it.

## Security

See `docs/SECURITY.md` for the review and what's protected. Two settings matter when hosting:
- `FLIPDESK_OWNER_EMAIL` (accounts mode, above).
- With a Cloudflare Tunnel (Option A) FlipDesk still listens only on your computer, so it only answers to `localhost` and the host in `PUBLIC_BASE_URL`. Set `PUBLIC_BASE_URL` to your tunnel address (or add the host to `FLIPDESK_ALLOWED_HOSTS`), or you'll see "FlipDesk doesn't answer to …".

## Safety and quality extras

- **Two-step sign-in.** Settings → Two-step sign-in: scan the QR code with an authenticator app (Google Authenticator, 1Password, Authy…), type the code, and save the 10 recovery codes. From then on, sign-in asks for the 6-digit code after your password; codes can't be reused, and five wrong codes end the attempt. Turning it on signs out your other devices. A password-reset link never signs anyone in by itself while it's on. Works for every account and for single-password mode (`FLIPDESK_PASSWORD`). The launch checklist reminds the owner to turn it on.
- **Activity log** (Settings, owner only): sign-ins and failed sign-ins (with IP address), sign-ups, password changes and resets, two-step on/off, invites, account changes and deletions, backups, downloads and restores, payment mode and alert settings, share links, announcements. Searchable; the newest 20,000 events are kept.
- **Problem reports, with your OK.** When a sync fails for good, the Inbox asks: **📮 Send report** (optionally with a note) or **See what's in it**. On your shop, a yes files a GitHub issue on `FLIPDESK_GITHUB_REPO` (needs `GITHUB_TOKEN` with Issues: write) with the readable summary and the replayable report. Members' reports go to your feedback inbox first, where **Send to GitHub** forwards them. Nothing is sent without someone saying yes.
- **Nightly self-check** (on the server): times the main screens on a scratch shop of 800 items, runs SQLite's quick check on every database, and checks free disk space. It keeps 14 nights of results and alerts you when something breaks or a screen gets clearly slower than usual (2x its usual time and over 300 ms). It shows on Status and the launch checklist.
- **Nightly GitHub check** (`.github/workflows/nightly.yml`): every night and on every push, GitHub runs the type check, all tests, a build, the phone-size check of every screen, the speed check (compared with the last run) and the update rehearsal. A failed nightly run opens an issue.
- **eBay end-to-end test** (Marketplaces): one click lists a test item on eBay's **sandbox**, ends it and cleans up, timing each step. If a step fails it says which one and why, and saves a problem report with eBay's exact answers. It refuses production keys unless you confirm a real listing for a few seconds.
- **Passkeys** (Settings → Passkeys): sign in with Face ID, Touch ID, Windows Hello, an Android phone or a security key, with no password and no code. A passkey counts as both steps of two-step sign-in and only works on your FlipDesk address, so a look-alike site can't phish it. Passkeys belong to `PUBLIC_BASE_URL`'s address: set it before adding any, and if you ever move FlipDesk to a new address, add them again there. Keep your password: it's the way back in if you lose every device.
- **New-device alerts.** The first time a browser signs in to an account, the account gets an email (hosted) or a phone alert plus an Inbox note (single-password mode): which device, its IP address, when and how. The **this wasn't me** link opens a page whose button signs out every device, removes any passkeys added since, and sends a password-reset link. Just opening the link does nothing, so email scanners that follow links can't trigger it. Settings → Signed-in devices lists the browsers and has **Sign out everywhere else**. In single-password mode that also ends the older password cookie; then change `FLIPDESK_PASSWORD`.
- **Weekly eBay check** (on by default once eBay is connected; Marketplaces → eBay to turn it off or run it now). On the sandbox it runs the full end-to-end test. On a real account it's **read-only**: nothing is listed or changed. It checks that your chosen policies and ship-from location still exist on eBay and that category lookup and the sales feed answer. A failure goes to the Inbox with a problem report; the next pass clears it.
- **Speed this week vs last week** (Status, owner): each screen's speed from the nightly self-checks, compared with the week before. "Slower" needs both +25% and +30 ms, so tiny screens jittering never count. The owner's weekly report gets one ⚡ line. In GitHub, each nightly run compares with the previous run and puts a table in the run summary, with a warning when a screen gets clearly slower (+50% and +50 ms, because GitHub's machines vary).
- **Updates are tried on a copy first.** When a new version changes the database, FlipDesk first saves a copy of your data as it is (`data/before-update/`, newest 3 kept). It then runs the update on a second copy and checks that copy: still healthy, no broken links between records, and no items, photos, listings, sales or settings lost. Only then does it update the real database. If the check fails, your data is left exactly as it was and FlipDesk stops with a plain explanation, so you can roll back (`fly releases`, then `fly deploy --image <previous>`). The launch checklist shows the last result. Turn it off with `FLIPDESK_REHEARSE=0` (not recommended).
- **Passkey-only sign-in** (Settings → Passkeys, once you have two passkeys): your password stops working for sign-in, so a leaked or guessed password is useless. Turning it on gives you 10 one-time recovery codes. If you lose every passkey, use "Lost your passkeys? Use a recovery code" on the sign-in screen: one code signs you in once and turns passkey-only off, so you can add new passkeys. A password-reset link never signs anyone in while it's on. Members who lost everything: the owner can switch it off for them on the Accounts page (check it's really them first), then send a reset link. Single-password mode with no codes left: start the server once with `FLIPDESK_PASSKEY_RESET=1`, then remove that setting.
- **Suspicious sign-ins need a code.** A browser the account hasn't used before, signing in right after 3+ wrong passwords in the last hour, must also type a 6-digit code. The code goes by email (hosted) or as a phone alert (single-password mode). Known browsers and normal sign-ins aren't slowed down. With two-step sign-in on, the authenticator code is asked instead. Change the number of wrong tries with `FLIPDESK_SUSPICIOUS_FAILS` (`0` turns this off). With no way to send a code, the sign-in is allowed and noted in the activity log.
- **Going back to the previous version.** Every start notes which version is running (`data/versions.json`), and a version that opens its data and serves is marked as working. Tools → Status → Version lists them, and with `FLY_API_TOKEN` set (`fly tokens create deploy`, then `fly secrets set FLY_API_TOKEN=…`) one button switches the machine back to the last version that worked, keeping its settings. If an update ever can't open your data (it failed its check on a copy), FlipDesk doesn't crash in a loop. It shows a "back in a minute, your data wasn't changed" page, emails `FLIPDESK_OWNER_EMAIL`, and goes back to the last good version by itself (turn that off with `FLIPDESK_AUTO_ROLLBACK=0`). Going back changes the program, not your data.
- **Speed in real use** (Status, owner): how long each screen takes for the people actually using FlipDesk, with their real data: typical time, slowest 1 in 20, and how that compares with the usual. You get one alert a day if a screen gets clearly slower (+50% and +100 ms) or 1 in 20 loads takes over 2 s, and the weekly report gets a 🧭 line. Only the screen and the time are kept, never what's on it.
- **eBay "Copy results to share"** on the eBay test and the weekly check: a plain-text copy of every step and eBay's exact words (no keys or tokens), ready to paste into a message. See [FIRST-EBAY-CHECK.md](FIRST-EBAY-CHECK.md).
- **Public status page** (Tools → Status → Public status page, off by default): `/uptime` shows anyone, without signing in, whether the app, AI, eBay and email are working, 30-day uptime, and the last 30 days of problems (times only, never error details). Share the link so people can check before messaging you.
- **Your own sign-in history** (Settings → Signed-in devices → Recent sign-in activity): everyone, members included, sees their own last 25 sign-ins, failed tries, new devices and security changes, with IP addresses.
- **Fire drill** (Settings → Backups → 🧯 Fire drill, and automatically every month): practises a full recovery from the newest backup in a scratch folder. It unpacks every database and photo, opens each shop with this version, opens every main screen, and checks the photos listings use are all there. It then estimates how long a real recovery would take (download, new server, unpack). A failure alerts you; the launch checklist shows the last result.
- **Try a new version on your real data before deploying it:** download a backup (Settings → Backups → Download), then on your computer, with the new code:

  ```bash
  npm run rehearse -- ~/Downloads/flipdesk-20261102-0300.zip
  ```

  It copies everything to a scratch folder (your file is never changed), updates every shop, checks nothing was lost, opens every main screen and times it. It ends with "✅ Safe to deploy" or "🔴 Don't deploy this version yet" (exit code 1). The nightly GitHub check also runs it on its own test server's data.

## AI: Claude, ChatGPT, Gemini, Kimi, DeepSeek

FlipDesk works with any of these. Add one key or several, either in the server's settings (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`) or by pasting them in **Settings → AI**. Pasted keys are stored on the server, never shown again, and are included in backups.

- **Order and fallback.** Settings → AI lists the ones in use, in order. Each request goes to the first. If it fails (down, overloaded, out of credit, bad answer), the next takes over by itself, and Status shows which one is failing. A refusal is not retried on another AI.
- **Photos vs text.** Photo jobs (listing writer, photo fixes, store scanner) skip models that turn out not to read photos. Tick **Cheapest first for text-only jobs** to send help answers and announcements to the cheapest AI you have.
- **Models.** Claude uses `claude-opus-5-5`. For the others FlipDesk asks each provider for its current model list and picks its newest general model. **Choose…** lets you pick another, and **Test** sends a tiny request and shows the time.
- **Same quality checks everywhere.** Every answer is checked against the same listing format; one that doesn't match falls through to the next AI. ChatGPT and Gemini get the format as a strict schema. Kimi and DeepSeek get JSON mode with the format in the prompt.
- **Privacy.** DeepSeek and Kimi (Moonshot AI) are companies based in China, so photos and text sent to them are processed there. On Google AI Studio's free tier, Google may use what you send to improve its products. Leave a provider out of the list to never use it.
- **Spending.** Every call's tokens are counted and priced at list prices. These are estimates: set what you actually pay under each provider in Settings → AI. Settings → AI shows this month's spend by AI, by feature and by member. Set a **monthly limit**, and (hosted) a **per-member monthly limit**, which doesn't apply to you. You get alerts at 80% and 100%. At the limit AI pauses until the 1st; writing and listing by hand still work.

### Which AI prices best? (backtest on your own sales)

Reports → **Which AI prices best?** tests the AIs you pick on items you've already sold. Each one gets only what was known the day you listed the item: its details (and photos, if you tick that) and comps that had sold before that day. It never sees the sale. FlipDesk then compares each guess with what the item actually sold for, and with how many days it took.

- **Scores:**
  - **Typical miss:** half the guesses were closer than this.
  - **Within 20%.**
  - **Leans:** whether it guesses too high or too low on average.
  - **Average miss in dollars.**
  - **Days-to-sell miss.**
- **Baselines:** your own list price and a plain comp average (no AI), so you can see whether AI beats what you'd do anyway.
- **Before it runs:** it shows how many requests it will make and roughly what they'll cost. Every request counts against the AI budget and allowances, and a run stops if a limit is reached.
- **Results:** a winner needs 5+ answers. If your own prices were closer, it says so. One button puts the winner first for listings. The last 5 runs are kept.
- **Limits of the test:** AIs still know general prices from training, and items edited after selling show their final details. A few items are a hint; 50+ are evidence.

### What FlipDesk learns from your results (Reports → 🧠)

- **Correcting each AI's lean:** if your latest backtest shows an AI guesses too high or too low on your items (10+ items, a lean of 5% or more), its price suggestions are adjusted by that much. The item shows a note such as "ChatGPT guessed 25% too high on your past sales, so its price was adjusted from $200 to $160." On by default; switch it off in the 🧠 card.
- **Second opinion on pricier items:** when the AI prices something at or above your threshold (default $100), the next AI in your list prices it too. If they're more than 25% apart, the item shows both prices so you can check comps before listing. Needs two AIs set up. Each one counts as an AI request.
- **AI titles vs your own:** FlipDesk remembers every title an AI writes. A title counts as the AI's if you kept it or nearly all its words. For items listed in the last year, the card compares AI titles (overall and per AI) with yours on sell-through, days to sell, and sale price as a % of list. This shows how items did, not why.
- **Monthly AI report card** (off by default): once a month, after 10+ new sales and with 2+ AIs set up, the backtest re-runs on your newest 30 sales. An Inbox note and phone alert say which AI is best, and whether that changed.
- **AI cost per sale:** this shop's AI spend over the last 30 days divided by its sales, next to profit per sale and as a share of profit, split by feature. The owner's weekly report includes it too.

## Uptime monitor (recommended)

FlipDesk can't tell you it's down when it's down. A free uptime service can:

1. Sign up at UptimeRobot or Better Stack (both have free plans).
2. Add an HTTP monitor for `https://<your address>/healthz`, every 1-5 minutes, alert by text/email/app.
3. `/healthz` needs no login and answers 200 while FlipDesk can serve, 503 when it can't read its data. Use `/healthz?strict=1` if you also want to be paged while AI/eBay/email/backups have an open outage.

Fly.io's own health check also uses `/healthz` (see `fly.toml`).

## Charging for it (Stripe)

1. In Stripe: **Products → Add product**, monthly price (e.g. $19). Copy the price id (`price_...`).
2. **Developers → API keys**: copy the secret key (`sk_live_...`, or `sk_test_...` to try it with test cards).
3. **Developers → Webhooks → Add endpoint**: `https://<your address>/api/billing/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret (`whsec_...`).
4. **Settings → Billing → Customer portal**: turn it on (lets people update cards and cancel).
5. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, and optionally `FLIPDESK_TRIAL_DAYS` (14), `FLIPDESK_PRICE_LABEL` ("$19/month"), `FLIPDESK_AI_PAID_LIMIT` (200).

**Referrals:** members get their own invite links (Your plan → Invite a friend; on by default when billing is on, `FLIPDESK_MEMBER_INVITES=0` to turn off). When someone they invited **starts paying**, they get one free month, once per friend: a Stripe credit worth one month on their next bill if they're subscribed, otherwise 30 more days of trial. They get an email about it when email is set up.

**Test mode first:** set `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PRICE_ID` and `STRIPE_TEST_WEBHOOK_SECRET` (a second webhook endpoint in Stripe's test mode, same URL) next to the live ones. The Accounts page has a **Test / Live** switch; while in test mode everyone sees a purple "TEST mode: no real charges" bar and the plan page shows the test card (4242 4242 4242 4242). Subscriptions made in test mode never count once you switch to live.

**Why people cancel:** turn on "Cancellation reasons" in Stripe → Settings → Billing → Customer portal, and FlipDesk records them. People who cancel without giving one get a one-tap "what's the main reason?" on their plan page. Reasons show on the Accounts page and in your weekly report.

**Win-back offer:** when someone's trial ended 1-30 days ago without a plan, they get one email with 20% off their first month (`FLIPDESK_WINBACK_PCT`, 0 = off), good for 14 days. FlipDesk creates the coupon in your Stripe account once and applies it automatically at checkout, and the plan page and banner show the offer.

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
