/**
 * Front-door protections (see docs/SECURITY.md for the review behind them).
 *
 * - Security headers: no framing (clickjacking), no MIME sniffing, a strict content policy for the app,
 *   and a sandbox for uploaded photos so a file can never run script on FlipDesk's address.
 * - Host check (DNS rebinding): when FlipDesk listens on this computer only, requests must be addressed to
 *   localhost or your own address (PUBLIC_BASE_URL / FLIPDESK_ALLOWED_HOSTS), so a web page can't trick
 *   your browser into talking to your local FlipDesk under another name.
 * - Same-site check (CSRF): changes (POST/PUT/PATCH/DELETE) from another website are refused. The Chrome
 *   extension, phone links and webhooks are allowed: they carry their own tokens/signatures.
 * - Rate limits on sign-in, sign-up and password-reset requests per IP address.
 */
import type { NextFunction, Request, Response } from "express";

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=()");
  // Uploaded photos: shown as images only, never as a page that could run script.
  if (req.path.startsWith("/uploads/")) res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  else res.setHeader("Content-Security-Policy", APP_CSP);
  if (req.secure || req.headers["x-forwarded-proto"] === "https") res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const hostname = (h: string) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]).toLowerCase();

/** Is FlipDesk only reachable from this computer? (HOST unset or a loopback address) */
export const localOnly = () => !process.env.HOST || LOOPBACK.has(process.env.HOST);

export function allowedHosts() {
  const set = new Set(LOOPBACK);
  for (const u of [process.env.PUBLIC_BASE_URL]) {
    try {
      if (u) set.add(new URL(u).hostname.toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  for (const h of (process.env.FLIPDESK_ALLOWED_HOSTS ?? "").split(",")) if (h.trim()) set.add(h.trim().toLowerCase());
  return set;
}

export function hostGuard(req: Request, res: Response, next: NextFunction) {
  if (!localOnly()) return next(); // public servers sit behind HTTPS + sign-in; their Host varies (custom domains)
  const h = hostname(String(req.headers.host ?? ""));
  if (!h || allowedHosts().has(h)) return next();
  res.status(421).type("text/plain").send(`FlipDesk doesn't answer to "${h}". If this is your own address, add it to PUBLIC_BASE_URL or FLIPDESK_ALLOWED_HOSTS.`);
}

/** Paths that legitimately receive cross-site requests (they authenticate themselves). */
const CROSS_SITE_OK = /^\/api\/(ext\/|m\/|billing\/webhook$|ebay\/account-deletion$)/;

export function sameSiteGuard(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || CROSS_SITE_OK.test(req.path)) return next();
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "cross-site") return void res.status(403).json({ error: "Blocked: this request came from another website." });
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers.host ?? "").toLowerCase()) return void res.status(403).json({ error: "Blocked: this request came from another website." });
    } catch {
      return void res.status(403).json({ error: "Blocked: bad Origin header." });
    }
  } else if (origin === "null") return void res.status(403).json({ error: "Blocked: this request came from a sandboxed page." });
  next();
}

/** Simple in-memory limiter: at most `max` hits per `windowMs` per key (IP). */
export function rateLimit(max: number, windowMs: number, message: string) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? req.socket.remoteAddress ?? "?";
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - list[0])) / 1000)));
      return void res.status(429).json({ error: message });
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear(); // never grow without bound
    next();
  };
}
