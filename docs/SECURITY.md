# Security review (November 2026)

A focused review of sign-in, invites, payments, shared links, uploads and the front door, before inviting other sellers. What was checked, what was found, and what changed.

## Fixed in this review

| Risk | What could happen | Fix |
|---|---|---|
| **Owner takeover on a fresh server** | Right after deploying with accounts on, the first person to sign up becomes the owner. A stranger could get there first. | On a public server, the first account must use `FLIPDESK_OWNER_EMAIL`; without it, sign-up refuses. |
| **DNS rebinding (local mode)** | A web page could point its own domain at 127.0.0.1 and talk to your local FlipDesk (no password needed locally). | When FlipDesk listens on this computer only, it answers only to localhost, your `PUBLIC_BASE_URL` host and `FLIPDESK_ALLOWED_HOSTS` (421 otherwise). |
| **Cross-site requests (CSRF)** | Another website could submit a form (e.g. a file upload) to your FlipDesk while you're signed in, or to a local one with no password. | Changes from another site are refused (Origin / Sec-Fetch-Site checks). The extension, phone links and webhooks are exempt: they carry their own tokens and signatures. |
| **Password guessing** | The single-password sign-in had no limit. | Per-address limits on sign-in (30 / 15 min), sign-up (10 / hour) and password-reset requests (10 / hour), on top of the per-account limit. |
| **Clickjacking / content injection** | FlipDesk could be framed by another site; no content policy. | `X-Frame-Options: DENY`, a strict Content-Security-Policy (scripts only from FlipDesk), `nosniff`, a referrer policy, and HSTS on HTTPS. |
| **Uploaded files** | An uploaded file served from FlipDesk's address could act as a page. | Every upload is re-encoded to JPEG already; uploads are now also served with a sandboxing policy. Upload names carry 96 random bits (were 32). |
| **Extension token check** | Compared with `!==` (timing). | Constant-time comparison. |
| **A settings route shadowing the Inbox** | Found during the phone check: the quiet-hours settings used `/api/alerts`, so the owner's Inbox received the wrong data. | Moved to `/api/alert-settings`; a test now fails if any server-wide route ever shadows a shop route again. |

## Checked and fine

- **Passwords**: scrypt with a per-user salt, constant-time comparison; reset and session tokens are stored only as SHA-256 hashes; resets are one-use, expire (1 h emailed / 24 h owner-made) and sign the person out everywhere.
- **Reset links** always use `PUBLIC_BASE_URL`, never the address in the request, so they can't be pointed elsewhere.
- **Cookies**: HttpOnly, SameSite=Lax, Secure on HTTPS.
- **Shared sample shop links**: read-only (every change refused), no access to admin, export, backups or status.
- **Owner-only areas** (accounts, backups, restore, help articles, payments mode, launch checklist) check the owner on every request.
- **Stripe webhooks**: signature checked in constant time with a 5-minute window; live and test endpoints use separate secrets.
- **Restore**: only the owner; backup names are pattern-checked; paths inside a backup can't escape the data folder; databases are checked before being swapped in, and the replaced files are kept.
- **Personal keys** (mailbox, Shippo, Etsy, Shopify, extension token) apply only to the owner's real shop, never to other accounts or sample shops.
- **Outgoing requests to addresses people type** (photo links) refuse private networks and follow redirects safely.
- **Rendering**: React escapes everything; the help/announcement mini-markdown only links to app pages or `https://` addresses.
- **Problem reports** leave out notes, bin locations, buyer details and all tokens.

## Known limits (accepted for now)

- Single-password mode uses one long-lived session cookie per password; changing the password signs everyone out.
- Sign-up says when an email already has an account (sign-up is invite-only, so this reveals little).
- Rate limits are per server process and reset on restart.
- Photos are public to anyone with their exact (random) address, because eBay and the extension need to fetch them.

If you find a problem, use 💬 Send feedback (or email the owner) rather than posting it publicly.
