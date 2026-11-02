/**
 * Paid plans with Stripe (hosted / accounts mode only). Off until STRIPE_SECRET_KEY and STRIPE_PRICE_ID are set;
 * until then everyone uses FlipDesk free.
 *
 * - New accounts get a free trial (FLIPDESK_TRIAL_DAYS, default 14).
 * - Subscribe = Stripe Checkout (Stripe hosts the card form; FlipDesk never sees card numbers).
 * - Manage / cancel = Stripe's customer portal.
 * - Stripe tells FlipDesk about changes through a signed webhook (STRIPE_WEBHOOK_SECRET).
 * - When a trial ends without a plan, the shop turns read-only: data stays viewable and exportable,
 *   and selling-safety jobs (delist when sold) keep running.
 */
import crypto from "node:crypto";
import type { Db } from "../db.js";

// ---------------- Test vs live ----------------
// Set STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET for live, and STRIPE_TEST_SECRET_KEY /
// STRIPE_TEST_PRICE_ID / STRIPE_TEST_WEBHOOK_SECRET for test. The owner flips between them (Accounts page);
// with only one set, that one is used. Subscriptions made in one mode never count in the other.
export type StripeMode = "test" | "live";
let chosenMode: StripeMode | null = null;
export const setStripeMode = (m: StripeMode | null) => void (chosenMode = m);
const hasLive = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const hasTest = () => Boolean(process.env.STRIPE_TEST_SECRET_KEY && process.env.STRIPE_TEST_PRICE_ID);
/** Which set of keys is in use. */
export function stripeKeySet(): StripeMode {
  if (chosenMode === "test" && hasTest()) return "test";
  if (chosenMode === "live" && hasLive()) return "live";
  return hasLive() ? "live" : "test";
}
export const stripeKey = () => (stripeKeySet() === "test" ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY);
export const stripePriceId = () => (stripeKeySet() === "test" ? process.env.STRIPE_TEST_PRICE_ID : process.env.STRIPE_PRICE_ID);
/** Is money real right now? Judged by the key itself (sk_test_ / rk_test_ never charge cards). */
export const stripeIsTest = () => /^(sk|rk)_test_/.test(stripeKey() ?? "");
/** The label stored with each customer/subscription. */
export const currentStripeMode = (): StripeMode => (stripeIsTest() ? "test" : "live");
export const webhookSecrets = () =>
  [
    { secret: process.env.STRIPE_WEBHOOK_SECRET, mode: (/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "") ? "test" : "live") as StripeMode },
    { secret: process.env.STRIPE_TEST_WEBHOOK_SECRET, mode: "test" as StripeMode },
  ].filter((x): x is { secret: string; mode: StripeMode } => Boolean(x.secret));
export const stripeModes = () => ({ live: hasLive(), test: hasTest(), using: stripeKeySet(), testing: stripeIsTest() });

export const billingEnabled = () => Boolean(stripeKey() && stripePriceId());
export const trialDays = () => {
  const n = Number(process.env.FLIPDESK_TRIAL_DAYS);
  return process.env.FLIPDESK_TRIAL_DAYS && Number.isFinite(n) && n >= 0 ? n : 14;
};
export const paidAiLimit = () => {
  const n = Number(process.env.FLIPDESK_AI_PAID_LIMIT);
  return process.env.FLIPDESK_AI_PAID_LIMIT && Number.isFinite(n) && n >= 0 ? n : 200;
};

export type PlanStatus = "owner" | "free" | "trial" | "active" | "past_due" | "expired";

export interface BillingRow {
  id: number;
  email: string;
  is_owner: number;
  plan: string | null; // Stripe subscription status, or "comp" (owner gave it free)
  trial_ends_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  stripe_mode?: string | null; // "test" | "live": where the customer/subscription lives
}

