/**
 * Speed from real use: times every screen's data request as people actually use FlipDesk (with their real
 * amounts of data), not just the 800-item test shop. Kept in memory per day (up to 500 timings per screen),
 * summarized hourly into 14 days of history. Nothing about what's in the request is kept: only the screen and how long.
 */
export interface RealRow { path: string; n: number; p50: number; p95: number; errors: number }
export interface RealDay { day: string; rows: RealRow[] }

const MAX = 500;
let today = new Date().toISOString().slice(0, 10);
let samples = new Map<string, { ms: number[]; n: number; errors: number }>();

/** "/api/items/123/photos?x=1" -> "/api/items/:id/photos"; keeps ?view= (each inventory tab is its own screen). */
export function screenOf(url: string): string | null {
  const [p, q = ""] = url.split("?");
  if (!p.startsWith("/api/") || /^\/api\/(health|auth|login|passkeys|m\/|ext\/|share|selfcheck|real-speed)/.test(p)) return null;
  const view = new URLSearchParams(q).get("view");
  const norm = p.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:token");
  return view && /^[a-z]+$/.test(view) ? `${norm}?view=${view}` : norm;
}

/** Older days are summarized by flush() before a new day starts (the caller passes it in). */
export function recordTiming(url: string, ms: number, ok: boolean, onNewDay?: (d: RealDay) => void, now = new Date()) {
  const s = screenOf(url);
  if (!s) return;
  const day = now.toISOString().slice(0, 10);
  if (day !== today) {
    if (samples.size) onNewDay?.({ day: today, rows: summarize() });
    samples = new Map();
    today = day;
  }
  let e = samples.get(s);
  if (!e) samples.set(s, (e = { ms: [], n: 0, errors: 0 }));
  e.n++;
  if (!ok) e.errors++;
  // Reservoir sample: a fair 500 of the day's timings, however many there were.
  if (e.ms.length < MAX) e.ms.push(ms);
  else {
    const j = Math.floor(Math.random() * e.n);
    if (j < MAX) e.ms[j] = ms;
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : 0;
};
export function summarize(): RealRow[] {
  return [...samples.entries()].map(([path, e]) => ({ path, n: e.n, p50: pct(e.ms, 50), p95: pct(e.ms, 95), errors: e.errors })).sort((a, b) => b.n - a.n);
}
export const currentDay = () => ({ day: today, rows: summarize() });
export const resetRealSpeed = () => void ((samples = new Map()), (today = new Date().toISOString().slice(0, 10)));

/** Put today's (or a finished day's) summary into the 14-day history. */
export function mergeDay(history: RealDay[], d: RealDay) {
  return [d, ...history.filter((h) => h.day !== d.day)].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
}

const NAMES: Record<string, string> = {
  "/api/items?view=inventory": "Inventory", "/api/items?view=selling": "Selling", "/api/items?view=unsold": "Not sold", "/api/items?view=drafts": "Drafts", "/api/items?view=sold": "Sold",
  "/api/items/:id": "An item", "/api/dashboard": "Dashboard", "/api/today": "Today", "/api/reports": "Reports", "/api/sales": "Sales", "/api/shipping": "Shipping", "/api/alerts": "Inbox",
  "/api/jobs": "Queue", "/api/bundles/suggestions": "Bundles", "/api/tools/stale": "Stale listings", "/api/items-counts": "Inventory tabs", "/api/nav-counts": "Menu counts", "/api/status": "Status",
};
export const screenName = (p: string) => {
  if (NAMES[p]) return NAMES[p];
  const t = p.replace(/^\/api\//, "").replace(/\/:(id|token)/g, "").replace(/[/_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Latest day vs the days before it. Slower = p50 at least 50% and 100 ms above its usual (median of earlier days),
 * with 20+ uses so a single slow moment doesn't count. "Too slow" = p95 over 2 s with 20+ uses, whatever the history.
 */
export function realTrend(history: RealDay[]) {
  const [latest, ...before] = history;
  if (!latest) return null;
  const rows = latest.rows.map((r) => {
    const past = before.map((d) => d.rows.find((x) => x.path === r.path)?.p50).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    const usual = past.length ? past[Math.floor(past.length / 2)] : null;
    return { ...r, name: screenName(r.path), usual, slower: usual !== null && r.n >= 20 && r.p50 >= usual * 1.5 && r.p50 - usual >= 100, tooSlow: r.n >= 20 && r.p95 > 2000 };
  });
  return { day: latest.day, rows, slower: rows.filter((r) => r.slower), tooSlow: rows.filter((r) => r.tooSlow), uses: rows.reduce((a, r) => a + r.n, 0) };
}
