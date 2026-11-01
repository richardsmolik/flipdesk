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
import { runInWorkspace, type WorkspaceContext } from "./context.js";
import { seedDemo } from "./demo.js";
import { accountDeletionChallenge } from "./marketplaces/ebay.js";

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
        CREATE TABLE IF NOT EXISTS login_attempts (email TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));`);
      this.accounts = a as unknown as Db;
    }
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
      const ctx = { key, owner: false, demo: true, urlPrefix: `/uploads/${key}/`, tokenPrefix: `${key}.` };
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
    const id = Number(a.prepare("INSERT INTO users (email, pass_hash, salt, is_owner) VALUES (?, ?, ?, ?)").run(email, hash, salt, n === 0 ? 1 : 0).lastInsertRowid);
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
    const ws = this.current(req, user);
    return {
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
      // The single-password login isn't used when hosted with accounts.
      root.post("/api/login", (_req, res) => void res.status(400).json({ error: "Sign in with your email", auth: "accounts" }));
    }

    // Everything else needs a signed-in browser.
    root.use("/api", (req, res, next) => {
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
        if (action === "delete_demo") this.deleteDemo(user?.id);
        res.setHeader("Set-Cookie", cookie(req, "fd_ws", "", 0));
      }
      res.json({ ...this.describe(req, user), current: action === "enter_demo" || action === "reset_demo" ? "demo" : "real" });
    });

    // ---- Hand the request to the right shop ----
    root.use("/api", (req, res, next) => {
      const ws = this.current(req, (req as Request & { fdUser?: Account | null }).fdUser ?? null);
      if (!ws) return void res.status(404).json({ error: "Shop not found" });
      req.url = req.originalUrl;
      ws.app(req, res, next);
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

