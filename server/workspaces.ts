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
import { getSetting, openDb, setSetting, logActivity, type Db, type Rehearsal } from "./db.js";
import { hostGuard, localOnly, rateLimit, sameSiteGuard, securityHeaders } from "./security.js";
import { createApp } from "./app.js";
import { runInWorkspace, setAiGate, type WorkspaceContext } from "./context.js";
import { seedDemo } from "./demo.js";
import { accountDeletionChallenge } from "./marketplaces/ebay.js";
import { goalProgress } from "./services/goals.js";
import { mailConfigured, sendMail } from "./services/mailer.js";
import { applyStripeEvent, currentStripeMode, setStripeMode, stripeIsTest, stripeModes, stripePriceId, webhookSecrets, type StripeMode, billingEnabled, billingSummary, checkoutUrl, createWinbackCoupon, paidAiLimit, planStatus, portalUrl, stripeGet, stripePost, trialDays, verifyWebhook, winbackPct, type BillingRow } from "./services/billing.js";
import { backupAll, exportShop, listBackups, backupDir, s3Configured, verifyBackup, type BackupSource } from "./services/backup.js";
import { weeklySlot } from "./services/digest.js";
import { FIRST_WEEK } from "./services/firstWeek.js";
import { askHelp, draftArticle, setExtraArticles, type HelpTurn } from "./services/help.js";
import { getProblem, markSent } from "./services/replay.js";
import { createIssue, githubIssuesReady, problemIssue } from "./services/github.js";
import { runSelfCheck, speedLine, speedTrend, type SelfCheck } from "./services/selfcheck.js";
import { newRecoveryCodes, newSecret, otpauthUrl, useRecoveryCode, verifyTotp } from "./services/totp.js";
import { draftWhatsNew, recentChanges } from "./services/changelog.js";
import { notify, raiseAlert } from "./services/alerts.js";
import { currentDay, mergeDay, realTrend, recordTiming, type RealDay } from "./services/realSpeed.js";
import { listVersions, markFailed, previousGood, flyReady, switchImage, currentImage } from "./services/versions.js";
import { describeDevice, ensurePasskeys, finishLogin, finishRegistration, hasPasskeys, listPasskeys, loginOptions, registrationOptions, relyingParty, removePasskey, renamePasskey } from "./services/passkeys.js";
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
    // Single-password mode, owner lost every passkey and recovery code: start once with FLIPDESK_PASSKEY_RESET=1.
    if (!this.multiuser && process.env.FLIPDESK_PASSKEY_RESET === "1") {
      this.site.prepare("DELETE FROM passkey_only WHERE owner_key = 'owner'").run();
      console.log("[passkeys] FLIPDESK_PASSKEY_RESET=1: passkey-only sign-in is off for the owner. Remove the setting now.");
    }
    setStripeMode(this.siteGet<StripeMode | null>("stripeMode", null));
    setExtraArticles(() => this.helpArticles());
  }

  helpArticles() {
    try {
      return this.site.prepare("SELECT id, title, body, from_question, created_at, updated_at FROM help_articles WHERE archived_at IS NULL ORDER BY id").all() as { id: number; title: string; body: string; from_question: string | null; created_at: string; updated_at: string }[];
    } catch {
      return [];
    }
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
      CREATE TABLE IF NOT EXISTS nudges (user_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, kind, ref));
      CREATE TABLE IF NOT EXISTS cancellations (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, reason TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (const col of ["ai_limit INTEGER", "leaderboard_name TEXT", "plan TEXT", "trial_ends_at TEXT", "stripe_customer_id TEXT", "stripe_subscription_id TEXT", "current_period_end TEXT", "invited_by INTEGER", "email_opt_out INTEGER NOT NULL DEFAULT 0", "stripe_mode TEXT", "canceling INTEGER NOT NULL DEFAULT 0", "totp_secret TEXT", "totp_recovery TEXT", "totp_last_step INTEGER NOT NULL DEFAULT -1"]) {
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
        answered_by TEXT NOT NULL, top_source TEXT, helpful INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', ip TEXT);
      CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS known_devices (actor_key TEXT NOT NULL, device_hash TEXT NOT NULL, device TEXT NOT NULL DEFAULT '', ip TEXT,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (actor_key, device_hash));
      CREATE TABLE IF NOT EXISTS passkey_only (owner_key TEXT PRIMARY KEY, recovery TEXT NOT NULL DEFAULT '[]', enabled_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS not_me (token_hash TEXT PRIMARY KEY, actor_key TEXT NOT NULL, device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS help_articles (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, from_question TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT);`);
    try {
      site.exec("ALTER TABLE help_questions ADD COLUMN article_id INTEGER");
    } catch {
      /* already there */
    }
    for (const col of ["notified_at TEXT", "summarized_at TEXT"]) {
      try {
        site.exec(`ALTER TABLE incidents ADD COLUMN ${col}`);
      } catch {
        /* already there */
      }
    }
    ensurePasskeys(site as unknown as Db);
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
    return this.accounts!.prepare("SELECT id, email, is_owner, plan, trial_ends_at, stripe_customer_id, stripe_subscription_id, current_period_end, stripe_mode FROM users WHERE id = ?").get(userId) as unknown as
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
    let db: Db;
    try {
      db = openDb(dbFile);
    } catch (e) {
      // An update that didn't pass on a copy of this shop: the shop stays untouched; tell the owner (once per error).
      const msg = (e as Error).message;
      if (/tried this update on a copy/.test(msg)) {
        markFailed(this.dataDir, `${key}: ${msg}`);
        const seen = this.siteGet<string[]>("updateProblemsSeen", []);
        if (!seen.includes(key)) {
          this.siteSet("updateProblemsSeen", [...seen, key].slice(-50));
          void this.tellOwner("🔴 An update didn't pass its check on a copy of someone's data", `Shop ${key}: ${msg}\nGo back to the previous version: Tools → Status → Version.`).catch(() => {});
        }
      }
      throw e;
    }
    if (this.multiuser && ctx.userId && !demo) {
      const email = (this.accounts!.prepare("SELECT email FROM users WHERE id = ?").get(ctx.userId) as { email: string } | undefined)?.email;
      if (email) setSetting(db, "accountEmail", email);
    }
    // Accounts are checked in front of the shops when hosted; single-user keeps the shared password.
    // The front door (this class) checks sign-in for every shop, including two-step sign-in.
    const app = createApp(db, { uploadDir, workspace: ctx, password: "" });
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
    // The very first account becomes the owner. On a public server, only the email in FLIPDESK_OWNER_EMAIL
    // may claim it, so a stranger can't sign up first and take over.
    if (n === 0) {
      const ownerEmail = process.env.FLIPDESK_OWNER_EMAIL?.trim().toLowerCase();
      if (ownerEmail && email.toLowerCase() !== ownerEmail) throw Object.assign(new Error("This FlipDesk is waiting for its owner to sign up."), { status: 403 });
      if (!ownerEmail && !localOnly()) throw Object.assign(new Error("Set FLIPDESK_OWNER_EMAIL to your email on the server, then sign up with it."), { status: 403 });
    }
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
    for (const t of ["passkeys WHERE owner_key", "known_devices WHERE actor_key", "not_me WHERE actor_key", "passkey_only WHERE owner_key"]) this.site.prepare(`DELETE FROM ${t} = ?`).run(`u${userId}`);
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
        passkeyOnly: Boolean(this.passkeyOnly(u.id)),
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
      const price = await stripeGet<{ unit_amount: number; currency: string }>(`prices/${stripePriceId()}`);
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
      const sc = this.siteGet<SelfCheck[]>("selfChecks", [])[0];
      services.push(
        !sc
          ? { key: "self-check", label: "Nightly self-check", state: "off", detail: "Runs every night (speed, database health, disk space)" }
          : sc.ok
            ? { key: "self-check", label: "Nightly self-check", state: "ok", detail: `Passed ${Math.max(0, Math.round((Date.now() - Date.parse(sc.at)) / 3600_000))} h ago${sc.disk ? ` · ${sc.disk.freeGB} GB free` : ""}` }
            : { key: "self-check", label: "Nightly self-check", state: "down", detail: sc.problems.slice(0, 2).join("; ") },
      );
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
    const cx = this.cancellationSummary(7);
    if (cx.total) lines.push(`💔 ${cx.total} cancellation${cx.total === 1 ? "" : "s"}: ${cx.reasons.map((r) => `${r.label.toLowerCase()} (${r.count})`).join(", ")}`);
    const hi = this.helpInsights(7);
    const topTopic = hi.topTopics.find((t) => t.topic !== "Other");
    if (hi.total) lines.push(`❓ ${hi.total} Help question${hi.total === 1 ? "" : "s"}${topTopic ? `, most about "${topTopic.topic}" (${topTopic.count})` : ""}${hi.unanswered.length ? ` · ${hi.unanswered.length} without a good answer` : ""}`);
    const inc = this.site.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE started_at >= ${weekAgo}`).get() as { n: number };
    if (inc.n) lines.push(`🩺 ${inc.n} outage${inc.n === 1 ? "" : "s"} this week (see Tools → Status)`);
    const lb = this.siteGet<{ at?: string; error?: string | null } | null>("lastBackup", null);
    const chk = this.siteGet<{ at: string; ok: boolean } | null>("lastBackupCheck", null);
    const speed = speedLine(speedTrend(this.siteGet<SelfCheck[]>("selfChecks", [])));
    if (speed) lines.push(speed);
    const real = realTrend(this.siteGet<RealDay[]>("realSpeed", []));
    if (real?.rows.length) {
      const slowest = [...real.rows].filter((r) => r.n >= 5).sort((a, b) => b.p95 - a.p95)[0];
      lines.push(`🧭 Real use (${real.day}): ${real.uses} screen loads${slowest ? `, slowest ${slowest.name} (1 in 20 over ${slowest.p95} ms)` : ""}${real.slower.length ? ` · slower than usual: ${real.slower.map((r) => r.name).join(", ")}` : ""}`);
    }
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
      // Day 3 with nothing added yet: a short "need a hand?" with the three quickest wins.
      const created = (a.prepare("SELECT created_at FROM users WHERE id = ?").get(u.id) as { created_at: string }).created_at;
      const ageDays = (Date.now() - Date.parse(created.replace(" ", "T") + "Z")) / 86400_000;
      if (ageDays >= 3 && ageDays < 7 && nums && nums.items === 0 && once(u.id, "day3", "1")) {
        await sendMail(
          u.email,
          "Need a hand getting started with FlipDesk?",
          `Hi! You signed up a few days ago but haven't added an item yet. Three quick ways to start:\n\n1. Snap it: open Shoot mode on your phone (${link("/shoot")}), take 3-4 photos per item, and the AI writes the listing.\n2. Bring your stock over: import from Vendoo, List Perfectly, eBay or a spreadsheet (${link("/switch")}).\n3. Just look around: open the sample shop (Settings) to see everything with fake data.\n\nStuck on something? The ❓ Help button answers how-to questions, or just reply here.\n\nTurn these emails off in FlipDesk → Settings → Your account.`,
        ).catch(() => {});
        sent.push({ userId: u.id, kind: "day3" });
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

  // ---------------- Cancellations ----------------

  static CANCEL_REASONS: Record<string, string> = {
    too_expensive: "Too expensive",
    not_selling: "Not selling enough right now",
    missing_features: "Missing something I need",
    too_complex: "Too complicated",
    switched_service: "Switching to another tool",
    unused: "Not using it enough",
    customer_service: "Support wasn't helpful",
    low_quality: "Something didn't work right",
    too_slow: "Too slow",
    other: "Other",
  };

  recordCancellation(userId: number, reason: string, comment: string, source: "stripe" | "app") {
    const r = Workspaces.CANCEL_REASONS[reason] ? reason : "other";
    // Stripe and the app may both report the same cancellation: keep one per person per day, app wording wins.
    const today = this.accounts!.prepare("SELECT id, source FROM cancellations WHERE user_id = ? AND created_at >= datetime('now','-1 day')").get(userId) as { id: number; source: string } | undefined;
    if (today && (source === "stripe" || today.source === "app")) return today.id;
    if (today) this.accounts!.prepare("DELETE FROM cancellations WHERE id = ?").run(today.id);
    this.accounts!.prepare("UPDATE users SET canceling = 0 WHERE id = ?").run(userId);
    return Number(this.accounts!.prepare("INSERT INTO cancellations (user_id, reason, comment, source) VALUES (?, ?, ?, ?)").run(userId, r, comment.slice(0, 1000), source).lastInsertRowid);
  }

  /** Ask why, once, after someone cancels (or schedules a cancel) and hasn't said. */
  shouldAskCancelReason(userId: number) {
    const u = this.accounts!.prepare("SELECT plan, canceling FROM users WHERE id = ?").get(userId) as { plan: string | null; canceling: number } | undefined;
    if (!u || !(u.canceling || u.plan === "canceled")) return false;
    return !this.accounts!.prepare("SELECT 1 FROM cancellations WHERE user_id = ? AND created_at >= datetime('now','-90 days')").get(userId);
  }

  cancellationSummary(days = 30) {
    const rows = this.accounts!.prepare(
      "SELECT c.reason, c.comment, c.source, c.created_at, u.email FROM cancellations c LEFT JOIN users u ON u.id = c.user_id WHERE c.created_at >= datetime('now', ?) ORDER BY c.id DESC",
    ).all(`-${days} days`) as { reason: string; comment: string; source: string; created_at: string; email: string | null }[];
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
    return {
      total: rows.length,
      reasons: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, label: Workspaces.CANCEL_REASONS[reason] ?? reason, count })),
      recent: rows.slice(0, 20).map((r) => ({ ...r, label: Workspaces.CANCEL_REASONS[r.reason] ?? r.reason })),
    };
  }

  // ---------------- Pre-launch checklist ----------------

  lastMonitorHit: { at: string; agent: string } | null = null;

  launchChecks(req: Request & { fdUser?: Account | null }) {
    type Check = { key: string; group: string; label: string; state: "ok" | "warn" | "fail" | "optional"; detail: string; fix?: string; href?: string };
    const out: Check[] = [];
    const add = (c: Check) => out.push(c);
    const base = process.env.PUBLIC_BASE_URL ?? "";
    const o = this.ownerContact();
    const ownerDb = o?.ws.db;
    const age = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z")) / 3600_000 : null);

    // Address & safety
    add(base.startsWith("https://")
      ? { key: "https", group: "Address & safety", label: "HTTPS address", state: "ok", detail: base }
      : { key: "https", group: "Address & safety", label: "HTTPS address", state: "fail", detail: base ? `${base} isn't https` : "PUBLIC_BASE_URL isn't set", fix: "Set PUBLIC_BASE_URL=https://your-address (docs/DEPLOY.md)" });
    add(this.multiuser || this.password
      ? { key: "login", group: "Address & safety", label: "Sign-in required", state: "ok", detail: this.multiuser ? "Accounts mode (email + password)" : "Password set" }
      : { key: "login", group: "Address & safety", label: "Sign-in required", state: "fail", detail: "Anyone with the address could open your shop", fix: "Set FLIPDESK_PASSWORD, or FLIPDESK_MULTIUSER=1 for accounts" });
    const onVolume = /^\/data\//.test(path.resolve(this.dataDir) + "/") || !process.env.FLY_APP_NAME;
    add({ key: "volume", group: "Address & safety", label: "Data on a lasting disk", state: onVolume ? "ok" : "fail", detail: process.env.FLY_APP_NAME ? `Data folder: ${path.resolve(this.dataDir)}` : "Running on your own machine", fix: onVolume ? undefined : "On Fly, mount a volume at /data and set FLIPDESK_DB=/data/flipdesk.db" });

    // AI & marketplaces
    const ai = globalCheck("ai");
    add(!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
      ? { key: "ai", group: "Selling", label: "AI listing writer", state: "warn", detail: "No Anthropic key: the demo writer is used", fix: "Set ANTHROPIC_API_KEY (console.anthropic.com)" }
      : stateOf(ai) === "down"
        ? { key: "ai", group: "Selling", label: "AI listing writer", state: "fail", detail: `Last try failed: ${ai!.lastError}`, href: "/status" }
        : { key: "ai", group: "Selling", label: "AI listing writer", state: "ok", detail: ai ? "Key set and answering" : "Key set (not used since the server started)" });
    const ebayKeys = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
    add(!ebayKeys
      ? { key: "ebay-keys", group: "Selling", label: "eBay developer keys", state: "warn", detail: "eBay is in demo mode", fix: "Follow docs/EBAY_SETUP.md" }
      : { key: "ebay-keys", group: "Selling", label: "eBay developer keys", state: "ok", detail: process.env.EBAY_ENV === "sandbox" ? "Sandbox keys (not real listings)" : "Production keys" });
    if (ebayKeys && ownerDb) {
      const live = runInWorkspace(o!.ws, () => ebayIsLive(ownerDb));
      const policies = getSetting<{ fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string }>(ownerDb, "ebay", {});
      add(live
        ? { key: "ebay-connected", group: "Selling", label: "Your eBay account connected", state: "ok", detail: "Connected" }
        : { key: "ebay-connected", group: "Selling", label: "Your eBay account connected", state: "fail", detail: "Not connected yet", href: "/connections" });
      if (live) add(policies.fulfillmentPolicyId && policies.paymentPolicyId && policies.returnPolicyId
        ? { key: "ebay-policies", group: "Selling", label: "eBay shipping/payment/return policies", state: "ok", detail: "Chosen" }
        : { key: "ebay-policies", group: "Selling", label: "eBay shipping/payment/return policies", state: "fail", detail: "Pick them before listing", href: "/settings#ebay" });
    }

    if (ebayKeys && ownerDb) {
      const smoke = getSetting<{ ok: boolean; ranAt: string; env: string } | null>(ownerDb, "ebaySmoke", null);
      add(smoke?.ok
        ? { key: "ebay-smoke", group: "Selling", label: "eBay end-to-end test", state: "ok", detail: `Passed ${Math.round((age(smoke.ranAt) ?? 0) / 24)} days ago (${smoke.env})` }
        : { key: "ebay-smoke", group: "Selling", label: "eBay end-to-end test", state: "warn", detail: smoke ? "Last test failed" : "Not run yet", fix: "Marketplaces → eBay → Run eBay test (lists and ends a test item on eBay's sandbox)", href: "/connections" });
    }

    // Staying informed
    const mail = globalCheck("mail");
    add(!mailConfigured()
      ? { key: "email", group: "Staying informed", label: "Email", state: this.multiuser ? "fail" : "optional", detail: this.multiuser ? "Needed for password resets and reminders" : "Optional: weekly summary by email", fix: "Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM" }
      : stateOf(mail) === "down"
        ? { key: "email", group: "Staying informed", label: "Email", state: "fail", detail: `Last send failed: ${mail!.lastError}` }
        : { key: "email", group: "Staying informed", label: "Email", state: "ok", detail: mail ? "Sending" : "Set (use Send test email to be sure)" });
    const topic = ownerDb ? getSetting<{ ntfyTopic?: string }>(ownerDb, "notify", {}).ntfyTopic : undefined;
    add(topic
      ? { key: "push", group: "Staying informed", label: "Phone alerts (ntfy)", state: "ok", detail: `Topic set` }
      : { key: "push", group: "Staying informed", label: "Phone alerts (ntfy)", state: "fail", detail: "You won't hear about sales, oversells or outages", href: "/settings" });
    const mon = this.lastMonitorHit;
    add(mon && (age(mon.at) ?? 99) < 0.5
      ? { key: "uptime", group: "Staying informed", label: "Uptime monitor", state: "ok", detail: `${mon.agent} checked in ${Math.max(0, Math.round((age(mon.at) ?? 0) * 60))} min ago` }
      : { key: "uptime", group: "Staying informed", label: "Uptime monitor", state: base ? "warn" : "optional", detail: mon ? `Last seen ${Math.round(age(mon.at)!)} h ago` : "No monitor has checked /healthz yet", fix: `Add ${base || "your address"}/healthz in UptimeRobot or Better Stack (free)` });

    // Data safety
    const lb = this.siteGet<{ at?: string; uploaded?: string | null; error?: string | null } | null>("lastBackup", null);
    const lbAge = age(lb?.at);
    add(lbAge !== null && lbAge < 30
      ? { key: "backup", group: "Data safety", label: "Nightly backup", state: "ok", detail: `Last one ${Math.round(lbAge)} h ago` }
      : { key: "backup", group: "Data safety", label: "Nightly backup", state: "fail", detail: lb?.at ? `Last one ${Math.round(lbAge!)} h ago` : "None yet", href: "/settings" });
    add(s3Configured()
      ? { key: "offsite", group: "Data safety", label: "Off-site copy", state: lb?.uploaded ? "ok" : "warn", detail: lb?.uploaded ? "Last backup uploaded" : lb?.error ?? "Set, waiting for the next backup" }
      : { key: "offsite", group: "Data safety", label: "Off-site copy", state: "fail", detail: "Backups only live on this server", fix: "Set BACKUP_S3_* (Cloudflare R2 is free up to 10 GB)" });
    const chk = this.siteGet<{ at: string; ok: boolean } | null>("lastBackupCheck", null);
    add(chk?.ok
      ? { key: "restore-check", group: "Data safety", label: "Backup restore check", state: "ok", detail: `Passed ${Math.round((age(chk.at) ?? 0) / 24)} days ago` }
      : { key: "restore-check", group: "Data safety", label: "Backup restore check", state: chk ? "fail" : "warn", detail: chk ? "Last check failed" : "Not run yet", href: "/settings" });

    add(this.password || this.multiuser
      ? this.twofa(this.multiuser ? o?.ws.userId : undefined)
        ? { key: "2fa", group: "Address & safety", label: "Two-step sign-in (owner)", state: "ok", detail: "On" }
        : { key: "2fa", group: "Address & safety", label: "Two-step sign-in (owner)", state: this.multiuser ? "warn" : "optional", detail: "Off: a stolen password is enough to get in", href: "/settings" }
      : { key: "2fa", group: "Address & safety", label: "Two-step sign-in (owner)", state: "optional", detail: "Needs a password first" });
    add(githubIssuesReady()
      ? { key: "reports", group: "Staying informed", label: "Problem reports to GitHub", state: "ok", detail: `Issues go to ${process.env.FLIPDESK_GITHUB_REPO}` }
      : { key: "reports", group: "Staying informed", label: "Problem reports to GitHub", state: "optional", detail: "Without it, reports can still be downloaded and sent by hand", fix: "Set FLIPDESK_GITHUB_REPO and GITHUB_TOKEN (Issues: write)" });
    if (this.password || this.multiuser) {
      const keys = listPasskeys(this.site, this.keyFor(this.multiuser ? o?.ws.userId : undefined)).length;
      add(keys
        ? { key: "passkey", group: "Address & safety", label: "Passkey (owner)", state: "ok", detail: `${keys} set up` }
        : { key: "passkey", group: "Address & safety", label: "Passkey (owner)", state: "optional", detail: "Sign in with Face ID or a fingerprint; can't be phished", href: "/settings" });
    }
    const ownerDbFile = o?.ws.dbFile;
    const reh = (() => {
      try {
        return ownerDbFile ? (JSON.parse(fs.readFileSync(path.join(path.dirname(ownerDbFile), "before-update", "last.json"), "utf8")) as Rehearsal) : null;
      } catch {
        return null;
      }
    })();
    add(reh
      ? { key: "update-copy", group: "Data safety", label: "Updates tried on a copy first", state: reh.ok ? "ok" : "fail", detail: reh.ok ? `Last update (v${reh.from} → v${reh.to}) passed on a copy ${Math.round((age(reh.at) ?? 0) / 24)} days ago` : `Last update stopped: ${reh.detail}` }
      : { key: "update-copy", group: "Data safety", label: "Updates tried on a copy first", state: "ok", detail: "Automatic: the next update that changes your data is tried on a copy before it touches the real thing" });
    const sc = this.siteGet<SelfCheck[]>("selfChecks", [])[0];
    add(sc
      ? { key: "selfcheck", group: "Data safety", label: "Nightly self-check", state: sc.ok ? "ok" : "fail", detail: sc.ok ? "Passing" : sc.problems[0] ?? "Problems found", href: "/status" }
      : { key: "selfcheck", group: "Data safety", label: "Nightly self-check", state: "warn", detail: "Hasn't run yet (runs nightly)" });

    // Others using it
    if (this.multiuser) {
      const anyInvite = Boolean(process.env.FLIPDESK_INVITE_CODE) || Boolean(this.accounts!.prepare("SELECT 1 FROM invites WHERE used_at IS NULL AND revoked_at IS NULL").get());
      add({ key: "invites", group: "Others using it", label: "Invites ready", state: anyInvite ? "ok" : "warn", detail: anyInvite ? "People can join" : "Nobody can sign up yet", href: "/accounts" });
      if (billingEnabled()) {
        const evt = this.siteGet<string | null>("lastStripeEvent", null);
        add(stripeIsTest()
          ? { key: "stripe", group: "Others using it", label: "Payments", state: "warn", detail: "TEST mode: no real money", fix: "Set your live keys and switch to Live on the Accounts page", href: "/accounts" }
          : { key: "stripe", group: "Others using it", label: "Payments", state: "ok", detail: "Live" });
        add(evt
          ? { key: "stripe-webhook", group: "Others using it", label: "Stripe webhook", state: "ok", detail: `Last event ${Math.round(age(evt)! * 10) / 10} h ago` }
          : { key: "stripe-webhook", group: "Others using it", label: "Stripe webhook", state: "fail", detail: "Stripe hasn't reached FlipDesk yet", fix: `Add ${base || "your address"}/api/billing/webhook in Stripe → Webhooks` });
      } else add({ key: "stripe", group: "Others using it", label: "Payments", state: "optional", detail: "Off: everyone is free" });
      add(process.env.ANTHROPIC_API_KEY ? { key: "ai-cap", group: "Others using it", label: "AI spending cap", state: "ok", detail: `${this.defaultAiLimit()} requests/day per person` } : { key: "ai-cap", group: "Others using it", label: "AI spending cap", state: "optional", detail: "No AI key" });
    }
    const counted = out.filter((c) => c.state !== "optional");
    return { checks: out, ready: counted.filter((c) => c.state === "ok").length, total: counted.length, blockers: counted.filter((c) => c.state === "fail").length };
  }

  // ---------------- Help insights ----------------

  logHelp(viewer: string, question: string, page: string, answeredBy: string, topSource: string | null) {
    return Number(this.site.prepare("INSERT INTO help_questions (viewer, question, page, answered_by, top_source) VALUES (?, ?, ?, ?, ?)").run(viewer, question.slice(0, 500), page.slice(0, 200), answeredBy, topSource).lastInsertRowid);
  }

  /** What people ask Help: top topics, questions without a good answer, and how often answers helped. */
  helpInsights(days = 7) {
    const since = `-${Math.max(1, days)} days`;
    const rows = this.site.prepare("SELECT id, question, page, answered_by, top_source, helpful, created_at, article_id FROM help_questions WHERE created_at >= datetime('now', ?) ORDER BY id DESC").all(since) as {
      id: number; question: string; page: string; answered_by: string; top_source: string | null; helpful: number | null; created_at: string; article_id: number | null;
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
      unanswered: rows.filter((r) => !r.article_id && (r.answered_by === "none" || r.answered_by === "ai-unsure" || r.helpful === 0)).slice(0, 15),
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

  // ---------------- Nightly self-check ----------------

  async selfCheckNow(items?: number) {
    const history = this.siteGet<SelfCheck[]>("selfChecks", []);
    const dbs = [...this.all().filter((w) => !w.demo).map((w) => ({ name: w.key === "main" ? "shop" : `shop ${w.key}`, db: w.db })), ...(this.accounts ? [{ name: "accounts", db: this.accounts }] : []), { name: "site", db: this.site }];
    const r = await runSelfCheck({ dbs, dataDir: this.dataDir, history, items });
    this.siteSet("selfChecks", [r, ...history].slice(0, 14));
    if (!r.ok) await this.tellOwner("🔴 FlipDesk's nightly check found problems", `${r.problems.join("\n")}\nDetails: Tools → Status.`);
    return r;
  }

  async selfCheckIfDue() {
    const last = this.siteGet<SelfCheck[]>("selfChecks", [])[0];
    if (last && Date.now() - Date.parse(last.at) < 23 * 3600_000) return null;
    return this.selfCheckNow();
  }

  // ---------------- Speed from real use ----------------

  private saveRealDay(d: RealDay) {
    this.siteSet("realSpeed", mergeDay(this.siteGet<RealDay[]>("realSpeed", []), d));
  }

  /** Hourly: save today's real-use timings; tell the owner (once a day) if a screen got clearly slower or is too slow. */
  async flushRealSpeed() {
    const d = currentDay();
    if (d.rows.length) this.saveRealDay(d);
    const t = realTrend(this.siteGet<RealDay[]>("realSpeed", []));
    if (!t) return null;
    const bad = [...t.slower.map((r) => `${r.name} is slower than usual for real users: ${r.p50} ms typical (usually ${r.usual} ms), ${r.n} uses`), ...t.tooSlow.filter((r) => !r.slower).map((r) => `${r.name} is too slow for real users: 1 in 20 loads takes over ${(r.p95 / 1000).toFixed(1)} s (${r.n} uses)`)];
    if (bad.length && this.siteGet<string | null>("realSpeedAlerted", null) !== t.day) {
      this.siteSet("realSpeedAlerted", t.day);
      await this.tellOwner("🐢 FlipDesk is slow for real users", `${bad.join("\n")}\nDetails: Tools → Status → Speed.`, { email: false }).catch(() => {});
    }
    return t;
  }

  // ---------------- Activity log (owner) ----------------

  audit(req: Request | null, action: string, detail = "", actor?: string) {
    try {
      const u = (req as (Request & { fdUser?: Account | null }) | null)?.fdUser;
      const who = actor ?? (u ? u.email : this.multiuser ? "someone" : "owner");
      this.site.prepare("INSERT INTO audit (actor, action, detail, ip) VALUES (?, ?, ?, ?)").run(who, action, detail.slice(0, 500), req?.ip ?? null);
      if (Math.random() < 0.01) this.site.prepare("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 20000)").run();
    } catch {
      /* the log never blocks the action */
    }
  }

  auditList(opts: { q?: string; limit?: number; before?: number } = {}) {
    const q = `%${(opts.q ?? "").trim()}%`;
    return this.site
      .prepare(`SELECT * FROM audit WHERE (? = '%%' OR actor LIKE ? OR action LIKE ? OR detail LIKE ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
      .all(q, q, q, q, opts.before ?? null, opts.before ?? null, Math.min(500, opts.limit ?? 100)) as { id: number; at: string; actor: string; action: string; detail: string; ip: string | null }[];
  }

  // ---------------- Two-step sign-in ----------------

  private pending2fa = new Map<string, { secret: string; exp: number }>();
  private loginTickets = new Map<string, { key: string; userId?: number; exp: number; tries: number; kind?: "2fa" | "code"; codeHash?: string }>();
  private keyFor = (userId?: number) => (userId ? `u${userId}` : "owner");
  accountEmail = (userId: number) => (this.accounts?.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined)?.email ?? `#${userId}`;

  twofa(userId?: number): { secret: string; recovery: string[]; lastStep: number } | null {
    if (userId && this.accounts) {
      const r = this.accounts.prepare("SELECT totp_secret, totp_recovery, totp_last_step FROM users WHERE id = ?").get(userId) as { totp_secret: string | null; totp_recovery: string | null; totp_last_step: number } | undefined;
      return r?.totp_secret ? { secret: r.totp_secret, recovery: JSON.parse(r.totp_recovery ?? "[]"), lastStep: r.totp_last_step } : null;
    }
    return this.siteGet<{ secret: string; recovery: string[]; lastStep: number } | null>("ownerTotp", null);
  }

  private saveTwofa(userId: number | undefined, v: { secret: string; recovery: string[]; lastStep: number } | null) {
    if (userId && this.accounts) this.accounts.prepare("UPDATE users SET totp_secret = ?, totp_recovery = ?, totp_last_step = ? WHERE id = ?").run(v?.secret ?? null, v ? JSON.stringify(v.recovery) : null, v?.lastStep ?? -1, userId);
    else this.siteSet("ownerTotp", v);
  }

  /** Check a 6-digit code (no reuse) or a one-time recovery code. */
  checkSecondFactor(userId: number | undefined, code: string): "totp" | "recovery" | null {
    const t = this.twofa(userId);
    if (!t) return null;
    const step = verifyTotp(t.secret, code, Date.now(), t.lastStep);
    if (step !== null) {
      this.saveTwofa(userId, { ...t, lastStep: step });
      return "totp";
    }
    const left = useRecoveryCode(t.recovery, code);
    if (left) {
      this.saveTwofa(userId, { ...t, recovery: left });
      return "recovery";
    }
    return null;
  }

  private newTicket(userId?: number) {
    const t = crypto.randomBytes(24).toString("base64url");
    for (const [k, v] of this.loginTickets) if (v.exp < Date.now()) this.loginTickets.delete(k);
    this.loginTickets.set(t, { key: this.keyFor(userId), userId, exp: Date.now() + 5 * 60_000, tries: 0 });
    return t;
  }

  /** Single-password mode sessions (used once two-step sign-in is on, so the password alone can't make a cookie). */
  private newOwnerSession() {
    const token = crypto.randomBytes(32).toString("base64url");
    this.site.prepare("DELETE FROM owner_sessions WHERE expires_at < datetime('now')").run();
    this.site.prepare("INSERT INTO owner_sessions (token_hash, expires_at) VALUES (?, datetime('now','+30 days'))").run(sha(token));
    return token;
  }

  /** The older single-password cookie (still accepted until "sign out everywhere" bumps the epoch). */
  private legacyOwnerCookie() {
    const epoch = this.siteGet<number>("ownerCookieEpoch", 0);
    return crypto.createHmac("sha256", this.password).update(epoch ? `flipdesk-session:${epoch}` : "flipdesk-session").digest("base64url");
  }

  // ---------------- Sign-in, devices, "this wasn't me" ----------------

  /** Every successful sign-in goes through here: session cookie, new-device check, activity log. */
  private signIn(req: Request, res: Response, userId: number | undefined, how: string) {
    const cookies = [userId ? cookie(req, "fd_user", this.newSession(userId), 60 * 60 * 24 * 30) : cookie(req, "fd_session", this.newOwnerSession(), 60 * 60 * 24 * 30)];
    const dev = this.noteDevice(req, userId, how);
    if (dev) cookies.push(dev);
    res.setHeader("Set-Cookie", cookies);
    this.audit(req, "signed in", how, userId ? this.accountEmail(userId) : "owner");
  }

  /** Remember this browser for this account; tell them when a browser they haven't used before signs in. */
  private noteDevice(req: Request, userId: number | undefined, how: string): string | null {
    try {
      let id = readCookie(req, "fd_dev") ?? "";
      let set: string | null = null;
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
        id = crypto.randomBytes(18).toString("base64url");
        set = cookie(req, "fd_dev", id, 60 * 60 * 24 * 400);
      }
      const key = this.keyFor(userId);
      const device = describeDevice(String(req.headers["user-agent"] ?? ""));
      const known = this.site.prepare("SELECT 1 FROM known_devices WHERE actor_key = ? AND device_hash = ?").get(key, sha(id));
      if (known) {
        this.site.prepare("UPDATE known_devices SET last_seen = datetime('now'), ip = ?, device = ? WHERE actor_key = ? AND device_hash = ?").run(req.ip ?? null, device, key, sha(id));
        return set;
      }
      const before = (this.site.prepare("SELECT COUNT(*) AS n FROM known_devices WHERE actor_key = ?").get(key) as { n: number }).n;
      this.site.prepare("INSERT INTO known_devices (actor_key, device_hash, device, ip) VALUES (?, ?, ?, ?)").run(key, sha(id), device, req.ip ?? null);
      if (before > 0) void this.newDeviceAlert(req, userId, device, how).catch((e) => console.error("[new device]", (e as Error).message));
      return set;
    } catch {
      return null; // never block a sign-in
    }
  }

  /** "New sign-in: Safari on iPhone" with a "this wasn't me" link that signs every device out. */
  async newDeviceAlert(req: Request, userId: number | undefined, device: string, how: string) {
    const key = this.keyFor(userId);
    const token = crypto.randomBytes(24).toString("base64url");
    this.site.prepare("DELETE FROM not_me WHERE expires_at < datetime('now')").run();
    this.site.prepare("INSERT INTO not_me (token_hash, actor_key, device, expires_at) VALUES (?, ?, ?, datetime('now','+14 days'))").run(sha(token), key, device);
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
    const link = `${base}/not-me?t=${token}`;
    const when = new Date().toUTCString();
    const title = `New sign-in to FlipDesk: ${device}`;
    const body = `Someone signed in to ${userId ? "your FlipDesk account" : "your FlipDesk"} from a browser it hasn't seen before.\n\nDevice: ${device}\nAddress: ${req.ip ?? "unknown"}\nWhen: ${when}${how ? `\nHow: ${how}` : ""}\n\nIf this was you, there's nothing to do.\nIf it wasn't: ${link}\nThat signs out every device right away${userId ? " and sends you a link to choose a new password" : ""}.`;
    this.audit(req, "new device", device, userId ? this.accountEmail(userId) : "owner");
    if (userId) {
      const email = this.accountEmail(userId);
      // Security emails go out even if reminder emails are turned off.
      if (mailConfigured() || process.env.SMTP_HOST === "test") await sendMail(email, title, body).catch(() => false);
      const ws = this.get(this.realKey(userId));
      if (ws) await runInWorkspace(ws, () => notify(ws.db, "security", title, body)).catch(() => false);
    } else {
      await this.tellOwner(title, body);
      const ws = this.get("main");
      if (ws) raiseAlert(ws.db, { kind: "security", severity: "warning", title, body: `${device} from ${req.ip ?? "?"}. Not you? Open the link in your phone alert, or Settings → Signed-in devices → Sign out everywhere.` });
    }
    return { link };
  }

  /** Sign this account out everywhere (and forget its devices). */
  signOutEverywhere(userId: number | undefined) {
    if (userId) this.accounts!.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    else {
      this.site.prepare("DELETE FROM owner_sessions").run();
      this.siteSet("ownerCookieEpoch", Date.now()); // the older password cookie stops working too
    }
    this.site.prepare("DELETE FROM known_devices WHERE actor_key = ?").run(this.keyFor(userId));
  }

  /** The "this wasn't me" link. */
  async notMe(req: Request, token: string) {
    const r = this.site.prepare("SELECT * FROM not_me WHERE token_hash = ? AND expires_at > datetime('now') AND used_at IS NULL").get(sha(token)) as { actor_key: string; device: string; created_at: string } | undefined;
    if (!r) throw Object.assign(new Error("This link has expired or was already used. Sign in and use Settings → Signed-in devices → Sign out everywhere."), { status: 410 });
    this.site.prepare("UPDATE not_me SET used_at = datetime('now') WHERE token_hash = ?").run(sha(token));
    const userId = r.actor_key === "owner" ? undefined : Number(r.actor_key.slice(1));
    this.signOutEverywhere(userId);
    // Passkeys added since that sign-in could be the intruder's: remove them.
    const removed = this.site.prepare("DELETE FROM passkeys WHERE owner_key = ? AND created_at >= ?").run(r.actor_key, r.created_at).changes;
    // Passkey-only turned on by the intruder (or now with too few passkeys left): off, so the reset link works.
    const po = this.site.prepare("SELECT enabled_at FROM passkey_only WHERE owner_key = ?").get(r.actor_key) as { enabled_at: string } | undefined;
    if (po && (po.enabled_at >= r.created_at || listPasskeys(this.site, r.actor_key).length < 2)) this.site.prepare("DELETE FROM passkey_only WHERE owner_key = ?").run(r.actor_key);
    let resetSent = false;
    if (userId) resetSent = (await this.forgot(this.accountEmail(userId)).catch(() => ({ emailed: false }))).emailed;
    this.audit(req, "signed out everywhere", `"this wasn't me" for ${r.device}${removed ? `; removed ${removed} new passkey(s)` : ""}`, userId ? this.accountEmail(userId) : "owner");
    await this.tellOwner("🔐 Someone used \"this wasn't me\" on FlipDesk", `${userId ? this.accountEmail(userId) : "You"}: every device was signed out (${r.device}).`, { email: false }).catch(() => {});
    return { ok: true, resetSent, removedPasskeys: removed, mode: this.multiuser ? "accounts" : "single" };
  }

  devicesFor(userId: number | undefined, req: Request) {
    const cur = readCookie(req, "fd_dev");
    const here = cur ? sha(cur) : "";
    return (this.site.prepare("SELECT device_hash, device, ip, first_seen, last_seen FROM known_devices WHERE actor_key = ? ORDER BY last_seen DESC").all(this.keyFor(userId)) as { device_hash: string; device: string; ip: string | null; first_seen: string; last_seen: string }[]).map((d) => ({ device: d.device, ip: d.ip, firstSeen: d.first_seen, lastSeen: d.last_seen, thisOne: d.device_hash === here }));
  }

  // ---------------- Passkey-only sign-in ----------------

  passkeyOnly(userId: number | undefined) {
    const r = this.site.prepare("SELECT recovery, enabled_at FROM passkey_only WHERE owner_key = ?").get(this.keyFor(userId)) as { recovery: string; enabled_at: string } | undefined;
    return r ? { recovery: JSON.parse(r.recovery) as string[], enabledAt: r.enabled_at } : null;
  }
  setPasskeyOnly(userId: number | undefined, recovery: string[] | null) {
    const key = this.keyFor(userId);
    if (recovery) this.site.prepare("INSERT INTO passkey_only (owner_key, recovery) VALUES (?, ?) ON CONFLICT(owner_key) DO UPDATE SET recovery = excluded.recovery").run(key, JSON.stringify(recovery));
    else this.site.prepare("DELETE FROM passkey_only WHERE owner_key = ?").run(key);
  }

  // ---------------- Suspicious sign-ins ----------------

  /** A browser this account hasn't used, right after several wrong passwords: ask for a code we send them first. */
  private suspicious(req: Request, userId: number | undefined, actor: string) {
    const limit = Number(process.env.FLIPDESK_SUSPICIOUS_FAILS ?? 3);
    if (!limit) return false;
    const dev = readCookie(req, "fd_dev");
    if (dev && this.site.prepare("SELECT 1 FROM known_devices WHERE actor_key = ? AND device_hash = ?").get(this.keyFor(userId), sha(dev))) return false;
    const fails = (this.site.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'sign-in failed' AND LOWER(actor) = LOWER(?) AND at >= datetime('now','-1 hour')").get(actor) as { n: number }).n;
    return fails >= limit;
  }

  /** Send a 6-digit sign-in code by email (accounts) or phone alert (single-password mode). Null = no way to send one. */
  private async sendSignInCode(req: Request, userId: number | undefined): Promise<{ ticket: string; sentTo: "email" | "phone" } | null> {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const device = describeDevice(String(req.headers["user-agent"] ?? ""));
    const body = `Your FlipDesk sign-in code is ${code}. It works for 10 minutes.\n\nWe asked for it because someone is signing in from ${device} (${req.ip ?? "unknown address"}) right after several wrong passwords.\nIf that isn't you, don't share the code, and change your password.`;
    let sentTo: "email" | "phone" | null = null;
    if (userId) {
      if ((mailConfigured() || process.env.SMTP_HOST === "test") && (await sendMail(this.accountEmail(userId), `FlipDesk sign-in code: ${code}`, body).catch(() => false))) sentTo = "email";
    } else {
      const ws = this.get("main");
      if (ws && (await runInWorkspace(ws, () => notify(ws.db, "security", `FlipDesk sign-in code ${code}`, body)).catch(() => false))) sentTo = "phone";
    }
    if (!sentTo) return null;
    const ticket = crypto.randomBytes(24).toString("base64url");
    for (const [k, v] of this.loginTickets) if (v.exp < Date.now()) this.loginTickets.delete(k);
    this.loginTickets.set(ticket, { key: this.keyFor(userId), userId, exp: Date.now() + 10 * 60_000, tries: 0, kind: "code", codeHash: sha(code) });
    return { ticket, sentTo };
  }

  /** After the password checked out: passkey-only? two-step? suspicious? Otherwise sign in. Returns what the client needs. */
  private async afterPassword(req: Request, res: Response, userId: number | undefined, actor: string) {
    if (this.passkeyOnly(userId)) {
      this.audit(req, "sign-in failed", "password used on a passkey-only account", actor);
      return { status: 403, body: { error: "This account signs in with a passkey only. Use “Sign in with a passkey”, or a recovery code if you lost your passkeys.", passkeyOnly: true } };
    }
    if (this.twofa(userId)) return { status: 200, body: { needs2fa: true, ticket: this.newTicket(userId) } };
    if (this.suspicious(req, userId, actor)) {
      const sent = await this.sendSignInCode(req, userId);
      if (sent) {
        this.audit(req, "sign-in code sent", `new device after failed tries (${sent.sentTo})`, actor);
        return { status: 200, body: { needsCode: true, ticket: sent.ticket, sentTo: sent.sentTo } };
      }
      this.audit(req, "suspicious sign-in allowed", "no email or phone alerts set up to send a code", actor);
    }
    this.signIn(req, res, userId, "with password");
    return { status: 200, body: { ok: true } };
  }

  // ---------------- The front door ----------------

  /** Single-user password check. */
  private passwordOk(req: Request) {
    if (!this.password) return true;
    const c = readCookie(req, "fd_session") ?? "";
    const session = Boolean(c) && Boolean(this.site.prepare("SELECT 1 FROM owner_sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(sha(c)));
    if (this.twofa()) return session; // with two-step sign-in, only a real session counts
    return session || c === this.legacyOwnerCookie();
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
      paymentsTest: this.multiuser && billingEnabled() && stripeIsTest(),
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
    root.use(securityHeaders, hostGuard, sameSiteGuard);
    // Speed from real use: how long each screen's data takes for the people actually using it (see realSpeed.ts).
    root.use((req, res, next) => {
      if (req.method === "GET" && req.path.startsWith("/api/")) {
        const t = performance.now();
        res.on("finish", () => recordTiming(req.originalUrl, performance.now() - t, res.statusCode < 500, (d) => this.saveRealDay(d)));
      }
      next();
    });
    // Slow down password guessing and email bombing (per IP, on top of the per-account limits).
    const signInLimit = rateLimit(30, 15 * 60_000, "Too many sign-in attempts from here. Wait 15 minutes.");
    root.use(["/api/login", "/api/auth/login", "/api/auth/reset", "/api/passkeys/login", "/api/auth/not-me", "/api/passkeys/recover"], (req, res, next) => (req.method === "POST" ? signInLimit(req, res, next) : next()));
    root.use("/api/auth/signup", rateLimit(10, 60 * 60_000, "Too many sign-ups from here. Try again later."));
    root.use("/api/auth/forgot", rateLimit(10, 60 * 60_000, "Too many reset requests from here. Try again later."));

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
      const agent = String(req.headers["user-agent"] ?? "");
      const known = agent.match(/UptimeRobot|Better ?(Stack|Uptime)|Pingdom|StatusCake|Uptime[- ]?Kuma|Hetrix|Freshping|Cronitor|Checkly/i);
      if (known) this.lastMonitorHit = { at: new Date().toISOString(), agent: known[0] };
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
    // Second step of sign-in (both modes): the ticket from the password step + a 6-digit or recovery code.
    // The emailed / phoned code for a suspicious sign-in.
    root.post("/api/login/verify", json, (req, res) => {
      const b = z.object({ ticket: z.string().max(100), code: z.string().max(20) }).parse(req.body);
      const t = this.loginTickets.get(b.ticket);
      if (!t || t.exp < Date.now() || t.kind !== "code") return void res.status(401).json({ error: "That took too long. Sign in again." });
      if (++t.tries > 5) return void (this.loginTickets.delete(b.ticket), res.status(429).json({ error: "Too many wrong codes. Sign in again." }));
      const given = sha(b.code.replace(/\s/g, ""));
      if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(t.codeHash!))) {
        this.audit(req, "sign-in failed", "wrong sign-in code", t.userId ? this.accountEmail(t.userId) : "owner");
        return void res.status(401).json({ error: "That code isn't right." });
      }
      this.loginTickets.delete(b.ticket);
      this.signIn(req, res, t.userId, "with password + a sent code");
      res.json({ ok: true });
    });
    // Lost every passkey on a passkey-only account: a recovery code signs in once and turns passkey-only off.
    root.post("/api/passkeys/recover", json, async (req, res) => {
      const b = z.object({ email: z.string().max(200).optional(), code: z.string().min(6).max(40) }).parse(req.body);
      let userId: number | undefined;
      let actor = "owner";
      if (this.multiuser) {
        const u = this.accounts!.prepare("SELECT id, email FROM users WHERE email = ?").get((b.email ?? "").trim()) as { id: number; email: string } | undefined;
        if (!u) return void res.status(401).json({ error: "That recovery code isn't right." });
        userId = u.id;
        actor = u.email;
      } else if (!this.password) return void res.status(400).json({ error: "No sign-in needed here." });
      const po = this.passkeyOnly(userId);
      const left = po ? useRecoveryCode(po.recovery, b.code) : null;
      if (!left) {
        this.audit(req, "sign-in failed", "wrong passkey recovery code", actor);
        return void res.status(401).json({ error: "That recovery code isn't right." });
      }
      this.setPasskeyOnly(userId, null);
      this.audit(req, "passkey-only turned off", "signed in with a recovery code", actor);
      this.signIn(req, res, userId, "with a passkey recovery code");
      await this.tellOwner("🔐 A passkey recovery code was used", `${actor} signed in with a recovery code; passkey-only sign-in is now off for them.`, { email: false }).catch(() => {});
      if (userId && (mailConfigured() || process.env.SMTP_HOST === "test"))
        void sendMail(actor, "A FlipDesk recovery code was used", `Someone (hopefully you) signed in with one of your passkey recovery codes, so passkey-only sign-in is now off.\nAdd new passkeys in Settings and turn it back on. If this wasn't you, reset your password now.`).catch(() => {});
      res.json({ ok: true });
    });
    root.post("/api/login/2fa", json, (req, res) => {
      const b = z.object({ ticket: z.string().max(100), code: z.string().max(20) }).parse(req.body);
      const t = this.loginTickets.get(b.ticket);
      if (!t || t.exp < Date.now() || t.kind === "code") return void res.status(401).json({ error: "That took too long. Sign in again." });
      if (++t.tries > 5) return void (this.loginTickets.delete(b.ticket), res.status(429).json({ error: "Too many wrong codes. Sign in again." }));
      const how = this.checkSecondFactor(t.userId, b.code);
      if (!how) {
        this.audit(req, "sign-in failed", "wrong two-step code", t.userId ? this.accountEmail(t.userId) : "owner");
        return void res.status(401).json({ error: "That code isn't right. Check the time on your phone, or use a recovery code." });
      }
      this.loginTickets.delete(b.ticket);
      this.signIn(req, res, t.userId, how === "recovery" ? "with a recovery code" : "with two-step code");
      res.json({ ok: true, recoveryLeft: this.twofa(t.userId)?.recovery.length ?? 0 });
    });
    if (!this.multiuser)
      root.post("/api/login", json, async (req, res) => {
        if (!this.password) return void res.json({ ok: true });
        const given = String((req.body as { password?: string })?.password ?? "");
        const ok = given.length === this.password.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.password));
        if (!ok) {
          this.audit(req, "sign-in failed", "wrong password", "owner");
          return void res.status(401).json({ error: "Wrong password" });
        }
        const r = await this.afterPassword(req, res, undefined, "owner");
        res.status(r.status).json(r.body);
      });
    if (this.multiuser) {
      const Creds = z.object({ email: z.email().max(200), password: z.string().min(8, "Use at least 8 characters").max(200), invite: z.string().max(200).optional() });
      root.post("/api/auth/signup", json, (req, res) => {
        try {
          const b = Creds.parse(req.body);
          const u = this.signup(b.email.trim(), b.password, b.invite?.trim());
          this.get(`u${u.id}`); // create the shop
          this.audit(req, u.is_owner ? "owner account created" : "signed up", b.invite && !process.env.FLIPDESK_INVITE_CODE ? "with an invite link" : "", u.email);
          if (!u.is_owner && (mailConfigured() || process.env.SMTP_HOST === "test")) {
            const link = (p: string) => `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? ""}${p}`;
            void sendMail(
              u.email,
              "Welcome to FlipDesk: your first week",
              `Welcome! Here's a simple plan for your first week, one small step a day (FlipDesk ticks them off on its own):\n\n${FIRST_WEEK.map((d) => `Day ${d.day}: ${d.title}. ${d.how}`).join("\n")}\n\nStart here: ${link("/shoot")}\nStuck? Press ❓ Help in the app, or reply to this email.\n\nTurn these emails off in FlipDesk → Settings → Your account.`,
            ).catch(() => {});
          }
          res.setHeader("Set-Cookie", [cookie(req, "fd_user", this.newSession(u.id), 60 * 60 * 24 * 30), ...[this.noteDevice(req, u.id, "sign-up")].filter((x): x is string => Boolean(x))]);
          res.json({ ok: true, owner: Boolean(u.is_owner) });
        } catch (e) {
          const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Check your email and password" : (e as Error).message;
          res.status((e as { status?: number }).status ?? 400).json({ error: msg });
        }
      });
      root.post("/api/auth/login", json, async (req, res) => {
        try {
          const b = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
          let u: Account;
          try {
            u = this.login(b.email.trim(), b.password);
          } catch (e) {
            this.audit(req, "sign-in failed", (e as Error).message, b.email.trim().slice(0, 200));
            throw e;
          }
          const r = await this.afterPassword(req, res, u.id, u.email);
          res.status(r.status).json(r.body);
        } catch (e) {
          res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
        }
      });
      root.post("/api/auth/logout", (req, res) => {
        const t = readCookie(req, "fd_user");
        const u = this.userFor(req);
        if (u) this.audit(req, "signed out", "", u.email);
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
          this.audit(req, "password reset", "via reset link", u.email);
          // With two-step sign-in on, a reset link alone never signs anyone in.
          if (this.twofa(u.id) || this.passkeyOnly(u.id)) return void res.json({ ok: true, signIn: true });
          this.signIn(req, res, u.id, "after a password reset");
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
      const secrets = webhookSecrets();
      if (!this.accounts || !secrets.length) return void res.status(400).json({ error: "Billing webhook not configured" });
      // Live and test endpoints have different signing secrets: the one that matches tells us the mode.
      const match = secrets.find((x) => verifyWebhook(req.body as Buffer, req.headers["stripe-signature"] as string | undefined, x.secret));
      if (!match) return void res.status(400).json({ error: "Bad signature" });
      const ev = JSON.parse((req.body as Buffer).toString("utf8"));
      const r = applyStripeEvent(this.accounts, ev, (ev as { livemode?: boolean }).livemode === true ? "live" : (ev as { livemode?: boolean }).livemode === false ? "test" : match.mode);
      if (r && "canceling" in r) this.accounts.prepare("UPDATE users SET canceling = ? WHERE id = ?").run(r.canceling ? 1 : 0, r.userId);
      if (r && "cancellation" in r && r.cancellation) this.recordCancellation(r.userId, r.cancellation.reason, r.cancellation.comment, "stripe");
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

    // ---- Passkey sign-in (no password needed; counts as both steps) ----
    root.post("/api/passkeys/login/options", async (req, res) => {
      if (!this.multiuser && !this.password) return void res.status(400).json({ error: "No sign-in needed here." });
      res.json({ ...(await loginOptions(relyingParty(req))), available: hasPasskeys(this.site) });
    });
    root.post("/api/passkeys/login", express.json({ limit: "64kb" }), async (req, res) => {
      try {
        const b = z.object({ ticket: z.string().max(100), response: z.looseObject({ id: z.string().max(1500) }) }).parse(req.body);
        const r = await finishLogin(this.site, relyingParty(req), b.ticket, b.response as never);
        const userId = r.ownerKey === "owner" ? undefined : Number(r.ownerKey.slice(1));
        if (this.multiuser ? !userId || !this.accounts!.prepare("SELECT 1 FROM users WHERE id = ?").get(userId) : r.ownerKey !== "owner")
          return void res.status(401).json({ error: "This passkey isn't for this FlipDesk." });
        this.signIn(req, res, userId, "with a passkey");
        res.json({ ok: true });
      } catch (e) {
        this.audit(req, "sign-in failed", `passkey: ${(e as Error).message}`.slice(0, 200), "someone");
        res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
      }
    });
    // "This wasn't me" (from the new-device email/alert). A button on the page posts here; just opening the link does nothing.
    root.post("/api/auth/not-me", json, async (req, res) => {
      try {
        const t = z.object({ token: z.string().min(10).max(200) }).parse(req.body).token;
        const r = await this.notMe(req, t);
        res.setHeader("Set-Cookie", [cookie(req, "fd_user", "", 0), cookie(req, "fd_session", "", 0)]);
        res.json(r);
      } catch (e) {
        res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
      }
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

    // Owner-only area. Registered right after sign-in so it covers every /api/admin route, wherever it's defined.
    root.use("/api/admin", (req: Request & { fdUser?: Account | null }, res, next) => {
      if (!this.multiuser || !req.fdUser?.is_owner) return void res.status(403).json({ error: "Only the owner can do that." });
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
        this.audit(req, "password changed", "", u.email);
        res.json({ ok: true });
      } catch (e) {
        const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Check the password" : (e as Error).message;
        res.status((e as { status?: number }).status === 401 ? 400 : ((e as { status?: number }).status ?? 400)).json({ error: msg === "Wrong email or password." ? "Your current password isn't right." : msg });
      }
    });

    // ---- Two-step sign-in (your account; the owner in single-password mode) ----
    const who2fa = (req: R, res: Response): { userId?: number; label: string } | null => {
      if (this.multiuser) {
        if (req.fdUser) return { userId: req.fdUser.id, label: req.fdUser.email };
        res.status(401).json({ error: "login required" });
        return null;
      }
      if (req.fdShare) return void res.status(403).json({ error: "read-only" }), null;
      if (!this.password) return void res.status(400).json({ error: "Set FLIPDESK_PASSWORD first: two-step sign-in adds to a password." }), null;
      return { label: "owner" };
    };
    root.get("/api/2fa", (req: R, res) => {
      // No password yet (single mode): not an error, just not available. Settings shows how to turn it on.
      if (!this.multiuser && !req.fdShare && !this.password) return void res.json({ enabled: false, recoveryLeft: 0, unavailable: "Set FLIPDESK_PASSWORD first: two-step sign-in adds to a password." });
      const w = who2fa(req, res);
      if (!w) return;
      const t = this.twofa(w.userId);
      res.json({ enabled: Boolean(t), recoveryLeft: t?.recovery.length ?? 0 });
    });
    root.post("/api/2fa/setup", (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      if (this.twofa(w.userId)) return void res.status(400).json({ error: "Two-step sign-in is already on." });
      const secret = newSecret();
      this.pending2fa.set(this.keyFor(w.userId), { secret, exp: Date.now() + 15 * 60_000 });
      res.json({ secret, otpauth: otpauthUrl(secret, w.label) });
    });
    root.post("/api/2fa/enable", json, (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      const p = this.pending2fa.get(this.keyFor(w.userId));
      if (!p || p.exp < Date.now()) return void res.status(400).json({ error: "Start again: the setup expired." });
      const step = verifyTotp(p.secret, z.object({ code: z.string().max(20) }).parse(req.body).code);
      if (step === null) return void res.status(400).json({ error: "That code doesn't match. Check the code in your app and try again." });
      const rc = newRecoveryCodes();
      this.saveTwofa(w.userId, { secret: p.secret, recovery: rc.hashes, lastStep: step });
      this.pending2fa.delete(this.keyFor(w.userId));
      // Sign out other devices; keep this one signed in with a fresh session.
      if (w.userId) {
        this.accounts!.prepare("DELETE FROM sessions WHERE user_id = ?").run(w.userId);
        res.setHeader("Set-Cookie", cookie(req, "fd_user", this.newSession(w.userId), 60 * 60 * 24 * 30));
      } else {
        this.site.prepare("DELETE FROM owner_sessions").run();
        res.setHeader("Set-Cookie", cookie(req, "fd_session", this.newOwnerSession(), 60 * 60 * 24 * 30));
      }
      this.audit(req, "two-step sign-in turned on", "", w.label);
      res.json({ enabled: true, recoveryCodes: rc.codes });
    });
    root.post("/api/2fa/disable", json, (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      if (!this.checkSecondFactor(w.userId, z.object({ code: z.string().max(20) }).parse(req.body).code)) return void res.status(400).json({ error: "That code isn't right." });
      this.saveTwofa(w.userId, null);
      this.audit(req, "two-step sign-in turned off", "", w.label);
      res.json({ enabled: false });
    });
    root.post("/api/2fa/recovery-codes", json, (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      const t = this.twofa(w.userId);
      if (!t || !this.checkSecondFactor(w.userId, z.object({ code: z.string().max(20) }).parse(req.body).code)) return void res.status(400).json({ error: "That code isn't right." });
      const rc = newRecoveryCodes();
      this.saveTwofa(w.userId, { ...this.twofa(w.userId)!, recovery: rc.hashes });
      this.audit(req, "new recovery codes", "", w.label);
      res.json({ recoveryCodes: rc.codes });
    });

    // ---- Passkeys (manage) ----
    root.get("/api/passkeys", (req: R, res) => {
      if (!this.multiuser && !req.fdShare && !this.password) return void res.json({ passkeys: [], unavailable: "Set FLIPDESK_PASSWORD first: passkeys replace typing it." });
      const w = who2fa(req, res);
      if (!w) return;
      const po = this.passkeyOnly(w.userId);
      res.json({ passkeys: listPasskeys(this.site, this.keyFor(w.userId)), passkeyOnly: Boolean(po), recoveryLeft: po?.recovery.length ?? 0 });
    });
    root.post("/api/passkeys/only", json, (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      const on = z.object({ on: z.boolean() }).parse(req.body).on;
      if (!on) {
        this.setPasskeyOnly(w.userId, null);
        this.audit(req, "passkey-only turned off", "", w.label);
        return void res.json({ passkeyOnly: false });
      }
      if (listPasskeys(this.site, this.keyFor(w.userId)).length < 2)
        return void res.status(400).json({ error: "Add a second passkey first (e.g. your phone and your computer), so losing one device doesn't lock you out." });
      const rc = newRecoveryCodes();
      this.setPasskeyOnly(w.userId, rc.hashes);
      this.audit(req, "passkey-only turned on", "", w.label);
      res.json({ passkeyOnly: true, recoveryCodes: rc.codes });
    });
    root.post("/api/passkeys/register/options", async (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      res.json(await registrationOptions(this.site, relyingParty(req), this.keyFor(w.userId), w.label));
    });
    root.post("/api/passkeys/register", express.json({ limit: "64kb" }), async (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      try {
        const b = z.object({ response: z.looseObject({ id: z.string().max(1500) }), name: z.string().trim().max(60).optional() }).parse(req.body);
        const device = describeDevice(String(req.headers["user-agent"] ?? ""));
        const r = await finishRegistration(this.site, relyingParty(req), this.keyFor(w.userId), b.response as never, b.name || device, device);
        this.audit(req, "passkey added", b.name || device, w.label);
        res.json({ ...r, passkeys: listPasskeys(this.site, this.keyFor(w.userId)) });
      } catch (e) {
        res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
      }
    });
    root.patch("/api/passkeys/:id", json, (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      const name = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body).name;
      if (!renamePasskey(this.site, this.keyFor(w.userId), String(req.params.id), name)) return void res.status(404).json({ error: "Not found" });
      res.json({ passkeys: listPasskeys(this.site, this.keyFor(w.userId)) });
    });
    root.delete("/api/passkeys/:id", (req: R, res) => {
      const w = who2fa(req, res);
      if (!w) return;
      if (this.passkeyOnly(w.userId) && listPasskeys(this.site, this.keyFor(w.userId)).length <= 2)
        return void res.status(400).json({ error: "Passkey-only sign-in needs at least two passkeys. Add another first, or turn passkey-only off." });
      if (!removePasskey(this.site, this.keyFor(w.userId), String(req.params.id))) return void res.status(404).json({ error: "Not found" });
      this.audit(req, "passkey removed", "", w.label);
      res.json({ passkeys: listPasskeys(this.site, this.keyFor(w.userId)) });
    });

    // ---- Signed-in devices ----
    root.get("/api/devices", (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      if (this.multiuser && !req.fdUser) return void res.status(401).json({ error: "login required" });
      res.json({ devices: this.devicesFor(req.fdUser?.id, req), canSignOut: this.multiuser || Boolean(this.password) });
    });
    root.post("/api/devices/sign-out-everywhere", (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      if (this.multiuser && !req.fdUser) return void res.status(401).json({ error: "login required" });
      if (!this.multiuser && !this.password) return void res.status(400).json({ error: "No password is set, so there's nothing to sign out of." });
      const userId = req.fdUser?.id;
      this.signOutEverywhere(userId);
      this.audit(req, "signed out everywhere", "from Settings", userId ? req.fdUser!.email : "owner");
      this.signIn(req, res, userId, "kept this device signed in"); // this one stays in (and is remembered again)
      res.json({ ok: true, devices: this.devicesFor(userId, req) });
    });

    // ---- Send a problem report (with your OK): owner → GitHub issue; member → the owner's feedback inbox ----
    root.post("/api/problems/:id/send", json, async (req: R, res) => {
      if (req.fdShare) return void res.status(403).json({ error: "read-only" });
      const ws = this.current(req, req.fdUser ?? null)!;
      const id = Number(req.params.id);
      const report = getProblem(ws.db, id);
      if (!report) return void res.status(404).json({ error: "Not found" });
      const note = z.object({ note: z.string().trim().max(1000).default("") }).parse(req.body ?? {}).note;
      if (this.multiuser && !req.fdUser?.is_owner) {
        this.site.prepare("INSERT INTO feedback (user_id, email, page, message, context) VALUES (?, ?, '/queue', ?, ?)").run(req.fdUser!.id, req.fdUser!.email, `📋 Problem report: ${report.error}${note ? `\n${note}` : ""}`, JSON.stringify({ problemReport: report }));
        markSent(ws.db, id, "owner");
        this.audit(req, "problem report sent to owner", report.error);
        return void res.json({ sentTo: "owner" });
      }
      const issue = problemIssue(report, note);
      const url = await createIssue(issue.title, issue.body);
      markSent(ws.db, id, url);
      this.audit(req, "problem report sent", url);
      res.json({ sentTo: url });
    });
    root.post("/api/admin/feedback/:id/send-report", async (req: R, res) => {
      const f = this.site.prepare("SELECT context FROM feedback WHERE id = ?").get(Number(req.params.id)) as { context: string } | undefined;
      const ctx = f ? (JSON.parse(f.context) as { problemReport?: Parameters<typeof problemIssue>[0]; sentTo?: string }) : null;
      if (!ctx?.problemReport) return void res.status(404).json({ error: "No problem report on this feedback" });
      const issue = problemIssue(ctx.problemReport, "Forwarded from a member's report.");
      const url = await createIssue(issue.title, issue.body);
      this.site.prepare("UPDATE feedback SET context = ? WHERE id = ?").run(JSON.stringify({ ...ctx, sentTo: url }), Number(req.params.id));
      this.audit(req, "member's problem report sent", url);
      res.json({ sentTo: url });
    });

    // ---- Nightly self-check (owner) ----
    root.get("/api/selfcheck", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      res.json(this.siteGet<SelfCheck[]>("selfChecks", []));
    });
    root.get("/api/real-speed", async (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      res.json({ trend: await this.flushRealSpeed(), days: this.siteGet<RealDay[]>("realSpeed", []).length });
    });
    root.get("/api/selfcheck/trend", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      const h = this.siteGet<SelfCheck[]>("selfChecks", []);
      res.json({ trend: speedTrend(h), last: h[0] ?? null });
    });
    root.post("/api/selfcheck", async (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      this.audit(req, "self-check run");
      res.json(await this.selfCheckNow());
    });

    // ---- Version and going back (owner) ----
    root.get("/api/versions", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      res.json({ versions: listVersions(this.dataDir), current: currentImage(), previous: previousGood(this.dataDir), canSwitch: flyReady() });
    });
    root.post("/api/versions/rollback", json, async (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      const prev = previousGood(this.dataDir);
      const image = z.object({ image: z.string().max(300).optional() }).parse(req.body ?? {}).image ?? prev?.image;
      if (!image || !listVersions(this.dataDir).some((v) => v.image === image)) return void res.status(400).json({ error: "There's no earlier version to go back to yet." });
      try {
        const r = await switchImage(image);
        this.audit(req, "went back to an earlier version", image);
        res.json({ ...r, message: "Switching now. FlipDesk restarts on the earlier version in about a minute; reload then." });
      } catch (e) {
        res.status((e as { status?: number }).status ?? 502).json({ error: (e as Error).message });
      }
    });

    // ---- Activity log (owner) ----
    root.get("/api/audit", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Only the owner can see the activity log." });
      res.json(this.auditList({ q: String(req.query.q ?? ""), before: req.query.before ? Number(req.query.before) : undefined, limit: Number(req.query.limit) || 100 }));
    });

    // ---- Plan & billing (hosted) ----
    const base = (req: Request) => process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
    root.get("/api/billing", (req: R, res) => {
      const u = req.fdUser;
      if (!u) return void res.json({ enabled: false, status: this.multiuser ? "free" : "owner" });
      const offer = this.winbackOffer(u.id);
      res.json({
        ...billingSummary(this.billingRow(u.id)!),
        aiLimit: this.aiLimit(u.id),
        paidAiLimit: paidAiLimit(),
        trialDays: trialDays(),
        offer: offer ? { pct: offer.pct, endsAt: offer.endsAt } : null,
        askCancelReason: this.shouldAskCancelReason(u.id),
        cancelReasons: Object.entries(Workspaces.CANCEL_REASONS).map(([key, label]) => ({ key, label })),
      });
    });
    root.post("/api/billing/checkout", async (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      if (!billingEnabled()) return void res.status(400).json({ error: "Billing isn't turned on for this FlipDesk." });
      const offer = this.winbackOffer(u.id);
      res.json({ url: await checkoutUrl(this.billingRow(u.id)!, base(req), { coupon: offer?.coupon ?? undefined }) });
    });
    root.post("/api/billing/cancel-reason", json, (req: R, res) => {
      const u = needUser(req, res);
      if (!u) return;
      const b = z.object({ reason: z.enum(Object.keys(Workspaces.CANCEL_REASONS) as [string, ...string[]]), comment: z.string().trim().max(1000).default("") }).parse(req.body);
      this.recordCancellation(u.id, b.reason, b.comment, "app");
      res.json({ ok: true });
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
      this.audit(req, "data downloaded", ws.demo ? "sample shop" : "");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="flipdesk-${ws.demo ? "sample-" : ""}export-${day}.zip"`);
      await exportShop(ws.db, ws.uploadDir, res, ws.demo ? "Sample shop" : req.fdUser?.email ?? "My shop");
    });

    // ---- Pre-launch checklist (owner) ----
    root.get("/api/launch", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      res.json(this.launchChecks(req));
    });
    root.post("/api/launch/test-email", async (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      const to = this.ownerContact()?.email ?? z.object({ to: z.email() }).parse(req.body ?? {}).to;
      if (!mailConfigured() && process.env.SMTP_HOST !== "test") return void res.status(400).json({ error: "Email isn't set up (SMTP_* in .env)" });
      try {
        await sendMail(to, "FlipDesk test email ✅", "If you can read this, FlipDesk can send email (password resets, reminders, reports).");
        res.json({ ok: true, to });
      } catch (e) {
        res.status(502).json({ error: `Couldn't send: ${(e as Error).message}` });
      }
    });

    // ---- Alert settings (owner) ----
    root.get("/api/alert-settings", (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      res.json({ ...this.alertSettings(), quietNow: this.isQuiet() });
    });
    root.put("/api/alert-settings", json, (req: R, res) => {
      if (!owner(req)) return void res.status(403).json({ error: "Owner only" });
      const b = z.object({ quiet: z.boolean(), quietStart: z.number().int().min(0).max(23), quietEnd: z.number().int().min(0).max(23) }).parse(req.body);
      this.siteSet("alerts", b);
      this.audit(req, "alert settings", b.quiet ? `quiet ${b.quietStart}:00-${b.quietEnd}:00` : "quiet hours off");
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
    root.post("/api/backups", async (req, res) => {
      const r = await this.backupNow();
      this.audit(req, "backup made", `${path.basename(r.file)} (${Math.round(r.bytes / 1e6)} MB)`);
      res.json({ last: this.siteGet("lastBackup", null), files: listBackups(this.dataDir), offsite: s3Configured(), result: { bytes: r.bytes, uploaded: r.uploaded, error: r.error ?? null } });
    });
    root.get("/api/backups/:name/contents", (req, res) => void res.json({ parts: this.backupContents(String(req.params.name)), lastRestore: this.siteGet("lastRestore", null) }));
    root.post("/api/backups/:name/restore", json, async (req, res) => {
      const b = z.object({ parts: z.array(z.string().max(40)).min(1).max(1000), confirm: z.literal("RESTORE") }).parse(req.body);
      const r = await this.restore(String(req.params.name), b.parts);
      this.audit(req, "RESTORED from backup", `${req.params.name}: ${b.parts.join(", ")} (undo: ${r.undoBackup})`);
      res.json(r);
    });
    root.get("/api/backups/:name", (req, res, next) => (this.audit(req, "backup downloaded", String(req.params.name)), next()));
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
      const r = await runInWorkspace(ws!, () => askHelp(b.question, b.history as HelpTurn[], b.page, { owner: owner(req) }));
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
    root.get("/api/admin/accounts", (_req, res) => void res.json({ accounts: this.adminList(), defaultAiLimit: this.defaultAiLimit(), inviteCode: Boolean(process.env.FLIPDESK_INVITE_CODE) }));
    root.post("/api/admin/accounts/:id/reset-link", (req, res) => {
      const id = Number(req.params.id);
      if (!this.accounts!.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return void res.status(404).json({ error: "No such account" });
      const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
      this.audit(req, "reset link made", `for ${this.accountEmail(id)}`);
      res.json({ link: `${base}/reset?token=${this.createReset(id, 24)}`, hours: 24 });
    });
    // Support: someone lost every passkey and their recovery codes. Turn passkey-only off so a reset link works again.
    root.post("/api/admin/accounts/:id/passkey-only-off", (req, res) => {
      const id = Number(req.params.id);
      if (!this.accounts!.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return void res.status(404).json({ error: "No such account" });
      this.setPasskeyOnly(id, null);
      this.audit(req, "passkey-only turned off", `for ${this.accountEmail(id)} by the owner`);
      res.json({ ok: true });
    });
    root.put("/api/admin/accounts/:id", json, (req, res) => {
      const b = z.object({ aiLimit: z.number().int().min(0).max(100000).nullable().optional(), comp: z.boolean().optional() }).parse(req.body);
      const id = Number(req.params.id);
      if (b.aiLimit !== undefined) this.accounts!.prepare("UPDATE users SET ai_limit = ? WHERE id = ?").run(b.aiLimit, id);
      this.audit(req, "account changed", `${this.accountEmail(id)}: ${b.aiLimit !== undefined ? `AI limit ${b.aiLimit ?? "default"}` : ""}${b.comp !== undefined ? ` free plan ${b.comp ? "on" : "off"}` : ""}`.trim());
      // "Free forever" for friends and family (only replaces a plan that isn't a live Stripe subscription).
      if (b.comp === true) this.accounts!.prepare("UPDATE users SET plan = 'comp' WHERE id = ? AND (plan IS NULL OR plan NOT IN ('active','trialing','past_due'))").run(id);
      if (b.comp === false) this.accounts!.prepare("UPDATE users SET plan = NULL WHERE id = ? AND plan = 'comp'").run(id);
      res.json({ accounts: this.adminList() });
    });
    root.get("/api/admin/invites", (req, res) => void res.json({ invites: this.listInvites().map((i) => ({ ...i, link: `${base(req)}/join?invite=${i.token}` })) }));
    root.post("/api/admin/invites", json, (req: R, res) => {
      const note = z.object({ note: z.string().trim().max(80).default("") }).parse(req.body ?? {}).note;
      const token = this.createInvite(req.fdUser!.id, note);
      this.audit(req, "invite link made", note);
      res.json({ link: `${base(req)}/join?invite=${token}`, invites: this.listInvites().map((i) => ({ ...i, link: `${base(req)}/join?invite=${i.token}` })) });
    });
    root.delete("/api/admin/invites/:id", (req, res) => {
      this.accounts!.prepare("UPDATE invites SET revoked_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(Number(req.params.id));
      this.audit(req, "invite link turned off", `#${req.params.id}`);
      res.json({ invites: this.listInvites().map((i) => ({ ...i, link: `${base(req)}/join?invite=${i.token}` })) });
    });
    root.get("/api/admin/owner-report", (_req, res) => void res.json(this.ownerReport()));
    root.get("/api/admin/cancellations", (req, res) => void res.json(this.cancellationSummary(Math.min(365, Number(req.query.days) || 30))));
    root.get("/api/admin/stripe-mode", (_req, res) => void res.json(stripeModes()));
    root.put("/api/admin/stripe-mode", json, (req, res) => {
      const mode = z.object({ mode: z.enum(["test", "live"]) }).parse(req.body).mode;
      const m = stripeModes();
      if (!m[mode]) return void res.status(400).json({ error: mode === "live" ? "Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID (live) first." : "Set STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PRICE_ID first." });
      this.siteSet("stripeMode", mode);
      setStripeMode(mode);
      this.audit(req, "payments mode", mode.toUpperCase());
      res.json(stripeModes());
    });
    root.get("/api/admin/help-articles", (_req, res) => void res.json(this.helpArticles()));
    root.post("/api/admin/help-articles/draft", json, async (req, res) => {
      const b = z.object({ questionId: z.number().int().optional(), question: z.string().max(500).optional() }).parse(req.body);
      const q = b.questionId ? (this.site.prepare("SELECT question, page FROM help_questions WHERE id = ?").get(b.questionId) as { question: string; page: string } | undefined) : b.question ? { question: b.question, page: "" } : undefined;
      if (!q) return void res.status(404).json({ error: "Question not found" });
      const o = this.ownerContact();
      res.json({ ...(await (o ? runInWorkspace(o.ws, () => draftArticle(q.question, q.page)) : draftArticle(q.question, q.page))), question: q.question });
    });
    const Article = z.object({ title: z.string().trim().min(5, "Give it a title").max(160), body: z.string().trim().min(10, "Write the answer").max(5000), questionId: z.number().int().optional(), question: z.string().max(500).optional() });
    root.post("/api/admin/help-articles", json, (req, res) => {
      const b = Article.parse(req.body);
      const id = Number(this.site.prepare("INSERT INTO help_articles (title, body, from_question) VALUES (?, ?, ?)").run(b.title, b.body, b.question ?? null).lastInsertRowid);
      // Mark the question (and identical ones) as answered by this article.
      const q = b.questionId ? (this.site.prepare("SELECT question FROM help_questions WHERE id = ?").get(b.questionId) as { question: string } | undefined)?.question : b.question;
      if (q) this.site.prepare("UPDATE help_questions SET article_id = ? WHERE lower(question) = lower(?)").run(id, q);
      res.json(this.helpArticles());
    });
    root.put("/api/admin/help-articles/:id", json, (req, res) => {
      const b = Article.parse(req.body);
      this.site.prepare("UPDATE help_articles SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?").run(b.title, b.body, Number(req.params.id));
      res.json(this.helpArticles());
    });
    root.delete("/api/admin/help-articles/:id", (req, res) => {
      this.site.prepare("UPDATE help_articles SET archived_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
      res.json(this.helpArticles());
    });
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
      this.audit(req, "announcement posted", b.title);
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
      const email = this.accountEmail(Number(req.params.id));
      this.deleteAccount(Number(req.params.id));
      this.audit(req, "account deleted", email);
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
      this.audit(req, "help videos changed", `${Object.keys(clean).length} set`);
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
      this.audit(req, "sample shop shared");
      res.json({ share: { path: `/s/${s.token}`, views: s.views } });
    });
    root.delete("/api/workspace/share", (req: R, res) => {
      this.revokeShare(this.demoKey(req.fdUser?.id));
      this.audit(req, "share link turned off");
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

