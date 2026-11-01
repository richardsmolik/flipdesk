import express from "express";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db.js";
import { createApp, extensionToken } from "./app.js";
import { processApiJobs } from "./services/jobs.js";
import { pollEbaySales } from "./services/sync.js";
import { applyAutoPriceDrops } from "./services/ebayTools.js";
import { pollImap } from "./services/email.js";
import { sendDigest } from "./services/digest.js";
import { syncEbayLabelCosts } from "./services/shipping.js";
import { syncEbayTraffic } from "./services/traffic.js";

// Minimal .env loader (no dependency).
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const db = openDb();
const app = createApp(db, { uploadDir: process.env.FLIPDESK_UPLOADS });
app.set("trust proxy", 1); // behind Fly/Cloudflare/Render HTTPS proxies

if (process.env.NODE_ENV === "production" && fs.existsSync("dist")) {
  // The service worker must never be cached, or app updates would get stuck.
  app.get("/sw.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve("dist/sw.js"));
  });
  app.use(express.static("dist"));
  app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.resolve("dist/index.html")));
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1"; // local-only by default
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !process.env.FLIPDESK_PASSWORD) {
  console.error(`Refusing to listen on ${host} without FLIPDESK_PASSWORD - anyone on your network could see your business data.`);
  process.exit(1);
}
app.listen(port, host, () => {
  console.log(`FlipDesk API on http://${host}:${port}`);
  console.log(`Extension token: ${extensionToken(db)}`);
});

// ---------------- Background scheduler ----------------
const every = (ms: number, name: string, fn: () => Promise<unknown> | unknown) => {
  const run = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, (e as Error).message);
    }
  };
  setInterval(run, ms).unref();
  setTimeout(run, 2000).unref();
};
every(30_000, "jobs", () => processApiJobs(db));
every(5 * 60_000, "ebay-sales", () => pollEbaySales(db)); // sold on eBay -> delist everywhere else
every(60 * 60_000, "auto-drop", () => applyAutoPriceDrops(db));
every(2 * 60_000, "email", () => pollImap(db)); // sale emails from every marketplace
every(15 * 60_000, "weekly", () => sendDigest(db)); // Monday-morning summary (once per week)
every(30 * 60_000, "ebay-labels", () => syncEbayLabelCosts(db)); // exact eBay label costs -> profit
every(12 * 60 * 60_000, "ebay-traffic", () => syncEbayTraffic(db)); // impressions/views -> "why isn't it selling"
