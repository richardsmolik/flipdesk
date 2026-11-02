/**
 * One server, several shops.
 *
 * Single-user (default): your real shop ("main") plus an optional sample shop ("demo") you can open,
 * reset or delete from the app. The FLIPDESK_PASSWORD login (when set) covers both.
 *
 * Hosted for others (FLIPDESK_MULTIUSER=1): people sign up with email + password. Each account gets its
 * own database and photo folder (data/users/<id>/), plus its own sample shop. The first account is the
 * owner: the only shop allowed to use personal keys from .env (your mailbox, Shippo, Etsy, Shopify).
 * Sign-ups after the first need FLIPDESK_INVITE_CODE (sign-ups are closed when it isn't set).
 */
import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod/v4";
import { getSetting, openDb, setSetting, logActivity, type Db } from "./db.js";
import { createApp } from "./app.js";
import { runInWorkspace, setAiGate, type WorkspaceContext } from "./context.js";
import { seedDemo } from "./demo.js";
import { accountDeletionChallenge } from "./marketplaces/ebay.js";
import { goalProgress } from "./services/goals.js";
import { mailConfigured, sendMail } from "./services/mailer.js";
import { applyStripeEvent, billingEnabled, billingSummary, checkoutUrl, createWinbackCoupon, paidAiLimit, planStatus, portalUrl, stripeGet, stripePost, trialDays, verifyWebhook, winbackPct, type BillingRow } from "./services/billing.js";
import { backupAll, exportShop, listBackups, backupDir, s3Configured, verifyBackup, type BackupSource } from "./services/backup.js";
import { weeklySlot } from "./services/digest.js";
import { askHelp, type HelpTurn } from "./services/help.js";
import { draftWhatsNew, recentChanges } from "./services/changelog.js";
import { notify } from "./services/alerts.js";
import { globalCheck, lastSeen, reportHealth, shopCheck, startedAt, stateOf, type Check } from "./health.js";
import { ebayIsLive } from "./marketplaces/ebay.js";
import { extractEntry, zipEntries } from "./services/zip.js";

export interface Workspace extends WorkspaceContext {
  db: Db;
  dbFile: string;
  uploadDir: string;
  app: express.Express;
  userId?: number;
}

export interface Account {
  id: number;
  email: string;
  is_owner: number;
  created_at: string;
}

