# List on your real eBay account with FlipDesk

About 20 minutes, once. After that, connecting is one click and listing is one click.

> Why there's any setup: FlipDesk runs on *your* computer, so for now you register your own (free)
> eBay developer app. When FlipDesk is a hosted product, customers skip all of this and just click
> "Connect eBay".

## 1. Get eBay developer keys (free)

1. Go to **developer.ebay.com** and click **Register**. Use your real name; the developer account is separate from your seller account.
2. Open **Application Keys** and click **Create a keyset** under **Production**. Name it "FlipDesk".
3. eBay asks about **Marketplace Account Deletion** notifications before turning on production keys:
   - **Running FlipDesk only on your computer:** choose the option saying you're **exempt** (you don't run a public service for other people's eBay data).
   - **Hosted FlipDesk** (see `DEPLOY.md`): enter `https://YOUR-FLIPDESK/api/ebay/account-deletion` and a verification token (32-80 letters/numbers). Put the same token in `.env` as `EBAY_VERIFICATION_TOKEN`.
4. Copy the **App ID (Client ID)** and **Cert ID (Client Secret)**.

## 2. Put the sign-in relay page online (free, 2 minutes)

eBay only sends you back to an **https** address. This tiny page receives eBay's answer and passes it straight back to FlipDesk on your computer, so signing in looks automatic.

Pick one:

- **Netlify Drop (easiest):** go to **app.netlify.com/drop** and drag the `docs/ebay-relay` folder onto the page. Copy the `https://….netlify.app` address it gives you.
- **Cloudflare Pages:** create a project, upload the `docs/ebay-relay` folder, and copy the `https://….pages.dev` address.
- **GitHub Pages:** only free if the repo is public (or you have GitHub Pro). In repo Settings, Pages, deploy from `main`, folder `/docs`. The address is `https://YOUR-NAME.github.io/flipdesk/ebay-relay/`.

## 3. Create your RuName (eBay's name for your sign-in redirect)

1. On developer.ebay.com, go to **User Tokens** for your Production keyset.
2. Click **Get a Token from eBay via Your Application**, then **Add eBay Redirect URL**.
3. Fill in:
   - **Display title:** FlipDesk
   - **Privacy policy URL:** any page you control (the relay address works)
   - **Auth accepted URL:** your relay address from step 2
   - **Auth declined URL:** the same relay address
   - Tick **OAuth** (not Auth'n'Auth).
4. Save, then copy the **RuName** (looks like `Richard_Smolik-Richard-FlipDe-abcdefgh`).

## 4. Configure FlipDesk

In the `flipdesk` folder, copy `.env.example` to `.env` and set:

```
EBAY_ENV=production
EBAY_CLIENT_ID=<App ID>
EBAY_CLIENT_SECRET=<Cert ID>
EBAY_RU_NAME=<RuName>
ANTHROPIC_API_KEY=<optional: for the AI listing writer>
```

Then start it:

```bash
npm install
npm run dev
```

Open **http://localhost:5173**.

## 5. Run the eBay setup checklist (Marketplaces page)

Each step has a button that does it for you:

1. **Connect eBay:** sign in to your seller account and click **Agree**. You come right back to FlipDesk, connected.
2. **Turn on business policies:** eBay can take a few minutes to apply this.
3. **Choose policies:** in Settings, under eBay listing policies, click **Load from eBay** and pick your shipping, payment and return policies. No policies yet? Create them in Seller Hub (Account, Business policies), then load again.
4. **Register ship-from location:** fill in your ship-from address in Settings, then click **Register**.

When the card says **"eBay is ready to list"**, you're set.

## 6. List your first item

1. **New listing:** drop in your photos (JPG/PNG). Photos are uploaded to eBay's own photo hosting automatically.
2. Review the title, description, condition and price.
3. Tick **eBay**. FlipDesk shows the eBay category and any **required item specifics** that are missing (for example Department or Size Type for clothing). Pick them from eBay's list and click **Save**.
4. Click **Crosslist**. The eBay listing link appears in a few seconds.

## Good to know

- FlipDesk can only manage listings **it creates**. Listings you made in Seller Hub stay as they are; eBay doesn't let apps edit those through this API without migrating them first.
- New eBay listings may take a minute to show up in search.
- Everything uses eBay's official seller APIs (Inventory, Account, Taxonomy, Media, Fulfillment), the same ones big listing tools use.
- If something fails, FlipDesk shows eBay's own error message in plain words on the item and in the Sync queue.
