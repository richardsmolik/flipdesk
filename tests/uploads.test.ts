import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { isHeic, normalizeImage } from "../server/services/uploads.js";

let db: Db;
const dir = path.join(os.tmpdir(), "fd-up");
beforeEach(() => {
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(":memory:");
});
const fx = (n: string) => path.join(__dirname, "fixtures", n);

describe("upload normalization", () => {
  it("detects and converts iPhone HEIC to JPEG", async () => {
    expect(isHeic(fs.readFileSync(fx("iphone.heic")))).toBe(true);
    expect(isHeic(fs.readFileSync(fx("gps-rotated.jpg")))).toBe(false);
    const tmp = path.join(dir, "a.heic");
    fs.copyFileSync(fx("iphone.heic"), tmp);
    const out = await normalizeImage(tmp);
    expect(out.endsWith(".jpg")).toBe(true);
    expect(fs.existsSync(tmp)).toBe(false);
    const m = await sharp(out).metadata();
    expect(m.format).toBe("jpeg");
    expect([m.width, m.height]).toEqual([1200, 900]);
  });

  it("applies EXIF rotation and strips GPS / EXIF", async () => {
    const before = await sharp(fx("gps-rotated.jpg")).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeTruthy();
    const tmp = path.join(dir, "b.jpg");
    fs.copyFileSync(fx("gps-rotated.jpg"), tmp);
    const out = await normalizeImage(tmp);
    const m = await sharp(out).metadata();
    expect([m.width, m.height]).toEqual([300, 600]); // upright now
    expect(m.orientation).toBeUndefined();
    expect(m.exif).toBeUndefined(); // GPS gone
  });

  it("downsizes huge photos to 2400px", async () => {
    const tmp = path.join(dir, "big.png");
    await sharp({ create: { width: 5000, height: 3000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(tmp);
    const out = await normalizeImage(tmp);
    const m = await sharp(out).metadata();
    expect([m.width, m.height]).toEqual([2400, 1440]);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240); // transparent -> white, not black
  });

  it("HTTP: HEIC uploaded as application/octet-stream works; junk is skipped, not fatal", async () => {
    const app = createApp(db, { uploadDir: dir });
    const item = (await request(app).post("/api/items").send({ title: "Phone pics" })).body;
    const r = await request(app)
      .post(`/api/items/${item.id}/photos`)
      .attach("photos", fs.readFileSync(fx("iphone.heic")), { filename: "IMG_0001.HEIC", contentType: "application/octet-stream" })
      .attach("photos", Buffer.from("not an image"), { filename: "broken.jpg", contentType: "image/jpeg" })
      .expect(200);
    expect(r.body.photos).toHaveLength(1);
    expect(r.body.photos[0].url).toMatch(/\.jpg$/);
    expect(r.body.skippedUploads).toEqual(["broken.jpg"]);
  });
});
