import express from "express";
import fs from "node:fs";
import path from "node:path";
import { extensionToken } from "./app.js";
import { runInWorkspace } from "./context.js";
import { Workspaces } from "./workspaces.js";
import { hostGuard, securityHeaders } from "./security.js";
import compression from "compression";
import { processApiJobs } from "./services/jobs.js";
import { pollEbaySales } from "./services/sync.js";
import { applyAutoPriceDrops } from "./services/ebayTools.js";
import { pollImap } from "./services/email.js";
import { sendDigest } from "./services/digest.js";
import { syncEbayLabelCosts } from "./services/shipping.js";
import { syncEbayTraffic } from "./services/traffic.js";
import { ebayCheckIfDue } from "./services/ebaySmoke.js";

// Minimal .env loader (no dependency).
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Your shop + the sample shop (or, with FLIPDESK_MULTIUSER=1, one shop per account). See workspaces.ts.
const shops = new Workspaces();
const app = express();
app.set("trust proxy", 1); // behind Fly/Cloudflare/Render HTTPS proxies
app.disable("x-powered-by");
app.use(securityHeaders, hostGuard); // also for the app's own files (see security.ts)
app.use(compression()); // inventory lists are large JSON; gzip makes them ~8x smaller on the wire

if (process.env.NODE_ENV === "production" && fs.existsSync("dist")) {
  // The service worker must never be cached, or app updates would get stuck.
  app.get("/sw.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve("dist/sw.js"));
  });
  app.use(express.static("dist"));
  app.get(/^\/(?!api|uploads|healthz).*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
}
app.use(shops.handler());

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1"; // local-only by default
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !process.env.FLIPDESK_PASSWORD && !shops.multiuser) {
  console.error(`Refusing to listen on ${host} without FLIPDESK_PASSWORD - anyone on your network could see your business data.`);
  process.exit(1);
}
app.listen(port, host, () => {
  console.log(`FlipDesk API on http://${host}:${port}`);
  if (shops.multiuser) console.log(`Accounts mode: ${shops.signupsOpen() ? "sign-ups open" : "sign-ups closed (set FLIPDESK_INVITE_CODE)"}`);
  else {
    const main = shops.get("main")!;
    console.log(`Extension token: ${runInWorkspace(main, () => extensionToken(main.db))}`);
  }
});

// ---------------- Background scheduler ----------------
// Each task runs once per shop, inside that shop. Sample shops only process their sync queue.
const every = (ms: number, name: string, fn: (db: import("./db.js").Db, ws: import("./workspaces.js").Workspace) => Promise<unknown> | unknown, includeDemo = false) => {
  const run = () => shops.forEach(name, (db, ws) => fn(db, ws), { includeDemo });
  setInterval(run, ms).unref();
  setTimeout(run, 2000).unref();
};
every(30_000, "jobs", (db) => processApiJobs(db), true);
every(5 * 60_000, "ebay-sales", (db) => pollEbaySales(db)); // sold on eBay -> delist everywhere else
every(60 * 60_000, "auto-drop", (db) => applyAutoPriceDrops(db));
every(2 * 60_000, "email", (db) => pollImap(db)); // sale emails from every marketplace
every(15 * 60_000, "weekly", (db) => sendDigest(db)); // Monday-morning summary (once per week)
every(30 * 60_000, "ebay-labels", (db) => syncEbayLabelCosts(db)); // exact eBay label costs -> profit
every(12 * 60 * 60_000, "ebay-traffic", (db) => syncEbayTraffic(db)); // impressions/views -> "why isn't it selling"
every(6 * 60 * 60_000, "ebay-weekly", (db, ws) => ebayCheckIfDue(db, ws.uploadDir)); // weekly eBay check: catch eBay changes before a listing fails

// Nightly backup of every shop (data/backups, plus cloud storage when BACKUP_S3_* is set).
const backup = () =>
  shops
    .backupIfDue()
    .then((r) => r && console.log(`[backup] ${r.file} (${Math.round(r.bytes / 1e6)} MB)${r.uploaded ? " uploaded" : ""}${r.error ? ` - ${r.error}` : ""}`))
    .then(() => shops.checkBackupIfDue()) // monthly restore drill
    .then((c) => c && console.log(`[backup check] ${c.name}: ${c.ok ? "restores fine" : c.problems.join("; ")}`))
    .catch((e) => console.error("[backup]", (e as Error).message));
setInterval(backup, 60 * 60_000).unref();
setTimeout(backup, 5 * 60_000).unref();

// Watch for outages (AI, eBay, email, backups): tell the owner, post/remove a heads-up for everyone.
const guard = (name: string, fn: () => Promise<unknown>) => () => void fn().catch((e) => console.error(`[${name}]`, (e as Error).message));
setInterval(guard("incidents", () => shops.checkIncidents()), 2 * 60_000).unref();
// Hosted: owner's weekly report (your weekly-summary day/hour) and friendly reminder emails.
setInterval(guard("owner-report", () => shops.ownerReportIfDue()), 15 * 60_000).unref();
setInterval(guard("nudges", () => shops.sendNudges()), 60 * 60_000).unref();
// Nightly self-check: speed of the main screens, database health, disk space (alerts the owner on problems).
setInterval(guard("self-check", () => shops.selfCheckIfDue()), 60 * 60_000).unref();
setTimeout(guard("self-check", () => shops.selfCheckIfDue()), 10 * 60_000).unref();
