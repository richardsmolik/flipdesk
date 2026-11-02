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
import { openDb, setSetting, logActivity, type Db } from "./db.js";
import { createApp } from "./app.js";
import { runInWorkspace, setAiGate, type WorkspaceContext } from "./context.js";
import { seedDemo } from "./demo.js";
import { accountDeletionChallenge } from "./marketplaces/ebay.js";
import { goalProgress } from "./services/goals.js";
import { mailConfigured, sendMail } from "./services/mailer.js";

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
    if (this.multiuser) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const a = new DatabaseSync(path.join(this.dataDir, "accounts.db"));
      a.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL,
          is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS login_attempts (email TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT);
        CREATE TABLE IF NOT EXISTS ai_usage (user_id INTEGER NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));`);
      for (const col of ["ai_limit INTEGER", "leaderboard_name TEXT"]) {
        try {
          a.exec(`ALTER TABLE users ADD COLUMN ${col}`);
        } catch {
          /* already there */
        }
      }
      this.accounts = a as unknown as Db;
      setAiGate((ws, kind) => this.chargeAi(ws, kind));
    } else setAiGate(null);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const site = new DatabaseSync(path.join(this.dataDir, "site.db"));
    site.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, ws_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), views INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.site = site as unknown as Db;
  }

  // ---------------- AI cap (hosted) ----------------

  /** Daily AI requests allowed for an account (owner: unlimited). FLIPDESK_AI_DAILY_LIMIT, default 40. */
  aiLimit(userId: number): number | null {
    const u = this.accounts!.prepare("SELECT is_owner, ai_limit FROM users WHERE id = ?").get(userId) as { is_owner: number; ai_limit: number | null } | undefined;
    if (!u || u.is_owner) return null;
    if (u.ai_limit !== null && u.ai_limit !== undefined) return u.ai_limit;
    return this.defaultAiLimit();
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
    if (limit === null) return;
    if (this.aiUsedToday(ws.userId) >= limit)
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
    return n === 0 || Boolean(process.env.FLIPDESK_INVITE_CODE);
  }

  signup(email: string, password: string, invite?: string): Account {
    const a = this.accounts!;
    const n = (a.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    if (n > 0) {
      const code = process.env.FLIPDESK_INVITE_CODE;
      if (!code) throw Object.assign(new Error("Sign-ups are closed. Ask the owner for an invite."), { status: 403 });
      const ok = (invite ?? "").length === code.length && crypto.timingSafeEqual(Buffer.from(invite ?? ""), Buffer.from(code));
      if (!ok) throw Object.assign(new Error("That invite code isn't right."), { status: 403 });
    }
    if (a.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw Object.assign(new Error("There's already an account with that email. Sign in instead."), { status: 409 });
    const { salt, hash } = hashPassword(password);
    const id = Number(a.prepare("INSERT INTO users (email, pass_hash, salt, is_owner, last_login_at) VALUES (?, ?, ?, ?, datetime('now'))").run(email, hash, salt, n === 0 ? 1 : 0).lastInsertRowid);
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
    const users = this.accounts!.prepare("SELECT id, email, is_owner, created_at, last_login_at, ai_limit, leaderboard_name FROM users ORDER BY id").all() as unknown as (Account & {
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
        canEditSite: owner(req),
      });
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
      const b = z.object({ aiLimit: z.number().int().min(0).max(100000).nullable() }).parse(req.body);
      this.accounts!.prepare("UPDATE users SET ai_limit = ? WHERE id = ?").run(b.aiLimit, Number(req.params.id));
      res.json({ accounts: this.adminList() });
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
      } catch (e) {
        console.error(`[${name}:${ws.key}]`, (e as Error).message);
      }
    }
  }
}