const parseTime = (s: string | null) => (s ? Date.parse(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z")) : NaN);

export function planStatus(u: BillingRow, now = Date.now()): PlanStatus {
  if (u.is_owner) return "owner";
  if (u.plan === "comp") return "free";
  // A subscription from the other Stripe mode (e.g. made while testing) doesn't count now.
  const otherMode = Boolean(u.stripe_mode && u.stripe_mode !== currentStripeMode());
  if (otherMode) u = { ...u, plan: null };
  if (u.plan === "active" || u.plan === "trialing") return "active";
  if (u.plan === "past_due") return "past_due"; // Stripe is retrying the card: keep working meanwhile
  if (!billingEnabled()) return "free";
  const trialEnd = parseTime(u.trial_ends_at);
  if (!u.trial_ends_at) return "free"; // joined before billing existed
  return trialEnd > now ? "trial" : "expired";
}

export function billingSummary(u: BillingRow, now = Date.now()) {
  const status = planStatus(u, now);
  const trialEnd = parseTime(u.trial_ends_at);
  return {
    enabled: billingEnabled(),
    status,
    canWrite: status !== "expired",
    trialEndsAt: u.trial_ends_at,
    trialDaysLeft: status === "trial" ? Math.max(0, Math.ceil((trialEnd - now) / 86400_000)) : null,
    renewsAt: u.current_period_end,
    hasCustomer: Boolean(u.stripe_customer_id) && (!u.stripe_mode || u.stripe_mode === currentStripeMode()),
    testMode: billingEnabled() && stripeIsTest(),
    price: process.env.FLIPDESK_PRICE_LABEL || null, // e.g. "$19/month", shown on the plan page
  };
}

// ---------------- Stripe API (form-encoded REST, no SDK needed) ----------------

function form(obj: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== "") p.append(k, String(v));
  return p;
}

async function stripe<T>(path: string, body: URLSearchParams): Promise<T> {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${stripeKey()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = (await r.json()) as T & { error?: { message?: string } };
  if (!r.ok) throw Object.assign(new Error(`Stripe: ${j.error?.message ?? r.status}`), { status: 502 });
  return j;
}

export async function stripeGet<T>(pathName: string): Promise<T> {
  const r = await fetch(`https://api.stripe.com/v1/${pathName}`, { headers: { Authorization: `Bearer ${stripeKey()}` } });
  const j = (await r.json()) as T & { error?: { message?: string } };
  if (!r.ok) throw Object.assign(new Error(`Stripe: ${j.error?.message ?? r.status}`), { status: 502 });
  return j;
}
export const stripePost = <T>(pathName: string, body: Record<string, string | number | undefined>) => stripe<T>(pathName, form(body));

const sameMode = (u: BillingRow) => !u.stripe_mode || u.stripe_mode === currentStripeMode();

export async function checkoutUrl(u: BillingRow, base: string, opts: { coupon?: string } = {}) {
  const trialEnd = Math.floor(parseTime(u.trial_ends_at) / 1000);
  // Subscribing early? Don't charge until the free trial would have ended (Stripe needs 48h+ notice).
  const keepTrial = Number.isFinite(trialEnd) && trialEnd > Date.now() / 1000 + 48 * 3600;
  const s = await stripe<{ url: string }>(
    "checkout/sessions",
    form({
      mode: "subscription",
      "line_items[0][price]": stripePriceId(),
      "line_items[0][quantity]": 1,
      success_url: `${base}/billing?done=1`,
      cancel_url: `${base}/billing`,
      client_reference_id: String(u.id),
      customer: sameMode(u) ? u.stripe_customer_id ?? undefined : undefined,
      customer_email: sameMode(u) && u.stripe_customer_id ? undefined : u.email,
      "subscription_data[metadata][user_id]": String(u.id),
      "subscription_data[trial_end]": keepTrial ? trialEnd : undefined,
      // A win-back offer applies its coupon automatically (Stripe allows either a discount or a code box, not both).
      "discounts[0][coupon]": opts.coupon,
      allow_promotion_codes: opts.coupon ? undefined : "true",
    }),
  );
  return s.url;
}

export async function portalUrl(u: BillingRow, base: string) {
  if (!u.stripe_customer_id || !sameMode(u)) throw Object.assign(new Error("No billing account yet. Subscribe first."), { status: 400 });
  const s = await stripe<{ url: string }>("billing_portal/sessions", form({ customer: u.stripe_customer_id, return_url: `${base}/billing` }));
  return s.url;
}

/** Stripe-Signature check: HMAC-SHA256 of "<t>.<raw body>" with the webhook secret, within 5 minutes. */
export function verifyWebhook(raw: Buffer, header: string | undefined, secret: string, now = Date.now()) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
  const sigs = header.split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

const iso = (unix: number | undefined | null) => (unix ? new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) : null);

/** Apply a Stripe event to the accounts database. Returns what changed (for logs/tests). */
export function applyStripeEvent(accounts: Db, ev: { type: string; data: { object: Record<string, unknown> } }, mode: StripeMode = currentStripeMode()) {
  const o = ev.data.object as {
    id?: string;
    customer?: string;
    subscription?: string;
    client_reference_id?: string;
    status?: string;
    current_period_end?: number;
    cancel_at_period_end?: boolean;
    items?: { data?: { current_period_end?: number }[] };
    metadata?: { user_id?: string };
    cancellation_details?: { reason?: string | null; feedback?: string | null; comment?: string | null };
  };
  if (ev.type === "checkout.session.completed") {
    const id = Number(o.client_reference_id);
    if (!id) return null;
    accounts
      .prepare("UPDATE users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id), plan = CASE WHEN plan = 'trialing' THEN plan ELSE 'active' END, stripe_mode = ? WHERE id = ?")
      .run(o.customer ?? null, o.subscription ?? null, mode, id);
    return { userId: id, plan: "active" };
  }
  if (ev.type.startsWith("customer.subscription.")) {
    const byMeta = Number(o.metadata?.user_id) || 0;
    const row = (byMeta
      ? accounts.prepare("SELECT id FROM users WHERE id = ?").get(byMeta)
      : accounts.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(o.customer ?? "")) as { id: number } | undefined;
    if (!row) return null;
    const status = ev.type === "customer.subscription.deleted" ? "canceled" : (o.status ?? "active");
    const periodEnd = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
    accounts
      .prepare("UPDATE users SET plan = ?, stripe_subscription_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), current_period_end = ?, stripe_mode = ? WHERE id = ?")
      .run(status, o.id ?? null, o.customer ?? null, iso(periodEnd), mode, row.id);
    // Why they left (Stripe's cancel page can ask; enable "cancellation reason" in the customer portal settings).
    const cd = o.cancellation_details;
    const canceling = status === "canceled" || o.cancel_at_period_end === true;
    const cancellation = canceling && cd && (cd.feedback || cd.comment) ? { reason: cd.feedback ?? "other", comment: cd.comment ?? "" } : null;
    return { userId: row.id, plan: status, canceling, cancellation };
  }
  return null;
}

/** Win-back offer: percent off the first month for people whose trial ended (FLIPDESK_WINBACK_PCT, default 20; 0 = off). */
export const winbackPct = () => {
  const raw = process.env.FLIPDESK_WINBACK_PCT;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) ? Math.max(0, Math.min(90, n)) : 20;
};

/** Create (once) the Stripe coupon the win-back offer uses. */
export async function createWinbackCoupon(pct: number) {
  const c = await stripe<{ id: string }>("coupons", form({ percent_off: pct, duration: "once", name: `Come back: ${pct}% off your first month` }));
  return c.id;
}
