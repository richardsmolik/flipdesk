import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getItem, openDb, type Db } from "../server/db.js";
import { createApp } from "../server/app.js";
import { aiStatus, runAutoWrite, scheduleAutoWrite } from "../server/services/autowrite.js";

let db: Db;
const dir = path.join(os.tmpdir(), "fd-r7");
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(":memory:");
});
const photo = async () => sharp({ create: { width: 300, height: 300, channels: 3, background: "#456" } }).jpeg().toBuffer();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AI writes the draft while you shoot", () => {
  it("fills only empty fields, keeps what you typed, stores notes + status", async () => {
    const id = Number(db.prepare("INSERT INTO items (sku, title, brand, notes, price, cost) VALUES ('AW1', '', 'MyBrand', 'nike dunk low size 10', 0, 40)").run().lastInsertRowid);
    const f = path.join(dir, "aw.jpg");
    fs.writeFileSync(f, await photo());
    db.prepare("INSERT INTO photos (item_id, path) VALUES (?, ?)").run(id, f);
    await runAutoWrite(db, id);
    const it = getItem(db, id)!;
    expect(it.title).toMatch(/Nike Dunk Low/i); // from the notes (demo writer)
    expect(it.brand).toBe("MyBrand"); // you typed it: untouched
    expect(it.price).toBeGreaterThan(0);
    const st = aiStatus(db, id);
    expect(st.state).toBe("done");
    expect(st.demo).toBe(true);
    expect(st.draft?.verify.length).toBeGreaterThan(0);
  });

  it("debounces after phone uploads and never runs for items that already have a title", async () => {
    const titled = Number(db.prepare("INSERT INTO items (sku, title) VALUES ('AW2', 'Already named')").run().lastInsertRowid);
    expect(scheduleAutoWrite(db, titled, 0)).toBe(false);
    const app = createApp(db, { uploadDir: dir });
    const item = (await request(app).post("/api/items").send({ notes: "coach tabby bag black" })).body;
    const link = (await request(app).post(`/api/items/${item.id}/phone-link`)).body;
    const up = await request(app).post(`/api/m/${link.token}/photos`).attach("photos", await photo(), "a.jpg").expect(200);
    expect(up.body.autoWriting).toBe(true);
    expect((await request(app).get(`/api/m/${link.token}`)).body.ai).toBe("pending");
    // speed up: run now instead of waiting the 6s pause
    scheduleAutoWrite(db, item.id, 0);
    await wait(150);
    const info = (await request(app).get(`/api/m/${link.token}`)).body;
    expect(info.ai).toBe("done");
    expect(info.title).toMatch(/Coach Tabby/i);
    const st = (await request(app).get(`/api/items/${item.id}/ai-status`)).body;
    expect(st.state).toBe("done");
    // Shoot mode endpoint
    const shoot = (await request(app).post("/api/items").send({ notes: "pyrex bowl" })).body;
    expect((await request(app).post(`/api/items/${shoot.id}/auto-write`)).body.queued).toBe(true);
    expect((await request(app).post(`/api/items/${titled}/auto-write`)).body.queued).toBe(false);
  });
});

describe("installable app files", () => {
  it("manifest is valid and its icons exist; service worker never caches the API", () => {
    const m = JSON.parse(fs.readFileSync("web/public/manifest.webmanifest", "utf8"));
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/shoot");
    for (const i of m.icons) expect(fs.existsSync(path.join("web/public", i.src))).toBe(true);
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    const sw = fs.readFileSync("web/public/sw.js", "utf8");
    expect(sw).toMatch(/startsWith\("\/api"\)/);
    expect(sw).toMatch(/startsWith\("\/uploads"\)/);
  });
});
