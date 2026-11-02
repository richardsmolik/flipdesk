# Your first real eBay check (about 10 minutes)

The goal: prove FlipDesk talks to **your real eBay account** correctly, without listing or changing anything.

## Before you start
- eBay developer keys in FlipDesk's settings (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`) with `EBAY_ENV=production`. See [EBAY_SETUP.md](EBAY_SETUP.md) if you haven't done that yet.
- FlipDesk open in your browser, signed in.

## Steps
1. **Marketplaces → Connect eBay.** Sign in to eBay and allow FlipDesk. You come back to FlipDesk with eBay shown as connected.
2. **Settings → eBay:** pick your shipping, payment and return policies and your ship-from location. If the lists are empty, use the button there to turn on business policies, or create a location.
3. **Marketplaces → eBay → Run the weekly check now.** This is the read-only check: nothing is listed or changed. It checks:
   - your account answers;
   - your chosen policies and ship-from location exist;
   - category lookup works;
   - the sales feed works.
4. Press **📋 Copy results** and paste them into a message to me (Claude), passed or not. Nothing secret is in it: just the steps, times and eBay's own words.
5. Optional, after that passes: list **one real, cheap item** from FlipDesk, watch it appear on eBay, then end it from FlipDesk. Copy anything odd you see.

## If something fails
The failing step says why in plain words. A **problem report** is saved with eBay's exact answers (no tokens). Inbox → **📮 Send report** sends it to GitHub, so the failure can be replayed and fixed without your account.