const KEY_RE = /^(main|demo|u\d+d?)$/;
const readCookie = (req: Request, name: string) =>
  (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
const isHttps = (req: Request) => req.secure || req.headers["x-forwarded-proto"] === "https";
const cookie = (req: Request, name: string, value: string, maxAge: number) =>
  `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;

function hashPassword(pw: string, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class Workspaces {
  readonly multiuser: boolean;
  readonly dataDir: string;
  private readonly mainDb: string;
  private readonly mainUploads: string;
  private readonly password: string;
  private readonly cache = new Map<string, Workspace>();
  accounts: Db | null = null;
  /** Server-wide settings and shared links (both modes). */
  site: Db;
  /** Lets tests and the server know when a sample shop is being built (it takes a second or two). */
  private building = new Map<string, Promise<Workspace>>();

  constructor(opts: { multiuser?: boolean; dataDir?: string; mainDb?: string; mainUploads?: string; password?: string } = {}) {
    this.multiuser = opts.multiuser ?? process.env.FLIPDESK_MULTIUSER === "1";
    this.mainDb = opts.mainDb ?? process.env.FLIPDESK_DB ?? "data/flipdesk.db";
    this.dataDir = opts.dataDir ?? path.dirname(this.mainDb);
    this.mainUploads = opts.mainUploads ?? process.env.FLIPDESK_UPLOADS ?? path.join(this.dataDir, "uploads");
    this.password = opts.password ?? process.env.FLIPDESK_PASSWORD ?? "";
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.multiuser) {
      this.accounts = this.openAccounts();
      setAiGate((ws, kind) => this.chargeAi(ws, kind));
    } else setAiGate(null);
    this.site = this.openSite();
  }

  private openAccounts(): Db {
    const a = new DatabaseSync(path.join(this.dataDir, "accounts.db"));
    a.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
        is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS login_attempts (email TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT);
      CREATE TABLE IF NOT EXISTS ai_usage (user_id INTEGER NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
      CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), used_by INTEGER, used_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS activity_days (user_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY (user_id, day));
      CREATE TABLE IF NOT EXISTS referral_rewards (id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL, referred_id INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS nudges (user_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, kind, ref));`);
    for (const col of ["ai_limit INTEGER", "leaderboard_name TEXT", "plan TEXT", "trial_ends_at TEXT", "stripe_customer_id TEXT", "stripe_subscription_id TEXT", "current_period_end TEXT", "invited_by INTEGER", "email_opt_out INTEGER NOT NULL DEFAULT 0"]) {
      try {
        a.exec(`ALTER TABLE users ADD COLUMN ${col}`);
      } catch {
        /* already there */
      }
    }
    return a as unknown as Db;
  }

  private openSite(): Db {
    const site = new DatabaseSync(path.join(this.dataDir, "site.db"));
    site.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, ws_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), views INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT, page TEXT NOT NULL DEFAULT '', message TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), ends_at TEXT, archived_at TEXT);
      CREATE TABLE IF NOT EXISTS announcement_seen (announcement_id INTEGER NOT NULL, viewer TEXT NOT NULL, seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        dismissed_at TEXT, PRIMARY KEY (announcement_id, viewer));
      CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY, service TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
        last_error TEXT NOT NULL DEFAULT '', announcement_id INTEGER);
      CREATE TABLE IF NOT EXISTS help_questions (id INTEGER PRIMARY KEY, viewer TEXT NOT NULL, question TEXT NOT NULL, page TEXT NOT NULL DEFAULT '',
        answered_by TEXT NOT NULL, top_source TEXT, helpful INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (const col of ["notified_at TEXT", "summarized_at TEXT"]) {
      try {
        site.exec(`ALTER TABLE incidents ADD COLUMN ${col}`);
      } catch {
        /* already there */
      }
    }
    return site as unknown as Db;
  }

  // ---------------- AI cap (hosted) ----------------

  /** Daily AI requests allowed for an account (owner: unlimited). FLIPDESK_AI_DAILY_LIMIT, default 40. */
  aiLimit(userId: number): number | null {
    const u = this.accounts!.prepare("SELECT is_owner, ai_limit FROM users WHERE id = ?").get(userId) as { is_owner: number; ai_limit: number | null } | undefined;
    if (!u || u.is_owner) return null;
    if (u.ai_limit !== null && u.ai_limit !== undefined) return u.ai_limit;
    const status = planStatus(this.billingRow(userId)!);
    if (status === "expired") return 0;
    if (status === "active" || status === "past_due") return paidAiLimit();
    return this.defaultAiLimit();
  }

  billingRow(userId: number) {
    return this.accounts!.prepare("SELECT id, email, is_owner, plan, trial_ends_at, stripe_customer_id, stripe_subscription_id, current_period_end FROM users WHERE id = ?").get(userId) as unknown as
      | BillingRow
      | undefined;
  }

  defaultAiLimit() {
    const raw = process.env.FLIPDESK_AI_DAILY_LIMIT;
    const env = Number(raw);
    return raw && Number.isFinite(env) && env >= 0 ? env : 40;
  }

  aiUsedToday(userId: number) {
    return (this.accounts!.prepare("SELECT calls FROM ai_usage WHERE user_id = ? AND day = date('now')").get(userId) as { calls: number } | undefined)?.calls ?? 0;
  }

  private chargeAi(ws: WorkspaceContext | undefined, _kind: string) {
    if (!ws?.userId || !this.accounts) return;
    const limit = this.aiLimit(ws.userId);
    if (limit !== null && this.aiUsedToday(ws.userId) >= limit)
      throw Object.assign(new Error(`You've used today's ${limit} AI requests. They reset at midnight UTC. You can still write and list items by hand.`), { status: 429 });
    this.accounts
      .prepare("INSERT INTO ai_usage (user_id, day, calls) VALUES (?, date('now'), 1) ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1")
      .run(ws.userId);
  }

  // ---------------- Server-wide settings ----------------

  siteGet<T>(key: string, fallback: T): T {
    const r = this.site.prepare("SELECT value FROM site_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  siteSet(key: string, value: unknown) {
    this.site.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ---------------- Opening shops ----------------

  private location(key: string) {
    if (key === "main") return { dbFile: this.mainDb, uploadDir: this.mainUploads };
    if (key === "demo") return { dbFile: path.join(this.dataDir, "demo", "flipdesk.db"), uploadDir: path.join(this.dataDir, "demo", "uploads") };
    const m = key.match(/^u(\d+)(d?)$/)!;
    const base = path.join(this.dataDir, "users", m[1], m[2] ? "demo" : "");
    return { dbFile: path.join(base, "flipdesk.db"), uploadDir: path.join(base, "uploads") };
  }

  private owns(key: string) {
    if (key === "main") return true;
    if (!this.multiuser || key.endsWith("d") || key === "demo") return false;
    const id = Number(key.slice(1));
    return Boolean((this.accounts!.prepare("SELECT is_owner FROM users WHERE id = ?").get(id) as { is_owner: number } | undefined)?.is_owner);
  }

  exists(key: string) {
    if (!KEY_RE.test(key)) return false;
    if (this.cache.has(key)) return true;
    if (key === "main") return !this.multiuser;
    if (this.multiuser && /^u\d+/.test(key) && !this.accounts!.prepare("SELECT 1 FROM users WHERE id = ?").get(Number(key.slice(1).replace("d", "")))) return false;
    if (key === "demo" && this.multiuser) return false;
    if (key.endsWith("d") || key === "demo") return fs.existsSync(this.location(key).dbFile);
    return true; // a user's real shop is created on first use
  }

  /** Open (and cache) a shop. Returns null for shops that don't exist. */
  get(key: string): Workspace | null {
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.exists(key)) return null;
    const { dbFile, uploadDir } = this.location(key);
    const demo = key === "demo" || /^u\d+d$/.test(key);
    const ctx: WorkspaceContext = {
      key,
      owner: this.owns(key),
      demo,
      urlPrefix: key === "main" ? "/uploads/" : `/uploads/${key}/`,
      tokenPrefix: key === "main" ? "" : `${key}.`,
      userId: key.startsWith("u") ? Number(key.slice(1).replace("d", "")) : undefined,
    };
    const db = openDb(dbFile);
    if (this.multiuser && ctx.userId && !demo) {
      const email = (this.accounts!.prepare("SELECT email FROM users WHERE id = ?").get(ctx.userId) as { email: string } | undefined)?.email;
      if (email) setSetting(db, "accountEmail", email);
    }
    // Accounts are checked in front of the shops when hosted; single-user keeps the shared password.
    const app = createApp(db, { uploadDir, workspace: ctx, password: this.multiuser ? "" : this.password });
    app.set("trust proxy", 1);
    const ws: Workspace = { ...ctx, db, dbFile, uploadDir, app, userId: key.startsWith("u") ? Number(key.slice(1).replace("d", "")) : undefined };
    this.cache.set(key, ws);
    return ws;
  }

  private close(key: string) {
    const ws = this.cache.get(key);
    if (ws) {
      try {
        ws.db.close();
      } catch {
        /* already closed */
      }
      this.cache.delete(key);
    }
  }

  realKey = (userId?: number) => (this.multiuser ? `u${userId}` : "main");
  demoKey = (userId?: number) => (this.multiuser ? `u${userId}d` : "demo");

  /** Build (or rebuild) the sample shop with fresh demo data. */
  async resetDemo(userId?: number): Promise<Workspace> {
    const key = this.demoKey(userId);
    const running = this.building.get(key);
    if (running) return running;
    const p = (async () => {
      this.deleteDemo(userId);
      const { dbFile, uploadDir } = this.location(key);
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const db = openDb(dbFile);
      const ctx = { key, owner: false, demo: true, urlPrefix: `/uploads/${key}/`, tokenPrefix: `${key}.`, userId };
      await runInWorkspace(ctx, () => seedDemo(db, uploadDir));
      setSetting(db, "checklistHidden", true);
      logActivity(db, "info", "This is a sample shop. Nothing here is real, so click anything.");
      db.close();
      return this.get(key)!;
    })();
    this.building.set(key, p);
    try {
      return await p;
    } finally {
      this.building.delete(key);
    }
  }

  deleteDemo(userId?: number) {
    const key = this.demoKey(userId);
    this.close(key);
    const { dbFile, uploadDir } = this.location(key);
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }

  /** Every shop that background jobs should run for (sample shops only process their sync queue). */
  all(): Workspace[] {
    const keys: string[] = [];
    if (this.multiuser) {
      for (const u of this.accounts!.prepare("SELECT id FROM users ORDER BY id").all() as { id: number }[]) keys.push(`u${u.id}`, `u${u.id}d`);
    } else keys.push("main", "demo");
    return keys.filter((k) => this.exists(k)).map((k) => this.get(k)!);
  }

  // ---------------- Accounts (hosted) ----------------

  signupsOpen() {
    if (!this.multiuser) return false;
    const n = (this.accounts!.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    return n === 0 || Boolean(process.env.FLIPDESK_INVITE_CODE) || Boolean(this.accounts!.prepare("SELECT 1 FROM invites WHERE used_at IS NULL AND revoked_at IS NULL").get());
  }

  /** A one-person invite link's token, if it's still usable. */
  private inviteRow(token: string | undefined) {
    if (!token) return undefined;
    return this.accounts!.prepare("SELECT id, created_by FROM invites WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL").get(token) as { id: number; created_by: number | null } | undefined;
  }

  createInvite(createdBy: number, note: string) {
    const token = crypto.randomBytes(12).toString("base64url");
    this.accounts!.prepare("INSERT INTO invites (token, note, created_by) VALUES (?, ?, ?)").run(token, note.slice(0, 80), createdBy);
    return token;
  }

  listInvites() {
    return this.accounts!
      .prepare(
        `SELECT i.id, i.token, i.note, i.created_at, i.used_at, i.revoked_at, u.email AS used_by_email, c.email AS created_by_email
         FROM invites i LEFT JOIN users u ON u.id = i.used_by LEFT JOIN users c ON c.id = i.created_by ORDER BY i.id DESC LIMIT 200`,
      )
      .all() as { id: number; token: string; note: string; created_at: string; used_at: string | null; revoked_at: string | null; used_by_email: string | null; created_by_email: string | null }[];
  }

  signup(email: string, password: string, invite?: string): Account {
    const a = this.accounts!;
    const n = (a.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    let inviteRow: { id: number; created_by: number | null } | undefined;
    if (n > 0) {
      const code = process.env.FLIPDESK_INVITE_CODE;
      inviteRow = this.inviteRow(invite);
      const codeOk = Boolean(code) && (invite ?? "").length === code!.length && crypto.timingSafeEqual(Buffer.from(invite ?? ""), Buffer.from(code!));
      if (!inviteRow && !codeOk) {
        if (!code && !this.signupsOpen()) throw Object.assign(new Error("Sign-ups are closed. Ask the owner for an invite."), { status: 403 });
        throw Object.assign(new Error("That invite isn't valid (it may have been used already). Ask for a new one."), { status: 403 });
      }
    }
    if (a.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw Object.assign(new Error("There's already an account with that email. Sign in instead."), { status: 409 });
    const { salt, hash } = hashPassword(password);
    const id = Number(
      a
        .prepare("INSERT INTO users (email, pass_hash, salt, is_owner, last_login_at, trial_ends_at, invited_by) VALUES (?, ?, ?, ?, datetime('now'), CASE WHEN ? THEN NULL ELSE datetime('now', ?) END, ?)")
        .run(email, hash, salt, n === 0 ? 1 : 0, n === 0 ? 1 : 0, `+${trialDays()} days`, inviteRow?.created_by ?? null).lastInsertRowid,
    );
    if (inviteRow) a.prepare("UPDATE invites SET used_by = ?, used_at = datetime('now') WHERE id = ?").run(id, inviteRow.id);
    return a.prepare("SELECT id, email, is_owner, created_at FROM users WHERE id = ?").get(id) as unknown as Account;
  }

  login(email: string, password: string): Account {
    const a = this.accounts!;
    const recent = (a.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at >= datetime('now','-15 minutes')").get(email) as { n: number }).n;
    if (recent >= 10) throw Object.assign(new Error("Too many tries. Wait 15 minutes and try again."), { status: 429 });
    const u = a.prepare("SELECT * FROM users WHERE email = ?").get(email) as (Account & { pass_hash: string; salt: string }) | undefined;
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt).hash, "hex"), Buffer.from(u.pass_hash, "hex"));
    if (!ok) {
      a.prepare("INSERT INTO login_attempts (email) VALUES (?)").run(email);
      throw Object.assign(new Error("Wrong email or password."), { status: 401 });
    }
    a.prepare("DELETE FROM login_attempts WHERE email = ?").run(email);
    a.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
    return { id: u.id, email: u.email, is_owner: u.is_owner, created_at: u.created_at };
  }

  newSession(userId: number) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.accounts!.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    this.accounts!.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))").run(sha(token), userId);
    return token;
  }

  userFor(req: Request): Account | null {
    const t = readCookie(req, "fd_user");
    if (!t || !this.accounts) return null;
    return (
      (this.accounts
        .prepare("SELECT u.id, u.email, u.is_owner, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')")
        .get(sha(t)) as unknown as Account | undefined) ?? null
    );
  }

  // ---------------- Passwords ----------------

  createReset(userId: number, hours = 1) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.accounts!.prepare("INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))").run(sha(token), userId, `+${hours} hours`);
    return token;
  }

  /** "Forgot password": emails a 1-hour link. Never says whether the email has an account. */
  async forgot(email: string) {
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    // Links only go to your real address (PUBLIC_BASE_URL), never one taken from the request.
    const canEmail = (mailConfigured() || process.env.SMTP_HOST === "test") && Boolean(base);
    const u = this.accounts!.prepare("SELECT id, email FROM users WHERE email = ?").get(email) as { id: number; email: string } | undefined;
    if (u && canEmail) {
      const recent = (this.accounts!.prepare("SELECT COUNT(*) AS n FROM resets WHERE user_id = ? AND created_at >= datetime('now','-1 hour')").get(u.id) as { n: number }).n;
      if (recent < 3) {
        const token = this.createReset(u.id);
        await sendMail(
          u.email,
          "Reset your FlipDesk password",
          `Someone (hopefully you) asked to reset your FlipDesk password.\n\nChoose a new one here (the link works for 1 hour):\n${base}/reset?token=${token}\n\nIf this wasn't you, ignore this email. Your password hasn't changed.`,
        );
      }
    }
    return { ok: true, emailed: canEmail };
  }

  resetPassword(token: string, password: string): Account {
    const a = this.accounts!;
    const r = a.prepare("SELECT user_id FROM resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").get(sha(token)) as { user_id: number } | undefined;
    if (!r) throw Object.assign(new Error("This reset link has expired or was already used. Ask for a new one."), { status: 410 });
    const { salt, hash } = hashPassword(password);
    a.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").run(hash, salt, r.user_id);
    a.prepare("UPDATE resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(r.user_id);
    a.prepare("DELETE FROM sessions WHERE user_id = ?").run(r.user_id); // sign out everywhere
    a.prepare("DELETE FROM login_attempts WHERE email = (SELECT email FROM users WHERE id = ?)").run(r.user_id);
    return a.prepare("SELECT id, email, is_owner, created_at FROM users WHERE id = ?").get(r.user_id) as unknown as Account;
  }

  changePassword(userId: number, current: string, next: string) {
    const u = this.accounts!.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string };
    this.login(u.email, current); // checks it (and counts wrong tries)
    const { salt, hash } = hashPassword(next);
    this.accounts!.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").run(hash, salt, userId);
  }

  /** Remove an account and everything in its shops. The owner can't be removed. */
  deleteAccount(userId: number) {
    const u = this.accounts!.prepare("SELECT is_owner FROM users WHERE id = ?").get(userId) as { is_owner: number } | undefined;
    if (!u) throw Object.assign(new Error("No such account"), { status: 404 });
    if (u.is_owner) throw Object.assign(new Error("The owner account can't be deleted."), { status: 400 });
    this.close(`u${userId}`);
    this.close(`u${userId}d`);
    this.site.prepare("UPDATE shares SET revoked_at = datetime('now') WHERE ws_key IN (?, ?)").run(`u${userId}`, `u${userId}d`);
    this.accounts!.prepare("DELETE FROM users WHERE id = ?").run(userId);
    this.accounts!.prepare("DELETE FROM ai_usage WHERE user_id = ?").run(userId);
    fs.rmSync(path.join(this.dataDir, "users", String(userId)), { recursive: true, force: true });
  }

  adminList() {
    const users = this.accounts!.prepare("SELECT id, email, is_owner, created_at, last_login_at, ai_limit, leaderboard_name, invited_by FROM users ORDER BY id").all() as unknown as (Account & {
      invited_by: number | null;
      last_login_at: string | null;
      ai_limit: number | null;
      leaderboard_name: string | null;
    })[];
    return users.map((u) => {
      const ws = this.get(`u${u.id}`);
      const n = (sql: string) => (ws ? Number((ws.db.prepare(sql).get() as { n: number }).n) : 0);
      return {
        id: u.id,
        email: u.email,
        owner: Boolean(u.is_owner),
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
        items: n("SELECT COUNT(*) AS n FROM items"),
        sales30: n("SELECT COUNT(*) AS n FROM sales WHERE sold_at >= datetime('now','-30 days')"),
        aiToday: this.aiUsedToday(u.id),
        aiLimit: this.aiLimit(u.id),
        aiLimitCustom: u.ai_limit,
        onLeaderboard: Boolean(u.leaderboard_name),
        billing: billingSummary(this.billingRow(u.id)!),
        invitedBy: u.invited_by ? ((this.accounts!.prepare("SELECT email FROM users WHERE id = ?").get(u.invited_by) as { email: string } | undefined)?.email ?? null) : null,
      };
    });
  }

  // ---------------- Leaderboard (hosted, opt-in) ----------------

  /** This week, for people who opted in: goals hit (%) and return on cost (%). No dollar amounts are shared. */
  leaderboard(userId: number) {
    const rows = (this.accounts!.prepare("SELECT id, leaderboard_name FROM users WHERE leaderboard_name IS NOT NULL").all() as { id: number; leaderboard_name: string }[]).map((u) => {
      const ws = this.get(`u${u.id}`)!;
      const g = goalProgress(ws.db);
      const wk = ws.db.prepare("SELECT COALESCE(SUM(profit),0) AS p, COALESCE(SUM(cost),0) AS c, COALESCE(SUM(quantity),0) AS n FROM sales WHERE sold_at >= ?").get(g.weekStart) as { p: number; c: number; n: number };
      return {
        name: u.leaderboard_name,
        me: u.id === userId,
        goalsPct: g.rows.length ? Math.round(g.rows.reduce((t, r) => t + r.pct, 0) / g.rows.length) : null,
        goalsHit: g.rows.filter((r) => r.status === "done").length,
        goalsSet: g.rows.length,
        roiPct: wk.c > 0 ? Math.round((wk.p / wk.c) * 100) : null,
        listed: g.actual.listed,
        sold: Number(wk.n),
      };
    });
    rows.sort((a, b) => (b.goalsPct ?? -1) - (a.goalsPct ?? -1) || (b.roiPct ?? -1) - (a.roiPct ?? -1) || b.sold - a.sold);
    const me = this.accounts!.prepare("SELECT leaderboard_name FROM users WHERE id = ?").get(userId) as { leaderboard_name: string | null };
    return { optedIn: Boolean(me.leaderboard_name), name: me.leaderboard_name, rows };
  }

  // ---------------- Shared read-only sample shop ----------------

  shareFor(wsKey: string) {
    return (this.site.prepare("SELECT token, views, created_at FROM shares WHERE ws_key = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(wsKey) as
      | { token: string; views: number; created_at: string }
      | undefined) ?? null;
  }
  createShare(wsKey: string) {
    const existing = this.shareFor(wsKey);
    if (existing) return existing;
    const token = crypto.randomBytes(16).toString("base64url");
    this.site.prepare("INSERT INTO shares (token, ws_key) VALUES (?, ?)").run(token, wsKey);
    return this.shareFor(wsKey)!;
  }
  revokeShare(wsKey: string) {
    this.site.prepare("UPDATE shares SET revoked_at = datetime('now') WHERE ws_key = ? AND revoked_at IS NULL").run(wsKey);
  }
  shareWorkspace(token: string | undefined): Workspace | null {
    if (!token) return null;
    const r = this.site.prepare("SELECT ws_key FROM shares WHERE token = ? AND revoked_at IS NULL").get(token) as { ws_key: string } | undefined;
    return r ? this.get(r.ws_key) : null;
  }

  // ---------------- Backups ----------------

  /** Every real shop + accounts + server settings. Sample shops are skipped (they can be rebuilt). */
  async backupNow() {
    const sources: BackupSource[] = this.all()
      .filter((w) => !w.demo)
      .map((w) => ({ name: w.key === "main" ? "shop" : `users/${w.userId}`, db: w.db, uploadDir: w.uploadDir }));
    if (this.accounts) sources.push({ name: "accounts.db", db: this.accounts });
    sources.push({ name: "site.db", db: this.site });
    try {
      const r = await backupAll(this.dataDir, sources);
      this.siteSet("lastBackup", { at: r.at, file: path.basename(r.file), bytes: r.bytes, files: r.files, uploaded: r.uploaded, error: r.error ?? null });
      return r;
    } catch (e) {
      this.siteSet("lastBackup", { ...this.siteGet<Record<string, unknown>>("lastBackup", {}), failedAt: new Date().toISOString(), error: (e as Error).message });
      throw e;
    }
  }

  /** Nightly: run when the last backup is 23+ hours old (BACKUP_DISABLED=1 to turn off). */
  async backupIfDue() {
    if (process.env.BACKUP_DISABLED === "1") return null;
    const last = this.siteGet<{ at?: string }>("lastBackup", {});
    if (last.at && Date.now() - Date.parse(last.at) < 23 * 3600_000) return null;
    return this.backupNow();
  }

  // ---------------- Announcements (owner → everyone) ----------------

  /** Active announcements this viewer hasn't dismissed. Marks them seen. */
  announcementsFor(viewer: string) {
    const rows = this.site
      .prepare(
        `SELECT a.id, a.title, a.body, a.link, a.created_at FROM announcements a
         WHERE a.archived_at IS NULL AND (a.ends_at IS NULL OR a.ends_at > datetime('now'))
           AND NOT EXISTS (SELECT 1 FROM announcement_seen s WHERE s.announcement_id = a.id AND s.viewer = ? AND s.dismissed_at IS NOT NULL)
         ORDER BY a.id DESC LIMIT 3`,
      )
      .all(viewer) as { id: number; title: string; body: string; link: string; created_at: string }[];
    for (const r of rows) this.site.prepare("INSERT OR IGNORE INTO announcement_seen (announcement_id, viewer) VALUES (?, ?)").run(r.id, viewer);
    return rows;
  }

  announcementList() {
    return this.site
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM announcement_seen s WHERE s.announcement_id = a.id) AS seen,
           (SELECT COUNT(*) FROM announcement_seen s WHERE s.announcement_id = a.id AND s.dismissed_at IS NOT NULL) AS dismissed
         FROM announcements a ORDER BY a.id DESC LIMIT 50`,
      )
      .all() as Record<string, unknown>[];
  }

  // ---------------- Usage (owner) ----------------

  /** Last N weeks (Monday-start, UTC): active sellers, sign-ups, AI calls + cost estimate; plus today's plan mix. */
  usage(weeks = 12) {
    const a = this.accounts!;
    const costPer = Number(process.env.FLIPDESK_AI_COST_PER_CALL) || 0.04;
    const monday = (d: Date) => {
      const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x;
    };
    const start0 = monday(new Date());
    const rows = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const from = new Date(start0.getTime() - i * 7 * 86400_000);
      const to = new Date(from.getTime() + 7 * 86400_000);
      const f = from.toISOString().slice(0, 10);
      const t = to.toISOString().slice(0, 10);
      const n = (sql: string) => Number((a.prepare(sql).get(f, t) as { n: number }).n);
      const calls = n("SELECT COALESCE(SUM(calls),0) AS n FROM ai_usage WHERE day >= ? AND day < ?");
      rows.push({
        week: f,
        activeSellers: n("SELECT COUNT(DISTINCT d.user_id) AS n FROM activity_days d JOIN users u ON u.id = d.user_id AND u.is_owner = 0 WHERE d.day >= ? AND d.day < ?"),
        signups: n("SELECT COUNT(*) AS n FROM users WHERE is_owner = 0 AND date(created_at) >= ? AND date(created_at) < ?"),
        aiCalls: calls,
        aiCost: Math.round(calls * costPer * 100) / 100,
      });
    }
    const users = a.prepare("SELECT id FROM users WHERE is_owner = 0").all() as { id: number }[];
    const mix: Record<string, number> = { trial: 0, active: 0, past_due: 0, expired: 0, free: 0 };
    let trialsEnded = 0;
    let converted = 0;
    for (const u of users) {
      const b = this.billingRow(u.id)!;
      const st = planStatus(b);
      mix[st] = (mix[st] ?? 0) + 1;
      if (b.trial_ends_at && Date.parse(b.trial_ends_at.replace(" ", "T") + "Z") < Date.now()) {
        trialsEnded++;
        if (st === "active" || st === "past_due") converted++;
      }
    }
    const price = Number(process.env.FLIPDESK_PRICE_MONTHLY) || null;
    return {
      weeks: rows,
      costPerCall: costPer,
      plans: mix,
      members: users.length,
      conversion: { trialsEnded, converted, pct: trialsEnded ? Math.round((converted / trialsEnded) * 100) : null },
      mrr: price ? Math.round(price * (mix.active + mix.past_due) * 100) / 100 : null,
      referrals: Number((a.prepare("SELECT COUNT(*) AS n FROM referral_rewards").get() as { n: number }).n),
    };
  }

  // ---------------- Referrals ----------------

  /** Members can make their own invite links (FLIPDESK_MEMBER_INVITES=1, or by default when billing is on). */
  memberInvitesOn() {
    const v = process.env.FLIPDESK_MEMBER_INVITES;
    return this.multiuser && (v === "1" || (v !== "0" && billingEnabled()));
  }

  /**
   * Someone you invited started paying: you get a free month. With a Stripe subscription, that's a credit
   * on your next invoice; otherwise 30 more days of your trial. Once per person invited.
   */
  async grantReferral(referredId: number) {
    const a = this.accounts!;
    const r = a.prepare("SELECT invited_by, email FROM users WHERE id = ?").get(referredId) as { invited_by: number | null; email: string } | undefined;
    if (!r?.invited_by || a.prepare("SELECT 1 FROM referral_rewards WHERE referred_id = ?").get(referredId)) return null;
    const ref = this.billingRow(r.invited_by);
    if (!ref || ref.is_owner) return null;
    const st = planStatus(ref);
    let kind = "trial_days";
    let detail = "";
    if (st === "free") (kind = "none"), (detail = "already free");
    else if (ref.stripe_customer_id && (st === "active" || st === "past_due")) {
      const price = await stripeGet<{ unit_amount: number; currency: string }>(`prices/${process.env.STRIPE_PRICE_ID}`);
      await stripePost("customers/" + ref.stripe_customer_id + "/balance_transactions", {
        amount: -price.unit_amount,
        currency: price.currency,
        description: "FlipDesk referral: one free month",
      });
      kind = "credit";
      detail = `${(price.unit_amount / 100).toFixed(2)} ${price.currency.toUpperCase()} credit`;
    } else {
      a.prepare("UPDATE users SET trial_ends_at = datetime(MAX(COALESCE(trial_ends_at, datetime('now')), datetime('now')), '+30 days') WHERE id = ?").run(ref.id);
      detail = "+30 days of trial";
    }
    a.prepare("INSERT INTO referral_rewards (referrer_id, referred_id, kind, detail) VALUES (?, ?, ?, ?)").run(ref.id, referredId, kind, detail);
    if (kind !== "none" && (mailConfigured() || process.env.SMTP_HOST === "test")) {
      const masked = r.email.replace(/^(.).*(@.*)$/, "$1…$2");
      void sendMail(ref.email, "You earned a free month of FlipDesk 🎉", `${masked} joined from your invite and just subscribed. Your reward: ${detail}.\n\nThanks for spreading the word!`).catch(() => {});
    }
    return { referrerId: ref.id, kind, detail };
  }

  // ---------------- Restore (owner) ----------------

  /** What's inside a backup: one part per shop, plus sign-ins and server settings. */
  backupContents(name: string) {
    const file = this.backupFile(name);
    const parts = new Map<string, { part: string; label: string; bytes: number; photos: number }>();
    for (const e of zipEntries(file)) {
      if (e.name === "README.txt") continue;
      const m = e.name.match(/^(shop|users\/\d+)\/(flipdesk\.db|uploads\/.+)$/) ?? (e.name.match(/^(accounts\.db|site\.db)$/) ? [e.name, e.name, e.name] : null);
      if (!m) continue;
      const part = m[1];
      const p = parts.get(part) ?? { part, label: this.partLabel(part), bytes: 0, photos: 0 };
      p.bytes += e.size;
      if (m[2].startsWith("uploads/")) p.photos++;
      parts.set(part, p);
    }
    return [...parts.values()];
  }

  private partLabel(part: string) {
    if (part === "shop") return "Your shop";
    if (part === "accounts.db") return "Sign-ins, plans and invites";
    if (part === "site.db") return "Server settings (shares, feedback, announcements)";
    const id = Number(part.split("/")[1]);
    const email = this.accounts ? (this.accounts.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string } | undefined)?.email : undefined;
    return email ? `${email}'s shop` : `Shop #${id}`;
  }

  private backupFile(name: string) {
    if (!/^flipdesk-\d{8}-\d{4,6}(-\d+)?\.zip$/.test(name)) throw Object.assign(new Error("Unknown backup"), { status: 400 });
    const file = path.join(backupDir(this.dataDir), name);
    if (!fs.existsSync(file)) throw Object.assign(new Error("That backup isn't on the server anymore"), { status: 404 });
    return file;
  }

  /**
   * Put chosen parts of a backup back. A fresh backup is made first, and the files being replaced are moved
   * to data/restore-trash/<time>/ instead of deleted, so a restore can always be undone.
   */
  async restore(name: string, parts: string[]) {
    const file = this.backupFile(name);
    const available = new Set(this.backupContents(name).map((p) => p.part));
    const chosen = parts.filter((p) => available.has(p));
    if (!chosen.length) throw Object.assign(new Error("Pick at least one part to restore"), { status: 400 });
    const safety = await this.backupNow(); // undo point
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const trash = path.join(this.dataDir, "restore-trash", stamp);
    const staging = path.join(this.dataDir, ".restore-tmp", stamp);
    const entries = zipEntries(file);
    const SQLITE = Buffer.from("SQLite format 3\0");
    try {
      for (const part of chosen) {
        // 1. unpack this part into staging and check it
        const dir = path.join(staging, part.replace(/\//g, "_"));
        fs.mkdirSync(dir, { recursive: true });
        for (const e of entries) {
          const rel = part.endsWith(".db") ? (e.name === part ? "db" : null) : e.name.startsWith(part + "/") ? e.name.slice(part.length + 1) : null;
          if (!rel) continue;
          if (rel.split("/").some((seg) => seg === ".." || seg === "")) throw new Error(`Unsafe path in backup: ${e.name}`);
          const out = path.join(dir, rel === "flipdesk.db" ? "db" : rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, extractEntry(file, e));
        }
        if (!fs.existsSync(path.join(dir, "db")) || !fs.readFileSync(path.join(dir, "db")).subarray(0, 16).equals(SQLITE)) throw new Error(`${this.partLabel(part)}: the database in this backup is damaged`);
        // 2. swap it in
        const moveAway = (f: string, as: string) => {
          if (!fs.existsSync(f)) return;
          fs.mkdirSync(path.dirname(path.join(trash, as)), { recursive: true });
          fs.renameSync(f, path.join(trash, as));
        };
        if (part === "accounts.db" || part === "site.db") {
          const target = path.join(this.dataDir, part);
          if (part === "accounts.db" && this.accounts) this.accounts.close();
          if (part === "site.db") this.site.close();
          for (const sfx of ["", "-wal", "-shm"]) moveAway(target + sfx, part + sfx);
          fs.renameSync(path.join(dir, "db"), target);
          if (part === "accounts.db" && this.multiuser) this.accounts = this.openAccounts();
          if (part === "site.db") this.site = this.openSite();
          continue;
        }
        const key = part === "shop" ? "main" : `u${part.split("/")[1]}`;
        if (part === "shop" && this.multiuser) continue;
        this.close(key);
        const { dbFile, uploadDir } = this.location(key);
        for (const sfx of ["", "-wal", "-shm"]) moveAway(dbFile + sfx, `${part}/flipdesk.db${sfx}`);
        moveAway(uploadDir, `${part}/uploads`);
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        fs.renameSync(path.join(dir, "db"), dbFile);
        if (fs.existsSync(path.join(dir, "uploads"))) fs.renameSync(path.join(dir, "uploads"), uploadDir);
        else fs.mkdirSync(uploadDir, { recursive: true });
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    this.siteSet("lastRestore", { at: new Date().toISOString(), from: name, parts: chosen, undo: path.basename(safety.file), trash: path.relative(this.dataDir, trash) });
    return { restored: chosen, undoBackup: path.basename(safety.file) };
  }

  // ---------------- Status ----------------

  status(req: Request & { fdUser?: Account | null }) {
    type Row = { key: string; label: string; state: "ok" | "warn" | "down" | "off"; detail: string; lastOk?: string | null; lastError?: string | null };
    const from = (c: Check | null, label: string, key: string, offDetail: string | null, okDetail: string): Row => {
      if (offDetail) return { key, label, state: "off", detail: offDetail };
      const st = stateOf(c);
      return {
        key,
        label,
        state: st === "down" ? "down" : "ok",
        detail: st === "down" ? `Last try failed: ${c!.lastError}` : st === "unknown" ? `${okDetail} (no calls since the server started)` : okDetail,
        lastOk: c?.lastOk ?? null,
        lastError: c?.lastFail ? c.lastError ?? null : null,
      };
    };
    const lastBackup = this.siteGet<{ at?: string; error?: string | null; failedAt?: string } | null>("lastBackup", null);
    const backupAgeH = lastBackup?.at ? (Date.now() - Date.parse(lastBackup.at)) / 3600_000 : null;
    const services: Row[] = [
      { key: "server", label: "FlipDesk", state: "ok", detail: `Running since ${new Date(startedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC` },
      from(globalCheck("ai"), "AI writer (Claude)", "ai", process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? null : "Not set up (demo writer in use)", "Answering"),
      from(globalCheck("ebay"), "eBay", "ebay", process.env.EBAY_CLIENT_ID ? null : "Not set up (demo mode)", "Reachable"),
      from(globalCheck("mail"), "Email", "mail", mailConfigured() ? null : "Not set up", "Sending"),
    ];
    // Backups: the owner sees problems (and can fix them); members just see that it's handled.
    const isOwner = this.multiuser ? Boolean(req.fdUser?.is_owner) : true;
    const upH = (Date.now() - Date.parse(startedAt)) / 3600_000;
    const backupState: Row["state"] =
      process.env.BACKUP_DISABLED === "1"
        ? "off"
        : lastBackup?.failedAt && (!lastBackup.at || lastBackup.failedAt > lastBackup.at)
          ? "down"
          : backupAgeH === null
            ? upH < 2 ? "ok" : "warn"
            : backupAgeH > 30 || lastBackup?.error
              ? "warn"
              : "ok";
    const backupDetail =
      process.env.BACKUP_DISABLED === "1"
        ? "Turned off"
        : backupAgeH === null
          ? upH < 2 ? "First backup runs within the hour" : "No backup yet"
          : `Last one ${backupAgeH < 1 ? "less than an hour" : `${Math.round(backupAgeH)} h`} ago${lastBackup?.error ? `. ${lastBackup.error}` : ""}`;
    if (isOwner) {
      services.push({ key: "backup", label: "Nightly backup", state: backupState, detail: backupDetail });
      const chk = this.siteGet<{ at: string; ok: boolean; problems: string[]; photosChecked: number } | null>("lastBackupCheck", null);
      services.push(
        !chk
          ? { key: "backup-check", label: "Backup restore check", state: "off", detail: "Runs monthly after a backup (or Settings → Check)" }
          : chk.ok
            ? { key: "backup-check", label: "Backup restore check", state: "ok", detail: `Passed ${Math.max(0, Math.round((Date.now() - Date.parse(chk.at)) / 86400_000))} days ago (${chk.photosChecked} photos verified)` }
            : { key: "backup-check", label: "Backup restore check", state: "down", detail: `Failed: ${chk.problems.slice(0, 2).join("; ")}` },
      );
    }
    else if (backupState === "ok" || backupState === "off") services.push({ key: "backup", label: "Nightly backup", state: backupState, detail: backupState === "ok" ? "Your shop is backed up every night" : "Turned off by the owner" });
    if (this.multiuser) services.push({ key: "payments", label: "Payments (Stripe)", state: billingEnabled() ? "ok" : "off", detail: billingEnabled() ? `Last update from Stripe: ${this.siteGet<string | null>("lastStripeEvent", null) ?? "none yet"}` : "Not set up (everyone is free)" });

    // Yours: this browser's shop
    const ws = this.current(req, req.fdUser ?? null);
    const yours: Row[] = [];
    if (ws) {
      const n = (sql: string) => Number((ws.db.prepare(sql).get() as { n: number }).n);
      const ebayConnected = runInWorkspace(ws, () => ebayIsLive(ws.db));
      const login = shopCheck(ws.key, "ebay-login");
      yours.push(
        !process.env.EBAY_CLIENT_ID
          ? { key: "ebay", label: "Your eBay connection", state: "off", detail: "eBay isn't set up on this server" }
          : !ebayConnected
            ? { key: "ebay", label: "Your eBay connection", state: "warn", detail: "Not connected. Marketplaces → Connect eBay." }
            : stateOf(login) === "down"
              ? { key: "ebay", label: "Your eBay connection", state: "down", detail: `eBay sign-in stopped working: ${login!.lastError}. Reconnect on the Marketplaces page.` }
              : { key: "ebay", label: "Your eBay connection", state: "ok", detail: "Connected" },
      );
      const pending = n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'");
      const failed = n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= datetime('now','-7 days')");
      const oldestMin = n("SELECT COALESCE(MAX(CAST((julianday('now') - julianday(created_at)) * 1440 AS INTEGER)), 0) AS n FROM jobs WHERE status = 'pending'");
      yours.push({
        key: "sync",
        label: "Sync queue",
        state: failed ? "down" : pending && oldestMin > 60 ? "warn" : "ok",
        detail: failed ? `${failed} failed in the last week (Sync queue page shows why)` : pending ? `${pending} waiting${oldestMin > 60 ? `, oldest ${Math.round(oldestMin / 60)} h (is the extension running?)` : ""}` : "Nothing waiting",
      });
      const extMps = n(`SELECT COUNT(*) AS n FROM connections WHERE status = 'connected' AND marketplace IN ('poshmark','mercari','depop','vinted','grailed','facebook','whatnot')`);
      const seenAt = lastSeen("extension", ws.key);
      const seenMin = seenAt ? (Date.now() - Date.parse(seenAt)) / 60_000 : null;
      yours.push(
        !extMps && !seenAt
          ? { key: "extension", label: "Chrome extension", state: "off", detail: "Not in use (only needed for Poshmark, Mercari, Depop…)" }
          : { key: "extension", label: "Chrome extension", state: seenMin !== null && seenMin < 10 ? "ok" : "warn", detail: seenAt ? `Last checked in ${seenMin! < 1 ? "just now" : `${Math.round(seenMin!)} min ago`}` : "Hasn't checked in since the server started. Open Chrome with the extension." },
      );
      for (const [task, label] of [["ebay-sales", "eBay sale check"], ["email", "Sale emails (inbox)"]] as const) {
        const c = shopCheck(ws.key, `task:${task}`);
        if (c && stateOf(c) === "down") yours.push({ key: task, label, state: "down", detail: `Last run failed: ${c.lastError}`, lastOk: c.lastOk ?? null });
      }
      if (req.fdUser) {
        const lim = this.aiLimit(req.fdUser.id);
        if (lim !== null) {
          const used = this.aiUsedToday(req.fdUser.id);
          yours.push({ key: "ai-allowance", label: "Your AI allowance", state: used >= lim ? "warn" : "ok", detail: `${used} of ${lim} used today (resets at midnight UTC)` });
        }
      }
    }
    const all = [...services, ...yours];
    const overall = all.some((r) => r.state === "down") ? "down" : all.some((r) => r.state === "warn") ? "warn" : "ok";
    return { overall, checkedAt: new Date().toISOString(), services, yours };
  }

  // ---------------- Owner alerts ----------------

  /** The owner's real shop (for push notifications) and email. */
  ownerContact() {
    const id = this.multiuser ? (this.accounts!.prepare("SELECT id FROM users WHERE is_owner = 1").get() as { id: number } | undefined)?.id : undefined;
    if (this.multiuser && !id) return null;
    const ws = this.get(this.realKey(id));
    const email = id ? (this.accounts!.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string }).email : null;
    return ws ? { ws, email } : null;
  }

  async tellOwner(title: string, body: string, opts: { email?: boolean } = {}) {
    const o = this.ownerContact();
    if (!o) return { pushed: false, emailed: false };
    const pushed = await runInWorkspace(o.ws, () => notify(o.ws.db, "weekly", title, body)).catch(() => false);
    let emailed = false;
    if (opts.email !== false && o.email && (mailConfigured() || process.env.SMTP_HOST === "test")) emailed = await sendMail(o.email, title, body).catch(() => false);
    return { pushed, emailed };
  }

  // ---------------- Automatic incident alerts ----------------

  private static INCIDENT_LABEL: Record<string, string> = { ai: "The AI writer", ebay: "eBay", mail: "Email", backup: "Nightly backups" };

  /** Owner's alert preferences: quiet hours (no pages at night) and how long a problem must last before you're told. */
  alertSettings() {
    const s = this.siteGet<{ quiet?: boolean; quietStart?: number; quietEnd?: number }>("alerts", {});
    const env = process.env.FLIPDESK_ALERT_AFTER_MINUTES;
    return {
      quiet: s.quiet !== false,
      quietStart: s.quietStart ?? 22,
      quietEnd: s.quietEnd ?? 7,
      afterMinutes: env !== undefined && env !== "" && Number.isFinite(Number(env)) ? Math.max(0, Number(env)) : 10,
      timezone: this.ownerTimezone(),
    };
  }

  private ownerTimezone() {
    const o = this.ownerContact();
    return (o && getSetting<{ timezone?: string }>(o.ws.db, "weekly", {}).timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  /** Is it the owner's quiet time right now (their time zone)? */
  isQuiet(now = new Date()) {
    const a = this.alertSettings();
    if (!a.quiet || a.quietStart === a.quietEnd) return false;
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: a.timezone, hour: "numeric", hour12: false }).format(now)) % 24;
    return a.quietStart > a.quietEnd ? hour >= a.quietStart || hour < a.quietEnd : hour >= a.quietStart && hour < a.quietEnd;
  }

  /**
   * Every couple of minutes. A problem = AI, eBay or email failing several times in a row (FLIPDESK_INCIDENT_AFTER,
   * default 3), or a failed backup. To keep it calm:
   * - short blips (fixed within FLIPDESK_ALERT_AFTER_MINUTES, default 10) never page you; they're only logged,
   * - during your quiet hours (default 10pm-7am, your time zone) nothing pages you; problems that were fixed
   *   overnight arrive as one "while you were away" note in the morning, ongoing ones as a normal alert,
   * - several problems at once arrive as one message.
   * Everyone sees a "Heads up" announcement once a problem has lasted past the blip window (hosted mode).
   */
  async checkIncidents(now = new Date()) {
    const after = Math.max(1, Number(process.env.FLIPDESK_INCIDENT_AFTER) || 3);
    const cfg = this.alertSettings();
    const lastBackup = this.siteGet<{ at?: string; failedAt?: string; error?: string | null } | null>("lastBackup", null);
    const failing: Record<string, string | null | undefined> = {}; // error = failing, null = fine, undefined = wait and see
    for (const svc of ["ai", "ebay", "mail"]) {
      const c = globalCheck(svc);
      if (c) failing[svc] = c.streak >= after ? c.lastError ?? "failing" : c.streak === 0 ? null : undefined;
    }
    if (lastBackup?.failedAt && (!lastBackup.at || lastBackup.failedAt > lastBackup.at)) failing.backup = lastBackup.error ?? "backup failed";
    else if (lastBackup?.at) failing.backup = null;

    const iso = now.toISOString().replace("T", " ").slice(0, 19);
    const ageMin = (started: string) => (now.getTime() - Date.parse(started.replace(" ", "T") + "Z")) / 60_000;
    const events: { service: string; kind: "opened" | "alerted" | "closed" | "summarized" }[] = [];
    type Inc = { id: number; service: string; started_at: string; ended_at: string | null; announcement_id: number | null; notified_at: string | null; last_error: string };

    // 1. open / close
    for (const [svc, err] of Object.entries(failing)) {
      if (err === undefined) continue;
      const open = this.site.prepare("SELECT * FROM incidents WHERE service = ? AND ended_at IS NULL").get(svc) as Inc | undefined;
      if (err && !open) {
        this.site.prepare("INSERT INTO incidents (service, last_error, started_at) VALUES (?, ?, ?)").run(svc, err.slice(0, 300), iso);
        events.push({ service: svc, kind: "opened" });
      } else if (err && open) {
        this.site.prepare("UPDATE incidents SET last_error = ? WHERE id = ?").run(err.slice(0, 300), open.id);
      } else if (!err && open) {
        this.site.prepare("UPDATE incidents SET ended_at = ? WHERE id = ?").run(iso, open.id);
        if (open.announcement_id) this.site.prepare("UPDATE announcements SET archived_at = ? WHERE id = ?").run(iso, open.announcement_id);
        events.push({ service: svc, kind: "closed" });
      }
    }

    // 2. ongoing problems past the blip window: heads-up for everyone, and (outside quiet hours) one alert to you
    const label = (svc: string) => Workspaces.INCIDENT_LABEL[svc] ?? svc;
    const due = (this.site.prepare("SELECT * FROM incidents WHERE ended_at IS NULL").all() as unknown as Inc[]).filter((i) => i.service === "backup" || ageMin(i.started_at) >= cfg.afterMinutes);
    for (const i of due) {
      if (!i.announcement_id && this.multiuser && i.service !== "backup" && process.env.FLIPDESK_AUTO_ANNOUNCE !== "0") {
        const annId = Number(
          this.site
            .prepare("INSERT INTO announcements (title, body, link, ends_at) VALUES (?, ?, '/status', datetime('now','+2 days'))")
            .run(`Heads up: ${label(i.service)} is having trouble right now`, `FlipDesk keeps retrying on its own, so nothing is lost. ${i.service === "ebay" ? "eBay listings, price changes and delists may be delayed." : i.service === "ai" ? "AI writing may fail; you can still write listings by hand." : "Emails may arrive late."} Tools → Status shows the latest.`).lastInsertRowid,
        );
        this.site.prepare("UPDATE incidents SET announcement_id = ? WHERE id = ?").run(annId, i.id);
        i.announcement_id = annId;
      }
    }
    const quiet = this.isQuiet(now);
    const toAlert = due.filter((i) => !i.notified_at);
    if (toAlert.length && !quiet) {
      const lines = toAlert.map((i) => `🔴 ${label(i.service)}: ${i.service === "backup" ? "" : `failing for ${Math.max(1, Math.round(ageMin(i.started_at)))} min. `}Last error: ${i.last_error}`);
      const title = toAlert.length === 1 ? `🔴 ${label(toAlert[0].service)} is failing` : `🔴 ${toAlert.length} things are failing`;
      await this.tellOwner(title, `${lines.join("\n")}\n${toAlert.some((i) => i.announcement_id) ? "A heads-up announcement is up for everyone. " : ""}Details: Tools → Status.`);
      for (const i of toAlert) {
        this.site.prepare("UPDATE incidents SET notified_at = ? WHERE id = ?").run(iso, i.id);
        events.push({ service: i.service, kind: "alerted" });
      }
    }

    // 3. fixed: tell you it's back (only about things you were told about), bundled
    const fixed = this.site.prepare("SELECT * FROM incidents WHERE ended_at IS NOT NULL AND notified_at IS NOT NULL AND summarized_at IS NULL").all() as unknown as Inc[];
    if (fixed.length && !quiet) {
      const dur = (i: Inc) => {
        const m = Math.max(1, Math.round((Date.parse(i.ended_at!.replace(" ", "T") + "Z") - Date.parse(i.started_at.replace(" ", "T") + "Z")) / 60_000));
        return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
      };
      await this.tellOwner(
        fixed.length === 1 ? `✅ ${label(fixed[0].service)} is working again` : `✅ ${fixed.length} problems fixed`,
        fixed.map((i) => `✅ ${label(i.service)} works again (down about ${dur(i)})${i.announcement_id ? ", heads-up taken down" : ""}`).join("\n"),
        { email: false },
      );
      for (const i of fixed) this.site.prepare("UPDATE incidents SET summarized_at = ? WHERE id = ?").run(iso, i.id);
    }

    // 4. the morning after: problems that started and ended during quiet hours (and outlasted the blip window)
    if (!quiet) {
      const overnight = (this.site.prepare("SELECT * FROM incidents WHERE ended_at IS NOT NULL AND notified_at IS NULL AND summarized_at IS NULL").all() as unknown as Inc[]).filter(
        (i) => (Date.parse(i.ended_at!.replace(" ", "T") + "Z") - Date.parse(i.started_at.replace(" ", "T") + "Z")) / 60_000 >= cfg.afterMinutes,
      );
      if (overnight.length) {
        const t = (x: string) => new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(x.replace(" ", "T") + "Z"));
        await this.tellOwner("🌙 While you were away", overnight.map((i) => `${label(i.service)} had trouble ${t(i.started_at)}-${t(i.ended_at!)} (fixed on its own)`).join("\n"), { email: false });
        for (const i of overnight) {
          this.site.prepare("UPDATE incidents SET summarized_at = ? WHERE id = ?").run(iso, i.id);
          events.push({ service: i.service, kind: "summarized" });
        }
      }
      // blips: never paged, just marked so they aren't reconsidered
      this.site.prepare("UPDATE incidents SET summarized_at = ? WHERE ended_at IS NOT NULL AND summarized_at IS NULL AND notified_at IS NULL").run(iso);
    }
    return events;
  }

  recentIncidents(limit = 5) {
    return (this.site.prepare("SELECT service, started_at, ended_at, last_error FROM incidents ORDER BY id DESC LIMIT ?").all(limit) as { service: string; started_at: string; ended_at: string | null; last_error: string }[]).map((i) => ({
      ...i,
      label: Workspaces.INCIDENT_LABEL[i.service] ?? i.service,
    }));
  }

  // ---------------- Owner's weekly report (hosted) ----------------

  ownerReport() {
    const a = this.accounts!;
    const u = this.usage(2);
    const [prev, cur] = u.weeks;
    const n = (sql: string, ...args: (string | number)[]) => Number((a.prepare(sql).get(...args) as { n: number }).n);
    const weekAgo = "datetime('now','-7 days')";
    const lines: string[] = [];
    const delta = (x: number, y: number) => (y === x ? "" : ` (${x > y ? "▲" : "▼"}${Math.abs(x - y)} vs last week)`);
    lines.push(`👥 ${u.members} member${u.members === 1 ? "" : "s"}, ${cur.signups} new this week · ${cur.activeSellers} active${delta(cur.activeSellers, prev.activeSellers)}`);
    if (billingEnabled()) {
      const paying = (u.plans.active ?? 0) + (u.plans.past_due ?? 0);
      const ending = (a.prepare("SELECT id FROM users WHERE is_owner = 0").all() as { id: number }[]).filter((x) => {
        const b = billingSummary(this.billingRow(x.id)!);
        return b.status === "trial" && (b.trialDaysLeft ?? 99) <= 7;
      }).length;
      lines.push(`💳 ${paying} paying${u.mrr !== null ? ` (~$${u.mrr}/month)` : ""} · ${ending} trial${ending === 1 ? "" : "s"} ending this week${u.conversion.pct !== null ? ` · ${u.conversion.pct}% of trials convert` : ""}`);
    }
    lines.push(`🤖 ${cur.aiCalls} AI requests (~$${cur.aiCost.toFixed(2)})${delta(cur.aiCalls, prev.aiCalls)}`);
    const fb = this.site.prepare("SELECT COUNT(*) AS n, MAX(message) AS m FROM feedback WHERE resolved_at IS NULL").get() as { n: number; m: string | null };
    if (fb.n) lines.push(`💬 ${fb.n} open feedback${fb.m ? `, e.g. "${fb.m.slice(0, 60)}"` : ""}`);
    const refs = n(`SELECT COUNT(*) AS n FROM referral_rewards WHERE created_at >= ${weekAgo}`);
    if (refs) lines.push(`🎁 ${refs} referral reward${refs === 1 ? "" : "s"} given`);
    const nudged = n(`SELECT COUNT(*) AS n FROM nudges WHERE sent_at >= ${weekAgo}`);
    if (nudged) lines.push(`✉️ ${nudged} reminder email${nudged === 1 ? "" : "s"} sent`);
    const hi = this.helpInsights(7);
    const topTopic = hi.topTopics.find((t) => t.topic !== "Other");
    if (hi.total) lines.push(`❓ ${hi.total} Help question${hi.total === 1 ? "" : "s"}${topTopic ? `, most about "${topTopic.topic}" (${topTopic.count})` : ""}${hi.unanswered.length ? ` · ${hi.unanswered.length} without a good answer` : ""}`);
    const inc = this.site.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE started_at >= ${weekAgo}`).get() as { n: number };
    if (inc.n) lines.push(`🩺 ${inc.n} outage${inc.n === 1 ? "" : "s"} this week (see Tools → Status)`);
    const lb = this.siteGet<{ at?: string; error?: string | null } | null>("lastBackup", null);
    const chk = this.siteGet<{ at: string; ok: boolean } | null>("lastBackupCheck", null);
    lines.push(`🛟 ${lb?.at ? `Last backup ${new Date(lb.at).toISOString().slice(0, 10)}${lb.error ? " (upload problem)" : ""}` : "No backup yet"}${chk ? ` · last restore check ${chk.ok ? "passed" : "FAILED"}` : ""}`);
    return { title: `FlipDesk this week: ${cur.activeSellers} active, ${cur.signups} new`, body: lines.join("\n") };
  }

  async ownerReportIfDue(now = new Date()) {
    if (!this.multiuser) return null;
    const o = this.ownerContact();
    if (!o) return null;
    const slot = weeklySlot(o.ws.db, now);
    if (!slot.due || this.siteGet<string | null>("ownerReportWeek", null) === slot.week) return null;
    this.siteSet("ownerReportWeek", slot.week);
    const r = this.ownerReport();
    return { ...r, ...(await this.tellOwner(r.title, r.body)) };
  }

  // ---------------- Friendly reminder emails (hosted) ----------------

  /** Numbers that make a reminder personal: "you listed 34 items and made $412". */
  private shopNumbers(userId: number) {
    const ws = this.get(`u${userId}`);
    if (!ws) return null;
    const one = <T>(sql: string) => ws.db.prepare(sql).get() as T;
    return {
      items: one<{ n: number }>("SELECT COUNT(*) AS n FROM items").n,
      live: one<{ n: number }>("SELECT COUNT(DISTINCT item_id) AS n FROM listings WHERE status = 'active'").n,
      sold: one<{ n: number }>("SELECT COALESCE(SUM(quantity),0) AS n FROM sales").n,
      profit: Math.round(one<{ n: number }>("SELECT COALESCE(SUM(profit),0) AS n FROM sales").n),
      drafts: one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE status = 'draft'").n,
    };
  }

  /**
   * Daily: (1) free trial ends in 3 days or less, (2) haven't been back for 14+ days (at most once a month).
   * Only by email, only when email is set up, and people can turn them off in Settings.
   */
  async sendNudges() {
    if (!this.multiuser || !(mailConfigured() || process.env.SMTP_HOST === "test")) return [];
    const a = this.accounts!;
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
    const link = (p: string) => (base ? `${base}${p}` : p);
    const sent: { userId: number; kind: string }[] = [];
    const users = a.prepare("SELECT id, email FROM users WHERE is_owner = 0 AND email_opt_out = 0").all() as { id: number; email: string }[];
    const latestNews = (this.site.prepare("SELECT title FROM announcements WHERE archived_at IS NULL ORDER BY id DESC LIMIT 1").get() as { title: string } | undefined)?.title;
    const once = (userId: number, kind: string, ref: string) => {
      const r = a.prepare("INSERT OR IGNORE INTO nudges (user_id, kind, ref) VALUES (?, ?, ?)").run(userId, kind, ref);
      return Number(r.changes) > 0;
    };
    for (const u of users) {
      const nums = this.shopNumbers(u.id);
      const stats = nums ? `So far you've added ${nums.items} item${nums.items === 1 ? "" : "s"}${nums.live ? ` (${nums.live} live)` : ""}${nums.sold ? `, sold ${nums.sold} and made $${nums.profit.toLocaleString("en-US")} profit` : ""}.` : "";
      const b = billingSummary(this.billingRow(u.id)!);
      if (b.status === "trial" && (b.trialDaysLeft ?? 99) <= 3 && once(u.id, "trial_ending", String(this.billingRow(u.id)!.trial_ends_at))) {
        const days = b.trialDaysLeft === 0 ? "today" : `in ${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? "" : "s"}`;
        await sendMail(
          u.email,
          `Your FlipDesk trial ends ${days}`,
          `Hi! Your free trial ends ${days}.\n\n${stats}\n\nKeep everything running (crosslisting, auto-delist, AI writing): ${link("/billing")}\n\nIf you don't subscribe, nothing is deleted: your shop just turns read-only, and sales still delist everywhere so nothing oversells.\n\nTurn these emails off in FlipDesk → Settings → Your account.`,
        ).catch(() => {});
        sent.push({ userId: u.id, kind: "trial_ending" });
        continue;
      }
      // Trial ended 1-30 days ago without a plan: one "come back" offer (percent off the first month).
      const pct = winbackPct();
      const trialEnd = this.billingRow(u.id)!.trial_ends_at;
      const sinceEnd = trialEnd ? (Date.now() - Date.parse(trialEnd.replace(" ", "T") + "Z")) / 86400_000 : -1;
      if (pct && b.status === "expired" && sinceEnd >= 1 && sinceEnd <= 30 && !a.prepare("SELECT 1 FROM nudges WHERE user_id = ? AND kind = 'winback'").get(u.id)) {
        try {
          await this.winbackCoupon(pct); // made once in your Stripe account
        } catch (e) {
          console.error("[winback]", (e as Error).message);
          continue;
        }
        if (once(u.id, "winback", String(trialEnd))) {
          const ends = new Date(Date.now() + 14 * 86400_000).toLocaleDateString("en-US", { month: "long", day: "numeric" });
          await sendMail(
            u.email,
            `Come back to FlipDesk: ${pct}% off your first month`,
            `Hi! Your free trial ended, and your shop is waiting for you, read-only and safe.\n\n${stats}\n\nAs a thank-you for trying FlipDesk: ${pct}% off your first month if you subscribe by ${ends}. It's applied automatically here: ${link("/billing")}\n\nTurn these emails off in FlipDesk → Settings → Your account.`,
          ).catch(() => {});
          sent.push({ userId: u.id, kind: "winback" });
          continue;
        }
      }
      const last = (a.prepare("SELECT MAX(day) AS d FROM activity_days WHERE user_id = ?").get(u.id) as { d: string | null }).d;
      if (!last) continue;
      const idleDays = Math.floor((Date.now() - Date.parse(last + "T00:00:00Z")) / 86400_000);
      const recent = a.prepare("SELECT 1 FROM nudges WHERE user_id = ? AND kind = 'inactive' AND sent_at >= datetime('now','-30 days')").get(u.id);
      if (idleDays >= 14 && idleDays <= 90 && !recent && once(u.id, "inactive", last)) {
        const tip = nums?.drafts ? `You have ${nums.drafts} draft${nums.drafts === 1 ? "" : "s"} waiting: finishing them is the quickest win.` : "Snap a few items with Shoot mode on your phone and let the AI write them.";
        await sendMail(
          u.email,
          "Your FlipDesk shop misses you 👋",
          `Hi! It's been ${idleDays} days since you stopped by.\n\n${stats} ${tip}\n${latestNews ? `\nNew since then: ${latestNews}\n` : ""}\nPick up where you left off: ${link("/")}\n\nTurn these emails off in FlipDesk → Settings → Your account.`,
        ).catch(() => {});
        sent.push({ userId: u.id, kind: "inactive" });
      }
    }
    return sent;
  }

  // ---------------- Help insights ----------------

  logHelp(viewer: string, question: string, page: string, answeredBy: string, topSource: string | null) {
    return Number(this.site.prepare("INSERT INTO help_questions (viewer, question, page, answered_by, top_source) VALUES (?, ?, ?, ?, ?)").run(viewer, question.slice(0, 500), page.slice(0, 200), answeredBy, topSource).lastInsertRowid);
  }

  /** What people ask Help: top topics, questions without a good answer, and how often answers helped. */
  helpInsights(days = 7) {
    const since = `-${Math.max(1, days)} days`;
    const rows = this.site.prepare("SELECT id, question, page, answered_by, top_source, helpful, created_at FROM help_questions WHERE created_at >= datetime('now', ?) ORDER BY id DESC").all(since) as {
      id: number; question: string; page: string; answered_by: string; top_source: string | null; helpful: number | null; created_at: string;
    }[];
    const topics = new Map<string, { topic: string; count: number; examples: string[] }>();
    for (const r of rows) {
      const t = r.top_source ?? "Other";
      const x = topics.get(t) ?? { topic: t, count: 0, examples: [] };
      x.count++;
      if (x.examples.length < 3 && !x.examples.includes(r.question)) x.examples.push(r.question);
      topics.set(t, x);
    }
    const rated = rows.filter((r) => r.helpful !== null);
    return {
      days,
      total: rows.length,
      topTopics: [...topics.values()].sort((a, b) => Number(a.topic === "Other") - Number(b.topic === "Other") || b.count - a.count).slice(0, 8), // unmatched last
      unanswered: rows.filter((r) => r.answered_by === "none" || r.answered_by === "ai-unsure" || r.helpful === 0).slice(0, 15),
      helpfulPct: rated.length ? Math.round((rated.filter((r) => r.helpful === 1).length / rated.length) * 100) : null,
      rated: rated.length,
    };
  }

  // ---------------- Win-back offer ----------------

  /** An active "come back" offer for this person, if they got one and it hasn't run out (14 days). */
  winbackOffer(userId: number) {
    const pct = winbackPct();
    if (!pct || !billingEnabled() || !this.accounts) return null;
    const r = this.accounts.prepare("SELECT sent_at FROM nudges WHERE user_id = ? AND kind = 'winback' ORDER BY sent_at DESC LIMIT 1").get(userId) as { sent_at: string } | undefined;
    if (!r) return null;
    const ends = new Date(Date.parse(r.sent_at.replace(" ", "T") + "Z") + 14 * 86400_000);
    const st = planStatus(this.billingRow(userId)!);
    if (ends.getTime() < Date.now() || st === "active" || st === "past_due") return null;
    return { pct, endsAt: ends.toISOString(), coupon: this.siteGet<string | null>(`winbackCoupon:${pct}`, null) };
  }

  private async winbackCoupon(pct: number) {
    const key = `winbackCoupon:${pct}`;
    let id = this.siteGet<string | null>(key, null);
    if (!id) {
      id = await createWinbackCoupon(pct);
      this.siteSet(key, id);
    }
    return id;
  }

  // ---------------- Backup restore check ----------------

  /** Prove a backup would restore (default: the newest). Tells the owner if it fails. */
  async checkBackup(name?: string) {
    const files = listBackups(this.dataDir);
    const pick = name ?? files[0]?.name;
    if (!pick) throw Object.assign(new Error("No backups to check yet"), { status: 400 });
    const r = verifyBackup(this.backupFile(pick));
    this.siteSet("lastBackupCheck", r);
    if (!r.ok) await this.tellOwner("🔴 A FlipDesk backup failed its restore check", `${pick}: ${r.problems.slice(0, 3).join("; ")}\nMake a fresh backup in Settings and check it again.`);
    return r;
  }

  /** Monthly: check the newest backup (FLIPDESK_BACKUP_CHECK_DAYS, default 30). */
  async checkBackupIfDue() {
    const last = this.siteGet<{ at?: string } | null>("lastBackupCheck", null);
    const days = Number(process.env.FLIPDESK_BACKUP_CHECK_DAYS) || 30;
    if (last?.at && Date.now() - Date.parse(last.at) < days * 86400_000) return null;
    if (!listBackups(this.dataDir).length) return null;
    return this.checkBackup();
  }

  // ---------------- The front door ----------------

  /** Single-user password check (same cookie the shop apps use). */
  private passwordOk(req: Request) {
    if (!this.password) return true;
    const v = crypto.createHmac("sha256", this.password).update("flipdesk-session").digest("base64url");
    return readCookie(req, "fd_session") === v;
  }

  /** Which shop this browser is looking at. */
  private current(req: Request, user: Account | null): Workspace | null {
    const wantDemo = readCookie(req, "fd_ws") === "demo";
    const demoKey = this.demoKey(user?.id);
    if (wantDemo && this.exists(demoKey)) return this.get(demoKey);
    return this.get(this.realKey(user?.id));
  }

  private describe(req: Request, user: Account | null) {
    const shared = (req as Request & { fdShare?: Workspace }).fdShare ?? this.shareWorkspace(readCookie(req, "fd_share"));
    if (shared) return { mode: this.multiuser ? "accounts" : "single", current: "demo", demoExists: true, user: null, signupsOpen: this.signupsOpen(), needsInvite: true, shared: true };
    const ws = this.current(req, user);
    return {
      shared: false,
      mode: this.multiuser ? "accounts" : "single",
      current: ws?.demo ? "demo" : "real",
      demoExists: this.exists(this.demoKey(user?.id)),
      user: user ? { email: user.email, owner: Boolean(user.is_owner) } : null,
      signupsOpen: this.signupsOpen(),
      needsInvite: this.multiuser && !((this.accounts!.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0),
    };
  }

  handler() {
    const root = express.Router();
    const json = express.json({ limit: "100kb" });

    // For uptime monitors (UptimeRobot, Better Stack…): no login. 200 when FlipDesk can serve, 503 when it can't.
    // ?strict=1 also returns 503 while a service (AI, eBay, email, backups) has an open outage.
    root.get("/healthz", (req, res) => {
      const problems: string[] = [];
      const ping = (name: string, db: Db | null) => {
        try {
          db?.prepare("SELECT 1").get();
        } catch (e) {
          problems.push(`${name}: ${(e as Error).message}`);
        }
      };
      ping("site", this.site);
      ping("accounts", this.accounts);
      if (!this.multiuser) ping("shop", this.get("main")?.db ?? null);
      let open: string[] = [];
      try {
        open = (this.site.prepare("SELECT service FROM incidents WHERE ended_at IS NULL").all() as { service: string }[]).map((i) => i.service);
      } catch {
        /* already reported by the site check */
      }
      const down = problems.length > 0 || (req.query.strict === "1" && open.length > 0);
      res.setHeader("Cache-Control", "no-store");
      res.status(down ? 503 : 200).json({ ok: !down, uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000), outages: open, ...(problems.length ? { problems } : {}) });
    });

    // Photos: /uploads/<shop>/<file> (public: marketplaces and the extension fetch them). Names are random.
    root.use("/uploads", (req, res, next) => {
      const first = req.path.split("/")[1] ?? "";
      if (KEY_RE.test(first) && first !== "main") {
        const ws = this.get(first);
        if (!ws) return void res.status(404).end();
        req.url = "/uploads" + req.url.slice(first.length + 1);
        return void ws.app(req, res, next);
      }
      if (this.multiuser) return void res.status(404).end();
      req.url = "/uploads" + req.url;
      this.get("main")!.app(req, res, next);
    });

    // Phone links and the Chrome extension carry a token that names their shop ("u12.xxxx").
    const byToken = (token: string | undefined, res: Response, req: Request, next: NextFunction) => {
      const prefix = token && token.includes(".") ? token.split(".")[0] : "main";
      const ws = KEY_RE.test(prefix) ? this.get(prefix) : null;
      if (!ws) return void res.status(token ? 410 : 401).json({ error: token ? "This link has expired. Show a new QR code on your computer." : "Bad extension token" });
      ws.app(req, res, next);
    };
    root.use("/api/m", (req, res, next) => {
      const token = decodeURIComponent(req.path.split("/")[1] ?? "");
      req.url = req.originalUrl; // the shop app routes from the full path
      byToken(token, res, req, next);
    });
    root.use("/api/ext", (req, res, next) => {
      req.url = req.originalUrl;
      if (req.method === "OPTIONS") {
        // CORS preflight carries no token: answer it the same way every shop would.
        const origin = req.headers.origin ?? "";
        if (origin.startsWith("chrome-extension://") || /^https:\/\/([a-z0-9-]+\.)*(poshmark|mercari|depop|vinted|grailed|facebook|whatnot)\.com$/.test(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FlipDesk-Token");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
        return void res.sendStatus(204);
      }
      byToken(req.headers["x-flipdesk-token"] as string | undefined, res, req, next);
    });

    // eBay's account-deletion notice applies to every shop (eBay calls it without a login).
    if (!this.multiuser) root.use("/api/ebay/account-deletion", (req, res, next) => void ((req.url = req.originalUrl), this.get("main")!.app(req, res, next)));
    else {
      root.get("/api/ebay/account-deletion", async (req, res) => {
        const code = String(req.query.challenge_code ?? "");
        if (!code) return void res.status(400).end();
        res.json({ challengeResponse: await accountDeletionChallenge(code) });
      });
      root.post("/api/ebay/account-deletion", json, (req, res) => {
        const username = (req.body as { notification?: { data?: { username?: string } } })?.notification?.data?.username;
        if (username) for (const ws of this.all()) ws.db.prepare("UPDATE sales SET buyer = NULL, ship_to = NULL WHERE marketplace = 'ebay' AND buyer = ?").run(username);
        res.status(200).end();
      });
    }

    // ---- Accounts ----
    root.get("/api/auth/mode", (req, res) => void res.json(this.describe(req, this.userFor(req))));
    if (this.multiuser) {
      const Creds = z.object({ email: z.email().max(200), password: z.string().min(8, "Use at least 8 characters").max(200), invite: z.string().max(200).optional() });
      root.post("/api/auth/signup", json, (req, res) => {
        try {
          const b = Creds.parse(req.body);
          const u = this.signup(b.email.trim(), b.password, b.invite?.trim());
          this.get(`u${u.id}`); // create the shop
          res.setHeader("Set-Cookie", cookie(req, "fd_user", this.newSession(u.id), 60 * 60 * 24 * 30));
          res.json({ ok: true, owner: Boolean(u.is_owner) });
        } catch (e) {
          const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Check your email and password" : (e as Error).message;
          res.status((e as { status?: number }).status ?? 400).json({ error: msg });
        }
      });
      root.post("/api/auth/login", json, (req, res) => {
        try {
          const b = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
          const u = this.login(b.email.trim(), b.password);
          res.setHeader("Set-Cookie", cookie(req, "fd_user", this.newSession(u.id), 60 * 60 * 24 * 30));
          res.json({ ok: true });
        } catch (e) {
          res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
        }
      });
      root.post("/api/auth/logout", (req, res) => {
        const t = readCookie(req, "fd_user");
        if (t) this.accounts!.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(t));
        res.setHeader("Set-Cookie", [cookie(req, "fd_user", "", 0), cookie(req, "fd_ws", "", 0)]);
        res.json({ ok: true });
      });
      root.post("/api/auth/forgot", json, async (req, res) => {
        const email = z.object({ email: z.string().max(200) }).parse(req.body).email.trim();
        res.json(await this.forgot(email));
      });
      root.post("/api/auth/reset", json, (req, res) => {
        try {
          const b = z.object({ token: z.string().max(200), password: z.string().min(8, "Use at least 8 characters").max(200) }).parse(req.body);
          const u = this.resetPassword(b.token, b.password);
          res.setHeader("Set-Cookie", cookie(req, "fd_user", this.newSession(u.id), 60 * 60 * 24 * 30));
          res.json({ ok: true });
        } catch (e) {
          const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Check the password" : (e as Error).message;
          res.status((e as { status?: number }).status ?? 400).json({ error: msg });
        }
      });
      // The single-password login isn't used when hosted with accounts.
      root.post("/api/login", (_req, res) => void res.status(400).json({ error: "Sign in with your email", auth: "accounts" }));
    }

    // Stripe → FlipDesk (signed; raw body needed for the signature).
    root.post("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!this.accounts || !secret) return void res.status(400).json({ error: "Billing webhook not configured" });
      if (!verifyWebhook(req.body as Buffer, req.headers["stripe-signature"] as string | undefined, secret)) return void res.status(400).json({ error: "Bad signature" });
      const ev = JSON.parse((req.body as Buffer).toString("utf8"));
      const r = applyStripeEvent(this.accounts, ev);
      this.siteSet("lastStripeEvent", new Date().toISOString());
      if (r) console.log(`[billing] user ${r.userId} -> ${r.plan}`);
      // Their friend gets a free month once they're actually paying.
      if (r?.plan === "active")
        void this.grantReferral(r.userId)
          .then((g) => g && console.log(`[referral] user ${g.referrerId}: ${g.detail || g.kind}`))
          .catch((e) => console.error("[referral]", (e as Error).message));
      res.json({ received: true });
    });
    // Is this invite link still good? (for the sign-up screen)
    root.get("/api/auth/invite/:token", (req, res) => {
      if (!this.multiuser) return void res.json({ valid: false });
      res.json({ valid: Boolean(this.inviteRow(String(req.params.token))) });
    });

    // Shared sample shop links (read-only, no login): /s/<token> in the app calls open.
    root.post("/api/share/:token/open", (req, res) => {
      const token = String(req.params.token);
      if (!this.shareWorkspace(token)) return void res.status(410).json({ error: "This link was turned off by its owner." });
      this.site.prepare("UPDATE shares SET views = views + 1 WHERE token = ?").run(token);
      res.setHeader("Set-Cookie", cookie(req, "fd_share", token, 60 * 60 * 24 * 30));
      res.json({ ok: true });
    });
    root.post("/api/share/leave", (req, res) => {
      res.setHeader("Set-Cookie", cookie(req, "fd_share", "", 0));
      res.json({ ok: true });
    });

    // Everything else needs a signed-in browser (or a shared read-only link).
    root.use("/api", (req, res, next) => {
      const shared = this.shareWorkspace(readCookie(req, "fd_share"));
      if (shared && req.path !== "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.status(403).json({ error: "This is a read-only sample shop someone shared with you. Get your own FlipDesk to try that." });
        (req as Request & { fdShare?: Workspace }).fdShare = shared;
        return next();
      }
      if (req.path === "/health") {
        const ws = this.multiuser ? this.cache.values().next().value : this.get("main");
        if (ws) return void ws.app(Object.assign(req, { url: req.originalUrl }), res, next);
        return void res.json({ ok: true, ai: process.env.ANTHROPIC_API_KEY ? "live" : "demo", ebay: "demo" });
      }
      if (!this.multiuser && req.path === "/login") return void ((req.url = req.originalUrl), this.get("main")!.app(req, res, next));
      const user = this.multiuser ? this.userFor(req) : null;
      if (this.multiuser ? !user : !this.passwordOk(req)) return void res.status(401).json({ error: "login required", auth: this.multiuser ? "accounts" : "password" });
      (req as Request & { fdUser?: Account | null }).fdUser = user;
      if (user) this.accounts!.prepare("INSERT OR IGNORE INTO activity_days (user_id, day) VALUES (?, date('now'))").run(user.id); // weekly active sellers
      // Trial over and no plan: everything stays viewable and downloadable, but nothing new can be changed.
      if (user && billingEnabled() && req.method !== "GET" && req.method !== "HEAD" && !/^\/(billing|auth|feedback|export)(\/|$)/.test(req.path)) {
        const b = this.billingRow(user.id);
        if (b && planStatus(b) === "expired")
          return void res.status(402).json({ error: "Your free trial has ended. Choose a plan to keep listing. Your data is safe and you can still view and download it.", billing: true });
      }
      next();
    });

    // ---- Sample shop ----
    root.get("/api/workspace", (req, res) => void res.json(this.describe(req, (req as Request & { fdUser?: Account | null }).fdUser ?? null)));
    root.post("/api/workspace", json, async (req, res) => {
      const user = (req as Request & { fdUser?: Account | null }).fdUser ?? null;
      const action = z.object({ action: z.enum(["enter_demo", "leave_demo", "reset_demo", "delete_demo"]) }).parse(req.body).action;
      if (action === "enter_demo" || action === "reset_demo") {
        if (action === "reset_demo" || !this.exists(this.demoKey(user?.id))) await this.resetDemo(user?.id);
        res.setHeader("Set-Cookie", cookie(req, "fd_ws", "demo", 60 * 60 * 24 * 365));
      } else {
        if (action === "delete_demo") (this.deleteDemo(user?.id), this.revokeShare(this.demoKey(user?.id)));
        res.setHeader("Set-Cookie", cookie(req, "fd_ws", "", 0));
      }
      res.json({ ...this.describe(req, user), current: action === "enter_demo" || action === "reset_demo" ? "demo" : "real" });
    });

    // ---- Your account (hosted) ----
    type R = Request & { fdUser?: Account | null; fdShare?: Workspace };
    const owner = (req: R) => (this.multiuser ? Boolean(req.fdUser?.is_owner) : !req.fdShare);
    const needUser = (req: R, res: Response) => {
      if (this.multiuser && req.fdUser) return req.fdUser;
      res.status(this.multiuser ? 401 : 404).json({ error: this.multiuser ? "login required" : "Only when FlipDesk is hosted with accounts" });
      return null;
    };
    root.get("/api/account", (req: R, res) => {
      const u = req.fdUser;
      res.json({
        user: u ? { email: u.email, owner: Boolean(u.is_owner) } : null,
        ai: u ? { used: this.aiUsedToday(u.id), limit: this.aiLimit(u.id) } : null,
        email: mailConfigured() && Boolean(process.env.PUBLIC_BASE_URL),
        emailOptOut: u ? Boolean((this.accounts!.prepare("SELECT email_opt_out FROM users WHERE id = ?").get(u.id) as { email_opt_out: number }).email_opt_out) : false,
        canEditSite: owner(req),
      });
    });
    root.post("/api/account/emails", json, (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      const optOut = z.object({ optOut: z.boolean() }).parse(req.body).optOut;
      this.accounts!.prepare("UPDATE users SET email_opt_out = ? WHERE id = ?").run(optOut ? 1 : 0, u.id);
      res.json({ emailOptOut: optOut });
    });
    root.post("/api/auth/password", json, (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      try {
        const b = z.object({ current: z.string().max(200), next: z.string().min(8, "Use at least 8 characters").max(200) }).parse(req.body);
        this.changePassword(u.id, b.current, b.next);
        res.json({ ok: true });
      } catch (e) {
        const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Check the password" : (e as Error).message;
        res.status((e as { status?: number }).status === 401 ? 400 : ((e as { status?: number }).status ?? 400)).json({ error: msg === "Wrong email or password." ? "Your current password isn't right." : msg });
      }
    });

    // ---- Plan & billing (hosted) ----
    const base = (req: Request) => process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
    root.get("/api/billing", (req: R, res) => {
      const u = req.fdUser;
      if (!u) return void res.json({ enabled: false, status: this.multiuser ? "free" : "owner" });
      const offer = this.winbackOffer(u.id);
      res.json({ ...billingSummary(this.billingRow(u.id)!), aiLimit: this.aiLimit(u.id), paidAiLimit: paidAiLimit(), trialDays: trialDays(), offer: offer ? { pct: offer.pct, endsAt: offer.endsAt } : null });
    });
    root.post("/api/billing/checkout", async (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      if (!billingEnabled()) return void res.status(400).json({ error: "Billing isn't turned on for this FlipDesk." });
      const offer = this.winbackOffer(u.id);
      res.json({ url: await checkoutUrl(this.billingRow(u.id)!, base(req), { coupon: offer?.coupon ?? undefined }) });
    });
    root.post("/api/billing/portal", async (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      res.json({ url: await portalUrl(this.billingRow(u.id)!, base(req)) });
    });

    // ---- Feedback (to the owner) ----
    root.post("/api/feedback", json, async (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      const b = z
        .object({ message: z.string().trim().min(3, "Tell us a little more").max(4000), page: z.string().max(300).default(""), context: z.record(z.string(), z.unknown()).default({}) })
        .parse(req.body);
      const ctx = JSON.stringify(b.context).slice(0, 8000);
      const u = req.fdUser;
      const id = Number(this.site.prepare("INSERT INTO feedback (user_id, email, page, message, context) VALUES (?, ?, ?, ?, ?)").run(u?.id ?? null, u?.email ?? null, b.page, b.message, ctx).lastInsertRowid);
      // Tell the owner: phone push from their shop's notification settings, and email when set up.
      const ownerId = this.multiuser ? (this.accounts!.prepare("SELECT id FROM users WHERE is_owner = 1").get() as { id: number } | undefined)?.id : undefined;
      const ownerWs = this.get(this.realKey(ownerId));
      if (ownerWs && !u?.is_owner) {
        void runInWorkspace(ownerWs, () => notify(ownerWs.db, "feedback", `💬 Feedback from ${u?.email ?? "someone"}`, `${b.message.slice(0, 300)}\n(on ${b.page || "?"})`)).catch(() => {});
        const ownerEmail = ownerId ? (this.accounts!.prepare("SELECT email FROM users WHERE id = ?").get(ownerId) as { email: string }).email : null;
        if (ownerEmail && mailConfigured()) void sendMail(ownerEmail, `FlipDesk feedback from ${u?.email ?? "someone"}`, `${b.message}\n\nPage: ${b.page}\nDetails: ${ctx}`).catch(() => {});
      }
      res.json({ ok: true, id });
    });

    // ---- Download all my data (the shop you're in) ----
    root.get("/api/export", async (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      const ws = this.current(req, req.fdUser ?? null);
      if (!ws) return void res.status(404).json({ error: "Shop not found" });
      const day = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="flipdesk-${ws.demo ? "sample-" : ""}export-${day}.zip"`);
      await exportShop(ws.db, ws.uploadDir, res, ws.demo ? "Sample shop" : req.fdUser?.email ?? "My shop");
    });

    // ---- Alert settings (owner) ----
    root.get("/api/alerts", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      res.json({ ...this.alertSettings(), quietNow: this.isQuiet() });
    });
    root.put("/api/alerts", json, (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      const b = z.object({ quiet: z.boolean(), quietStart: z.number().int().min(0).max(23), quietEnd: z.number().int().min(0).max(23) }).parse(req.body);
      this.siteSet("alerts", b);
      res.json({ ...this.alertSettings(), quietNow: this.isQuiet() });
    });

    // ---- Backups (owner) ----
    root.use("/api/backups", (req: R, res, next) => {
      if (!owner(req)) return void res.status(403).json({ error: "Only the owner can manage backups." });
      next();
    });
    root.get("/api/backups", (_req, res) =>
      void res.json({ last: this.siteGet("lastBackup", null), check: this.siteGet("lastBackupCheck", null), files: listBackups(this.dataDir), offsite: s3Configured(), disabled: process.env.BACKUP_DISABLED === "1" }),
    );
    root.post("/api/backups/:name/check", async (req, res) => void res.json(await this.checkBackup(String(req.params.name))));
    root.post("/api/backups", async (_req, res) => {
      const r = await this.backupNow();
      res.json({ last: this.siteGet("lastBackup", null), files: listBackups(this.dataDir), offsite: s3Configured(), result: { bytes: r.bytes, uploaded: r.uploaded, error: r.error ?? null } });
    });
    root.get("/api/backups/:name/contents", (req, res) => void res.json({ parts: this.backupContents(String(req.params.name)), lastRestore: this.siteGet("lastRestore", null) }));
    root.post("/api/backups/:name/restore", json, async (req, res) => {
      const b = z.object({ parts: z.array(z.string().max(40)).min(1).max(1000), confirm: z.literal("RESTORE") }).parse(req.body);
      res.json(await this.restore(String(req.params.name), b.parts));
    });
    root.get("/api/backups/:name", (req, res) => {
      const name = String(req.params.name);
      if (!/^flipdesk-\d{8}-\d{4,6}(-\d+)?\.zip$/.test(name)) return void res.status(400).end();
      const file = path.join(backupDir(this.dataDir), name);
      if (!fs.existsSync(file)) return void res.status(404).end();
      res.download(file, name);
    });

    // ---- Announcements ----
    const viewer = (req: R) => (req.fdUser ? `u${req.fdUser.id}` : "main");
    root.get("/api/announcements", (req: R, res) => void res.json(req.fdShare ? [] : this.announcementsFor(viewer(req))));
    root.post("/api/announcements/:id/dismiss", (req: R, res) => {
      this.site
        .prepare("INSERT INTO announcement_seen (announcement_id, viewer, dismissed_at) VALUES (?, ?, datetime('now')) ON CONFLICT(announcement_id, viewer) DO UPDATE SET dismissed_at = datetime('now')")
        .run(Number(req.params.id), viewer(req));
      res.json({ ok: true });
    });

    // ---- Ask FlipDesk (help chat) ----
    root.post("/api/help/ask", json, async (req: R, res) => {
      const b = z
        .object({
          question: z.string().trim().min(2, "Ask a question").max(1000),
          page: z.string().max(200).default(""),
          history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(12).default([]),
        })
        .parse(req.body);
      // Shared read-only visitors get doc search only (no AI on someone else's allowance).
      if (req.fdShare) return void res.json({ answer: null, sources: (await import("./services/help.js")).searchDocs(b.question), demo: true });
      const ws = this.current(req, req.fdUser ?? null);
      const r = await runInWorkspace(ws!, () => askHelp(b.question, b.history as HelpTurn[], b.page));
      const unsure = r.answer !== null && /isn't covered|not covered|couldn't find|can't find|don't (see|have) (that|anything)|no information/i.test(r.answer);
      const by = r.answer !== null ? (unsure ? "ai-unsure" : "ai") : r.sources.length ? "guide" : "none";
      const id = this.logHelp(req.fdUser ? `u${req.fdUser.id}` : "main", b.question, b.page, by, r.sources[0]?.title ?? null);
      res.json({ ...r, id });
    });
    root.post("/api/help/feedback", json, (req: R, res) => {
      const b = z.object({ id: z.number().int(), helpful: z.boolean() }).parse(req.body);
      this.site.prepare("UPDATE help_questions SET helpful = ? WHERE id = ? AND viewer = ?").run(b.helpful ? 1 : 0, b.id, req.fdUser ? `u${req.fdUser.id}` : "main");
      res.json({ ok: true });
    });

    // ---- Status ----
    root.get("/api/status", (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      const isOwner = this.multiuser ? Boolean(req.fdUser?.is_owner) : true;
      res.json({ ...this.status(req), incidents: this.recentIncidents(), backupCheck: isOwner ? this.siteGet("lastBackupCheck", null) : undefined });
    });

    // ---- Invite a friend (members), with a free month when they subscribe ----
    root.get("/api/invites", (req: R, res) => {
      const u = req.fdUser;
      if (!u || !this.memberInvitesOn()) return void res.json({ enabled: false });
      const mine = this.listInvites().filter((i) => i.created_by_email === u.email);
      const rewards = this.accounts!.prepare("SELECT r.kind, r.detail, r.created_at, u.email FROM referral_rewards r JOIN users u ON u.id = r.referred_id WHERE r.referrer_id = ? ORDER BY r.id DESC").all(u.id) as { kind: string; detail: string; created_at: string; email: string }[];
      res.json({
        enabled: true,
        reward: billingEnabled() ? "a free month when they start paying" : null,
        invites: mine.map((i) => ({ id: i.id, note: i.note, link: `${base(req)}/join?invite=${i.token}`, used: Boolean(i.used_at), usedBy: i.used_by_email?.replace(/^(.).*(@.*)$/, "$1…$2") ?? null, created_at: i.created_at })),
        rewards: rewards.map((r) => ({ ...r, email: r.email.replace(/^(.).*(@.*)$/, "$1…$2") })),
      });
    });
    root.post("/api/invites", json, (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      if (!this.memberInvitesOn()) return void res.status(403).json({ error: "Only the owner can invite people here." });
      const open = Number((this.accounts!.prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL").get(u.id) as { n: number }).n);
      if (open >= 10) return void res.status(429).json({ error: "You have 10 unused invite links. Use some first." });
      const note = z.object({ note: z.string().trim().max(80).default("") }).parse(req.body ?? {}).note;
      const token = this.createInvite(u.id, note);
      res.json({ link: `${base(req)}/join?invite=${token}` });
    });

    // ---- Owner: accounts ----
    root.use("/api/admin", (req: R, res, next) => {
      if (!this.multiuser || !req.fdUser?.is_owner) return void res.status(403).json({ error: "Only the owner can manage accounts." });
      next();
    });
    root.get("/api/admin/accounts", (_req, res) => void res.json({ accounts: this.adminList(), defaultAiLimit: this.defaultAiLimit(), inviteCode: Boolean(process.env.FLIPDESK_INVITE_CODE) }));
    root.post("/api/admin/accounts/:id/reset-link", (req, res) => {
      const id = Number(req.params.id);
      if (!this.accounts!.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return void res.status(404).json({ error: "No such account" });
      const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
      res.json({ link: `${base}/reset?token=${this.createReset(id, 24)}`, hours: 24 });
    });
    root.put("/api/admin/accounts/:id", json, (req, res) => {
      const b = z.object({ aiLimit: z.number().int().min(0).max(100000).nullable().optional(), comp: z.boolean().optional() }).parse(req.body);
      const id = Number(req.params.id);
      if (b.aiLimit !== undefined) this.accounts!.prepare("UPDATE users SET ai_limit = ? WHERE id = ?").run(b.aiLimit, id);
      // "Free forever" for friends and family (only replaces a plan that isn't a live Stripe subscription).
      if (b.comp === true) this.accounts!.prepare("UPDATE users SET plan = 'comp' WHERE id = ? AND (plan IS NULL OR plan NOT IN ('active','trialing','past_due'))").run(id);
      if (b.comp === false) this.accounts!.prepare("UPDATE users SET plan = NULL WHERE id = ? AND plan = 'comp'").run(id);
      res.json({ accounts: this.adminList() });
    });
    root.get("/api/admin/invites", (req, res) => void res.json({ invites: this.listInvites().map((i) => ({ ...i, link: `${base(req)}/join?invite=${i.token}` })) }));
    root.post("/api/admin/invites", json, (req: R, res) => {
      const note = z.object({ note: z.string().trim().max(80).default("") }).parse(req.body ?? {}).note;
      const token = this.createInvite(req.fdUser!.id, note);
      res.json({ link: `${base(req)}/join?invite=${token}`, invites: this.listInvites().map((i) => ({ ...i, link: `${base(req)}/join?invite=${i.token}` })) });
    });
    root.delete("/api/admin/invites/:id", (req, res) => {
      this.accounts!.prepare("UPDATE invites SET revoked_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(Number(req.params.id));
      res.json({ invites: this.listInvites().map((i) => ({ ...i, link: `${base(req)}/join?invite=${i.token}` })) });
    });
    root.get("/api/admin/owner-report", (_req, res) => void res.json(this.ownerReport()));
    root.get("/api/admin/help-insights", (req, res) => void res.json(this.helpInsights(Math.min(90, Number(req.query.days) || 7))));
    root.get("/api/admin/whats-new", async (_req, res) => {
      const since = this.siteGet<string | null>("lastAnnouncedCommit", null);
      const { changes, source } = await recentChanges(since);
      res.json({ source, since, changes: changes.map((c) => ({ sha: c.sha.slice(0, 10), date: c.date, subject: c.subject })), latest: changes[0]?.sha ?? null, draft: await draftWhatsNew(changes) });
    });
    root.post("/api/admin/owner-report", async (_req, res) => {
      const r = this.ownerReport();
      res.json({ ...r, ...(await this.tellOwner(r.title, r.body)) });
    });
    root.get("/api/admin/usage", (req, res) => void res.json(this.usage(Math.min(52, Math.max(4, Number(req.query.weeks) || 12)))));
    root.get("/api/admin/announcements", (_req, res) => void res.json(this.announcementList()));
    root.post("/api/admin/announcements", json, (req, res) => {
      const b = z
        .object({
          title: z.string().trim().min(3, "Give it a title").max(120),
          body: z.string().trim().max(1000).default(""),
          link: z.string().trim().max(300).default("").refine((v) => !v || /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(v), "Link must start with / or https://"),
          days: z.number().int().min(1).max(365).nullable().default(14),
          commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(), // posted from a "what's new" draft
        })
        .parse(req.body);
      if (b.commit) this.siteSet("lastAnnouncedCommit", b.commit);
      this.site.prepare("INSERT INTO announcements (title, body, link, ends_at) VALUES (?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)").run(b.title, b.body, b.link, b.days, `+${b.days ?? 0} days`);
      res.json(this.announcementList());
    });
    root.delete("/api/admin/announcements/:id", (req, res) => {
      this.site.prepare("UPDATE announcements SET archived_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
      res.json(this.announcementList());
    });
    root.get("/api/admin/feedback", (_req, res) => {
      const rows = this.site.prepare("SELECT * FROM feedback ORDER BY resolved_at IS NOT NULL, id DESC LIMIT 200").all() as Record<string, unknown>[];
      res.json({ feedback: rows.map((r) => ({ ...r, context: JSON.parse(String(r.context || "{}")) })), open: rows.filter((r) => !r.resolved_at).length });
    });
    root.post("/api/admin/feedback/:id/resolve", json, (req, res) => {
      const done = z.object({ resolved: z.boolean().default(true) }).parse(req.body ?? {}).resolved;
      this.site.prepare("UPDATE feedback SET resolved_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?").run(done ? 1 : 0, Number(req.params.id));
      res.json({ ok: true });
    });
    root.delete("/api/admin/accounts/:id", (req, res) => {
      this.deleteAccount(Number(req.params.id));
      res.json({ accounts: this.adminList() });
    });

    // ---- Leaderboard (opt-in) ----
    root.get("/api/leaderboard", (req: R, res) => {
      if (!this.multiuser) return void res.json({ available: false });
      const u = needUser(req, res);
      if (u) res.json({ available: true, ...this.leaderboard(u.id) });
    });
    root.post("/api/leaderboard", json, (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      const name = z.object({ name: z.string().trim().min(2).max(24).nullable() }).parse(req.body).name;
      this.accounts!.prepare("UPDATE users SET leaderboard_name = ? WHERE id = ?").run(name, u.id);
      res.json({ available: true, ...this.leaderboard(u.id) });
    });

    // ---- Help videos for the get-started steps (set by the owner) ----
    root.get("/api/help-videos", (_req, res) => void res.json(this.siteGet<Record<string, string>>("helpVideos", {})));
    root.put("/api/help-videos", json, (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Only the owner can change help videos." });
      const b = z.record(z.string().max(30), z.string().max(500)).parse(req.body);
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) {
        const url = v.trim();
        if (!url) continue;
        if (!/^https:\/\/[^\s]+$/i.test(url)) return void res.status(400).json({ error: `"${url}" isn't an https:// link` });
        clean[k] = url;
      }
      this.siteSet("helpVideos", clean);
      res.json(clean);
    });

    // ---- Share your sample shop (read-only link) ----
    root.get("/api/workspace/share", (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      const s = this.shareFor(this.demoKey(req.fdUser?.id));
      res.json({ share: s ? { path: `/s/${s.token}`, views: s.views } : null });
    });
    root.post("/api/workspace/share", async (req: R, res) => {
      const key = this.demoKey(req.fdUser?.id);
      if (!this.exists(key)) await this.resetDemo(req.fdUser?.id);
      const s = this.createShare(key);
      res.json({ share: { path: `/s/${s.token}`, views: s.views } });
    });
    root.delete("/api/workspace/share", (req: R, res) => {
      this.revokeShare(this.demoKey(req.fdUser?.id));
      res.json({ share: null });
    });

    // ---- Hand the request to the right shop ----
    root.use("/api", (req, res, next) => {
      const ws = (req as R).fdShare ?? this.current(req, (req as Request & { fdUser?: Account | null }).fdUser ?? null);
      if (!ws) return void res.status(404).json({ error: "Shop not found" });
      req.url = req.originalUrl;
      ws.app(req, res, next);
    });
    root.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof z.ZodError) return void res.status(400).json({ error: err.issues[0]?.message ?? "Invalid input" });
      const status = (err as { status?: number })?.status ?? 500;
      if (status >= 500) console.error("[front door]", (err as Error)?.message);
      res.status(status).json({ error: (err as Error)?.message ?? "Something went wrong" });
    });
    return root;
  }

  /** Run a background task for every shop, each inside its own shop. */
  async forEach(name: string, fn: (db: Db, ws: Workspace) => unknown, opts: { includeDemo?: boolean } = {}) {
    for (const ws of this.all()) {
      if (ws.demo && !opts.includeDemo) continue;
      try {
        await runInWorkspace(ws, () => fn(ws.db, ws));
        runInWorkspace(ws, () => reportHealth(`task:${name}`, true));
      } catch (e) {
        console.error(`[${name}:${ws.key}]`, (e as Error).message);
        runInWorkspace(ws, () => reportHealth(`task:${name}`, false, (e as Error).message));
      }
    }
  }
}

