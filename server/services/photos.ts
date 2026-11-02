/**
 * Photo editor backend.
 *  - Manual tools (local, free, via sharp): rotate, flip, straighten, crop, brightness, contrast,
 *    saturation, warmth, sharpen, auto-enhance, square on white.
 *  - AI auto-enhance: Claude looks at the photo and decides the fixes (rotation, straighten, crop,
 *    exposure, color, background removal); sharp applies them.
 *  - AI retouch (paint a mask): remove objects, fix wrinkles - Clipdrop when CLIPDROP_API_KEY is set,
 *    otherwise a basic local version (blur-fill / smoothing).
 *  - Background removal: Photoroom (PHOTOROOM_API_KEY), remove.bg (REMOVEBG_API_KEY) or Clipdrop.
 * The first edit keeps the original file so "Revert" always works.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import sharp from "sharp";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { aiIsLive, MODEL } from "./ai.js";
import { useAi } from "../context.js";
import { trackAnthropic } from "../health.js";

export type EditOp =
  | { type: "rotate"; deg: number } // any angle; 90/180/270 for orientation, small values to straighten
  | { type: "flip"; axis: "h" | "v" }
  | { type: "crop"; x: number; y: number; w: number; h: number } // fractions 0..1 of current image
  | { type: "adjust"; brightness?: number; contrast?: number; saturation?: number; warmth?: number; sharpen?: boolean }
  | { type: "auto" }
  | { type: "square"; size?: number }
  | { type: "removeBackground" };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface PhotoRow {
  id: number;
  item_id: number;
  path: string;
  original_path: string | null;
}

function getPhoto(db: Db, id: number) {
  const p = db.prepare("SELECT id, item_id, path, original_path FROM photos WHERE id = ?").get(id) as PhotoRow | undefined;
  if (!p) throw new Error("Photo not found");
  if (p.path.startsWith("http")) throw new Error("This photo is hosted elsewhere and can't be edited here.");
  if (!/\.(jpe?g|png|webp)$/i.test(p.path)) throw new Error("Only JPG, PNG and WebP photos can be edited.");
  return p;
}

export function capabilities() {
  return {
    ai: aiIsLive(),
    backgroundRemoval: Boolean(process.env.PHOTOROOM_API_KEY || process.env.REMOVEBG_API_KEY || process.env.CLIPDROP_API_KEY),
    aiRetouch: Boolean(process.env.CLIPDROP_API_KEY),
  };
}

// ---------------- Pixel operations ----------------

async function applyOp(buf: Buffer, op: EditOp): Promise<Buffer> {
  const img = sharp(buf, { failOn: "none" });
  switch (op.type) {
    case "rotate":
      return img.rotate(op.deg, { background: "#ffffff" }).toBuffer();
    case "flip":
      return (op.axis === "h" ? img.flop() : img.flip()).toBuffer();
    case "crop": {
      const m = await sharp(buf).metadata();
      const W = m.width ?? 1;
      const H = m.height ?? 1;
      const left = Math.round(clamp(op.x, 0, 0.95) * W);
      const top = Math.round(clamp(op.y, 0, 0.95) * H);
      const width = Math.max(16, Math.min(W - left, Math.round(clamp(op.w, 0.05, 1) * W)));
      const height = Math.max(16, Math.min(H - top, Math.round(clamp(op.h, 0.05, 1) * H)));
      return img.extract({ left, top, width, height }).toBuffer();
    }
    case "adjust": {
      let p = img;
      const b = clamp(op.brightness ?? 1, 0.4, 1.8);
      const s = clamp(op.saturation ?? 1, 0, 2);
      if (b !== 1 || s !== 1) p = p.modulate({ brightness: b, saturation: s });
      const c = clamp(op.contrast ?? 1, 0.5, 1.8);
      const w = clamp(op.warmth ?? 0, -1, 1);
      if (c !== 1 || w !== 0) {
        // contrast around mid-gray, warmth = small red/blue channel shift
        const a = [c * (1 + 0.08 * w), c, c * (1 - 0.08 * w)];
        const off = 128 * (1 - c);
        p = p.linear(a, [off, off, off]);
      }
      if (op.sharpen) p = p.sharpen({ sigma: 1 });
      return p.toBuffer();
    }
    case "auto":
      // Stretch levels (fixes dull/dim phone shots), a touch of color and crispness.
      return img.normalise({ lower: 1, upper: 99 }).modulate({ saturation: 1.06 }).sharpen({ sigma: 0.8 }).toBuffer();
    case "square": {
      const size = clamp(op.size ?? 1600, 500, 3000);
      return img.flatten({ background: "#ffffff" }).resize(size, size, { fit: "contain", background: "#ffffff" }).toBuffer();
    }
    case "removeBackground":
      return removeBackground(buf);
  }
}

async function removeBackground(buf: Buffer): Promise<Buffer> {
  const jpg = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
  const form = () => {
    const f = new FormData();
    f.append("image_file", new Blob([jpg], { type: "image/jpeg" }), "photo.jpg");
    return f;
  };
  let out: Buffer | null = null;
  if (process.env.PHOTOROOM_API_KEY) {
    const r = await fetch("https://sdk.photoroom.com/v1/segment", { method: "POST", headers: { "x-api-key": process.env.PHOTOROOM_API_KEY }, body: form() });
    if (!r.ok) throw new Error(`Photoroom: ${r.status} ${(await r.text()).slice(0, 200)}`);
    out = Buffer.from(await r.arrayBuffer());
  } else if (process.env.REMOVEBG_API_KEY) {
    const f = form();
    f.append("size", "auto");
    const r = await fetch("https://api.remove.bg/v1.0/removebg", { method: "POST", headers: { "X-Api-Key": process.env.REMOVEBG_API_KEY }, body: f });
    if (!r.ok) throw new Error(`remove.bg: ${r.status} ${(await r.text()).slice(0, 200)}`);
    out = Buffer.from(await r.arrayBuffer());
  } else if (process.env.CLIPDROP_API_KEY) {
    const r = await fetch("https://clipdrop-api.co/remove-background/v1", { method: "POST", headers: { "x-api-key": process.env.CLIPDROP_API_KEY }, body: form() });
    if (!r.ok) throw new Error(`Clipdrop: ${r.status} ${(await r.text()).slice(0, 200)}`);
    out = Buffer.from(await r.arrayBuffer());
  } else {
    throw new Error("Background removal needs a PHOTOROOM_API_KEY, REMOVEBG_API_KEY or CLIPDROP_API_KEY in .env.");
  }
  // Cut-out on pure white, the standard marketplace look.
  return sharp(out).flatten({ background: "#ffffff" }).toBuffer();
}

// ---------------- Retouch with a painted mask ----------------

/** mask: PNG where painted (white/opaque) pixels = area to fix. Resized to the photo. */
async function retouch(buf: Buffer, mask: Buffer, tool: "removeObject" | "fixWrinkles"): Promise<{ buf: Buffer; engine: string }> {
  const meta = await sharp(buf).metadata();
  const W = meta.width!;
  const H = meta.height!;
  // Painted strokes arrive as opaque pixels on a transparent canvas -> white-on-black mask, same size as the photo.
  const maskPng = await sharp(mask).resize(W, H, { fit: "fill" }).ensureAlpha().extractChannel(3).threshold(10).png().toBuffer();

  if (process.env.CLIPDROP_API_KEY) {
    const f = new FormData();
    f.append("image_file", new Blob([await sharp(buf).jpeg({ quality: 92 }).toBuffer()], { type: "image/jpeg" }), "image.jpg");
    f.append("mask_file", new Blob([maskPng], { type: "image/png" }), "mask.png");
    let url = "https://clipdrop-api.co/cleanup/v1";
    if (tool === "fixWrinkles") {
      url = "https://clipdrop-api.co/text-inpainting/v1";
      f.append("text_prompt", "smooth pressed wrinkle-free fabric, same color, same texture, same lighting");
    }
    const r = await fetch(url, { method: "POST", headers: { "x-api-key": process.env.CLIPDROP_API_KEY }, body: f });
    if (!r.ok) throw new Error(`Clipdrop: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { buf: Buffer.from(await r.arrayBuffer()), engine: "Clipdrop AI" };
  }

  // Basic local fallback.
  const maskRaw = await sharp(maskPng).extractChannel(0).raw().toBuffer();
  const rgb = await sharp(buf).removeAlpha().raw().toBuffer();
  let filled: Buffer;
  if (tool === "removeObject") {
    // "Normalized convolution": blur the photo with the painted pixels zeroed out, divide by the blurred
    // weight -> each painted pixel becomes a smooth blend of its surroundings (object color excluded).
    const area = maskRaw.reduce((a, v) => a + (v > 127 ? 1 : 0), 0);
    const sigma = Math.max(6, Math.min(80, Math.sqrt(area) / 2));
    const pre = Buffer.alloc(rgb.length);
    const wt = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) {
      const keep = maskRaw[i] > 127 ? 0 : 1;
      wt[i] = keep * 255;
      pre[i * 3] = rgb[i * 3] * keep;
      pre[i * 3 + 1] = rgb[i * 3 + 1] * keep;
      pre[i * 3 + 2] = rgb[i * 3 + 2] * keep;
    }
    const bc = await sharp(pre, { raw: { width: W, height: H, channels: 3 } }).blur(sigma).raw().toBuffer();
    const bw = await sharp(wt, { raw: { width: W, height: H, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
    filled = Buffer.alloc(rgb.length);
    for (let i = 0; i < W * H; i++) {
      const w = bw[i] / 255;
      for (let c = 0; c < 3; c++) filled[i * 3 + c] = w > 0.002 ? Math.min(255, Math.round(bc[i * 3 + c] / w)) : rgb[i * 3 + c];
    }
  } else {
    filled = await sharp(buf).removeAlpha().median(7).blur(1.2).raw().toBuffer(); // softens creases, keeps color
  }
  // (sharp turns 1-band images into sRGB on blur; extractChannel keeps it single-band)
  const feather = await sharp(maskRaw, { raw: { width: W, height: H, channels: 1 } }).blur(3).extractChannel(0).raw().toBuffer();
  const outRaw = Buffer.alloc(rgb.length);
  for (let i = 0; i < W * H; i++) {
    const a = feather[i] / 255;
    for (let c = 0; c < 3; c++) outRaw[i * 3 + c] = Math.round(filled[i * 3 + c] * a + rgb[i * 3 + c] * (1 - a));
  }
  const outBuf = await sharp(outRaw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return { buf: outBuf, engine: "basic (add CLIPDROP_API_KEY for AI)" };
}

// ---------------- Save / revert ----------------

function saveVersion(db: Db, p: PhotoRow, buf: Buffer, uploadDir: string) {
  const file = path.join(uploadDir, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-ed.jpg`);
  return sharp(buf)
    .flatten({ background: "#ffffff" })
    .resize(2400, 2400, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(file)
    .then(() => {
      // Keep the very first version as the original; delete intermediate edits.
      if (!p.original_path) db.prepare("UPDATE photos SET original_path = ? WHERE id = ?").run(p.path, p.id);
      else if (p.path !== p.original_path) fs.rmSync(p.path, { force: true });
      db.prepare("UPDATE photos SET path = ?, ebay_url = NULL, ebay_url_expires = NULL WHERE id = ?").run(file, p.id);
      return file;
    });
}

export async function editPhoto(db: Db, id: number, ops: EditOp[], uploadDir: string) {
  const p = getPhoto(db, id);
  let buf: Buffer = await sharp(fs.readFileSync(p.path)).rotate().toBuffer(); // honor camera EXIF orientation
  for (const op of ops) buf = await applyOp(buf, op);
  await saveVersion(db, p, buf, uploadDir);
  return { ok: true };
}

export async function retouchPhoto(db: Db, id: number, tool: "removeObject" | "fixWrinkles", mask: Buffer, uploadDir: string) {
  const p = getPhoto(db, id);
  const src = await sharp(fs.readFileSync(p.path)).rotate().toBuffer();
  const r = await retouch(src, mask, tool);
  await saveVersion(db, p, r.buf, uploadDir);
  return { ok: true, engine: r.engine };
}

export function revertPhoto(db: Db, id: number) {
  const p = db.prepare("SELECT id, path, original_path FROM photos WHERE id = ?").get(id) as PhotoRow | undefined;
  if (!p?.original_path) throw new Error("Nothing to revert - this is the original.");
  if (p.path !== p.original_path) fs.rmSync(p.path, { force: true });
  db.prepare("UPDATE photos SET path = original_path, original_path = NULL, ebay_url = NULL, ebay_url_expires = NULL WHERE id = ?").run(id);
  return { ok: true };
}

// ---------------- AI auto-enhance (Claude decides, sharp applies) ----------------

export const PhotoAdvice = z.object({
  rotate: z.enum(["0", "90", "180", "270"]).describe("Clockwise rotation so the item is upright"),
  straighten_degrees: z.number().describe("Small tilt correction in degrees (-10..10), 0 if level"),
  crop: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullable()
    .describe("Crop box as fractions of the (rotated) image to frame the item with a little margin; null if framing is fine"),
  brightness: z.number().describe("Multiplier 0.8-1.4 (1 = unchanged)"),
  contrast: z.number().describe("Multiplier 0.85-1.3"),
  saturation: z.number().describe("Multiplier 0.8-1.3"),
  warmth: z.number().describe("-1 cooler .. 1 warmer, to correct color casts (0 = none)"),
  remove_background: z.boolean().describe("True if the background is cluttered/distracting and a white background would sell better"),
  issues: z.array(z.string()).describe("Short list of problems seen (e.g. 'underexposed', 'tilted', 'cluttered background', 'wrinkled')"),
  tips: z.array(z.string()).describe("Retake tips the seller can act on next time"),
});
export type PhotoAdvice = z.infer<typeof PhotoAdvice>;

export async function aiAdvice(db: Db, id: number): Promise<{ advice: PhotoAdvice; demo: boolean }> {
  const p = getPhoto(db, id);
  if (!aiIsLive()) {
    return {
      demo: true,
      advice: { rotate: "0", straighten_degrees: 0, crop: null, brightness: 1.05, contrast: 1.05, saturation: 1.05, warmth: 0, remove_background: false, issues: ["Demo mode: automatic levels only"], tips: ["Add ANTHROPIC_API_KEY for AI photo analysis"] },
    };
  }
  useAi("photo");
  const small = await sharp(fs.readFileSync(p.path)).rotate().resize(1200, 1200, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const client = trackAnthropic(new Anthropic());
  const r = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(PhotoAdvice) },
    system: "You are a product photographer for online resale listings. Recommend precise, conservative corrections that make the item look accurate and appealing. Never suggest changes that misrepresent the item's true color or condition.",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } }, { type: "text", text: "Analyze this listing photo and return the corrections." }] }],
  });
  if (r.stop_reason === "refusal" || !r.parsed_output) throw new Error("The AI couldn't analyze this photo.");
  return { advice: r.parsed_output, demo: false };
}

/** Turn advice into safe edit ops (clamped; crop only if it keeps most of the image). */
export function adviceToOps(a: PhotoAdvice, allowBackground: boolean): EditOp[] {
  const ops: EditOp[] = [];
  if (a.rotate !== "0") ops.push({ type: "rotate", deg: Number(a.rotate) });
  if (Math.abs(a.straighten_degrees) >= 0.5) ops.push({ type: "rotate", deg: clamp(a.straighten_degrees, -10, 10) });
  if (a.crop && a.crop.w * a.crop.h >= 0.35) ops.push({ type: "crop", x: clamp(a.crop.x, 0, 0.6), y: clamp(a.crop.y, 0, 0.6), w: clamp(a.crop.w, 0.4, 1), h: clamp(a.crop.h, 0.4, 1) });
  ops.push({ type: "adjust", brightness: clamp(a.brightness, 0.8, 1.4), contrast: clamp(a.contrast, 0.85, 1.3), saturation: clamp(a.saturation, 0.8, 1.3), warmth: clamp(a.warmth, -1, 1), sharpen: true });
  if (a.remove_background && allowBackground) ops.push({ type: "removeBackground" });
  return ops;
}
