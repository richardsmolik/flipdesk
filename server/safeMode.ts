/**
 * Safe mode: FlipDesk couldn't open its data with this version (usually an update that didn't pass its check
 * on a copy, so the data was left untouched). Instead of crashing in a loop, it:
 *  1. goes back to the last version that worked, by itself, when it can (on Fly.io with FLY_API_TOKEN), and
 *  2. meanwhile answers every page with a plain explanation (and /healthz with 503 so monitors notice).
 */
import express from "express";
import { markFailed, previousGood, flyReady, switchImage } from "./services/versions.js";
import { mailConfigured, sendMail } from "./services/mailer.js";

export async function safeMode(dataDir: string, err: Error) {
  markFailed(dataDir, err.message);
  const prev = previousGood(dataDir);
  let action = "";
  if (prev?.image && flyReady() && process.env.FLIPDESK_AUTO_ROLLBACK !== "0") {
    try {
      await switchImage(prev.image);
      action = `Going back to the last version that worked (${prev.version}) by itself. It's back in about a minute.`;
    } catch (e) {
      action = `Tried to go back to ${prev.version} by itself but couldn't: ${(e as Error).message}`;
    }
  } else {
    action = prev ? `Go back to ${prev.version}: fly deploy --image ${prev.image ?? "<previous image from fly releases>"}` : "Go back to the previous version (fly releases, then fly deploy --image <previous image>).";
  }
  const owner = process.env.FLIPDESK_OWNER_EMAIL;
  if (owner && mailConfigured()) await sendMail(owner, "🔴 FlipDesk update stopped to protect your data", `${err.message}\n\n${action}`).catch(() => false);
  console.error(`[safe mode] ${err.message}\n[safe mode] ${action}`);
  const app = express();
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlipDesk: back in a minute</title>
<body style="font-family:system-ui,sans-serif;background:#0b0b0d;color:#e4e4e7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<div style="max-width:520px;background:#18181b;border:1px solid #27272a;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">📦 FlipDesk is back in a minute</h1>
<p>An update didn't pass its safety check, so <b>your data wasn't changed</b>.</p>
<p style="color:#a1a1aa;font-size:14px">${action.replace(/</g, "&lt;")}</p></div>`;
  app.get("/healthz", (_req, res) => void res.status(503).json({ ok: false, safeMode: true }));
  app.use("/api", (_req, res) => void res.status(503).json({ error: "FlipDesk is in safe mode after an update that didn't pass its check. Your data wasn't changed; it's back in a minute." }));
  app.use((_req, res) => void res.status(503).type("html").send(page));
  return { app, action };
}
