import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { Workspaces } from "../server/workspaces.js";
import { clearOutbox } from "../server/services/mailer.js";
import { askStructured, askText, AiRefusal, jsonSchemaFor, pickModel, plan, setAiCostSink, setAiKeys, setAiRouting, type AiCall } from "../server/services/llm.js";
import { generateListing, ListingDraft } from "../server/services/ai.js";
import { resetHealth, globalCheck } from "../server/health.js";

const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "OPENAI_MODEL", "GEMINI_MODEL", "DEEPSEEK_MODEL", "KIMI_MODEL", "FLIPDESK_INVITE_CODE", "SMTP_HOST", "FLIPDESK_AI_MONTHLY_BUDGET"];
let dir: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  setAiRouting({ order: [], models: {} });
  setAiKeys({});
  setAiCostSink(null);
  resetHealth();
  clearOutbox();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-r20-"));
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  setAiRouting({ order: [], models: {} });
  setAiKeys({});
  setAiCostSink(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const draft: z.infer<typeof ListingDraft> = {
  title: "Nike Air Max 90 Mens Size 10 White", short_title: "Nike Air Max 90 Sz 10", description: "Great shape.", brand: "Nike", category: "Shoes", condition: "used_good", color: "White", size: "10",
  item_specifics: [{ name: "Style", value: "Air Max 90" }], keywords: ["nike"], flaws: [], verify: [], price: { recommended: 60, low: 45, high: 80, quick_sale: 50, confidence: "medium", reasoning: "comps" }, best_marketplaces: ["ebay"],
};
type Call = { url: string; body: Record<string, unknown>; auth: string };
/** Fake AI servers. behave[host] decides each answer. */
function fakeAi(behave: Record<string, (body: Record<string, unknown>) => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body, auth: h.get("authorization") ?? h.get("x-api-key") ?? "" });
    const host = new URL(url).host;
    const f = behave[host];
    if (!f) return new Response("ok");
    return f(body);
  });
  return calls;
}
const chat = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: "served-model", choices: [{ message: { content, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }), { headers: { "content-type": "application/json" } });
const models = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));
const photo = () => {
  const p = path.join(dir, "shoe.jpg");
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return p;
};

describe("other AIs: ChatGPT, Gemini, Kimi, DeepSeek", () => {
  it("ChatGPT writes a listing from photos: strict JSON schema, photo as a data URL, model picked from its own list, cost tracked", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const spent: AiCall[] = [];
    setAiCostSink((c) => spent.push(c));
    const calls = fakeAi({
      "api.openai.com": (b) => (b.messages ? chat(JSON.stringify(draft)) : models(["gpt-9-audio", "gpt-9", "gpt-9-mini", "gpt-8.5", "dall-e-9", "text-embedding-9"])),
    });
    const r = await generateListing({ photoPaths: [photo()], hint: "nike shoes" });
    expect(r).toMatchObject({ demo: false, provider: "openai", draft: { title: draft.title } });
    const req = calls.find((c) => c.url.endsWith("/chat/completions"))!;
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.auth).toBe("Bearer sk-openai");
    expect(req.body.model).toBe("gpt-9");
    expect(req.body.max_completion_tokens).toBe(16000);
    expect(req.body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    const user = (req.body.messages as { role: string; content: unknown }[]).at(-1)!.content as { type: string; image_url?: { url: string } }[];
    expect(user[0].image_url!.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(spent[0]).toMatchObject({ provider: "openai", task: "listing", inTokens: 1000, outTokens: 500 });
    expect(spent[0].cost).toBeCloseTo((1000 * 2.5 + 500 * 15) / 1e6, 8);
  });

  it("DeepSeek and Kimi: JSON mode with the schema in the prompt; fenced answers are fine; wrong shapes fall through to the next AI", async () => {
    process.env.DEEPSEEK_API_KEY = "ds";
    process.env.MOONSHOT_API_KEY = "ms";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
    process.env.KIMI_MODEL = "kimi-k9";
    setAiRouting({ order: ["deepseek", "kimi"], models: {} });
    const S = z.object({ title: z.string(), n: z.number() });
    const calls = fakeAi({
      "api.deepseek.com": () => chat('{"title": 5}'), // wrong shape
      "api.moonshot.ai": () => chat('```json\n{"title":"ok","n":2}\n```'),
    });
    const r = await askStructured({ task: "t", system: "sys", text: "hi" }, S);
    expect(r).toMatchObject({ provider: "kimi", output: { title: "ok", n: 2 } });
    expect(r.fellBack[0]).toMatch(/DeepSeek: the answer didn't match/);
    const ds = calls.find((c) => c.url.startsWith("https://api.deepseek.com"))!;
    expect(ds.url).toBe("https://api.deepseek.com/chat/completions");
    expect(ds.body.response_format).toEqual({ type: "json_object" });
    expect((ds.body.messages as { content: string }[])[0].content).toMatch(/Reply with ONLY a JSON object.*"additionalProperties":false/s);
    expect(calls.find((c) => c.url.startsWith("https://api.moonshot.ai/v1/chat/completions"))).toBeTruthy();
  });

  it("Gemini (AI Studio) through Google's OpenAI-compatible address; help answers with the docs as system text", async () => {
    process.env.GEMINI_API_KEY = "g";
    process.env.GEMINI_MODEL = "gemini-9-pro";
    const calls = fakeAi({ "generativelanguage.googleapis.com": () => chat("Go to [Shipping](/shipping).") });
    const r = await askText({ task: "help", system: "SYS", docs: ["DOCS", "ARTICLES"], history: [{ role: "user", content: "earlier" }], text: "how do I ship?" });
    expect(r).toMatchObject({ provider: "gemini", text: "Go to [Shipping](/shipping)." });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect((calls[0].body.messages as { role: string; content: string }[]).map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect((calls[0].body.messages as { content: string }[])[0].content).toBe("SYS\n\nDOCS\n\nARTICLES");
  });

  it("falls back in your order when one fails, stops on a refusal, and says which ones failed when all do", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    const S = z.object({ ok: z.boolean() });
    let openai = () => chat('{"ok":true}');
    fakeAi({ "api.anthropic.com": () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "boom" } }), { status: 400 }), "api.openai.com": () => openai() });
    expect(plan()).toEqual(["claude", "openai"]);
    const r = await askStructured({ task: "t", system: "s", text: "x" }, S);
    expect(r.provider).toBe("openai");
    expect(r.fellBack[0]).toMatch(/^Claude \(Anthropic\):/);
    expect(globalCheck("ai")?.lastError ?? null).toBeNull();

    openai = () => chat("", { refusal: "I can't help with that." });
    await expect(askStructured({ task: "t", system: "s", text: "x" }, S)).rejects.toBeInstanceOf(AiRefusal);

    openai = () => new Response("overloaded", { status: 503 });
    await expect(askStructured({ task: "t", system: "s", text: "x" }, S)).rejects.toThrow(/Every AI failed\. Claude \(Anthropic\): .* · ChatGPT \(OpenAI\): ChatGPT \(OpenAI\) answered 503/);
    expect(globalCheck("ai")?.lastError).toMatch(/503/);

    setAiRouting({ order: ["openai", "claude"], models: {} });
    expect(plan()).toEqual(["openai", "claude"]);
    setAiRouting({ order: ["openai"], models: {} });
    expect(plan()).toEqual(["openai"]); // Claude left out on purpose
  });

  it("a model that can't read photos is skipped for photo jobs after the first refusal of the image", async () => {
    process.env.DEEPSEEK_API_KEY = "ds";
    process.env.DEEPSEEK_MODEL = "deepseek-flash";
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    setAiRouting({ order: ["deepseek", "openai"], models: {} });
    const calls = fakeAi({
      "api.deepseek.com": () => new Response('{"error":{"message":"unknown variant `image_url`, expected `text`"}}', { status: 400 }),
      "api.openai.com": () => chat(JSON.stringify(draft)),
    });
    await generateListing({ photoPaths: [photo()] });
    expect(plan({ images: true })).toEqual(["openai"]);
    expect(plan()).toEqual(["deepseek", "openai"]); // still used for text
    await generateListing({ photoPaths: [photo()] });
    expect(calls.filter((c) => c.url.includes("deepseek"))).toHaveLength(1);
  });

  it("picks sensible models from each provider's list", () => {
    expect(pickModel("openai", ["gpt-6-astra", "gpt-6.1-mini", "gpt-5.6", "gpt-6.1", "gpt-realtime-6", "gpt-6.1-2026-10-01", "o9"])).toBe("gpt-6.1");
    expect(pickModel("gemini", ["gemini-2.5-flash", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-3-flash-image", "text-embedding-004"])).toBe("gemini-3-pro-preview");
    expect(pickModel("kimi", ["moonshot-v1-8k", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2-thinking"])).toBe("kimi-k2.6");
    expect(pickModel("deepseek", ["deepseek-reasoner", "deepseek-flash"])).toBe("deepseek-flash");
    expect(pickModel("openai", ["whisper-1"])).toBeNull();
  });

  it("schemas sent to OpenAI-style APIs close every object and require every field", () => {
    const js = jsonSchemaFor(z.object({ a: z.string(), b: z.object({ c: z.array(z.object({ d: z.number() })) }) })) as { additionalProperties: boolean; required: string[]; properties: { b: { required: string[]; properties: { c: { items: { additionalProperties: boolean } } } } } };
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(["a", "b"]);
    expect(js.properties.b.properties.c.items.additionalProperties).toBe(false);
  });
});

describe("Settings → AI and spending limits", () => {
  async function hosted() {
    const shops = new Workspaces({ multiuser: true, dataDir: dir });
    const app = express().use(shops.handler());
    const o = request.agent(app);
    await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const m = request.agent(app);
    await m.post("/api/auth/signup").send({ email: "mia@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
    return { shops, app, o, m };
  }

  it("owner pastes keys (never shown back), orders the AIs, tests one; members can't see or change any of it", async () => {
    const { o, m } = await hosted();
    let ov = (await o.get("/api/ai").expect(200)).body;
    expect(ov.providers.map((p: { id: string }) => p.id)).toEqual(["claude", "openai", "gemini", "kimi", "deepseek"]);
    expect(ov.plan.text).toEqual([]);
    ov = (await o.put("/api/ai/keys/kimi").send({ key: "sk-kimi-secret-1234" }).expect(200)).body;
    expect(JSON.stringify(ov)).not.toMatch(/sk-kimi-secret/);
    expect(ov.providers.find((p: { id: string }) => p.id === "kimi")).toMatchObject({ ready: true, keySource: "settings", keyHint: "…1234" });
    process.env.OPENAI_API_KEY = "o";
    ov = (await o.put("/api/ai/routing").send({ order: ["kimi", "openai"], models: { kimi: "kimi-k9", openai: "gpt-9" } }).expect(200)).body;
    expect(ov.plan.photos).toEqual(["kimi", "openai"]);
    const calls = fakeAi({ "api.moonshot.ai": () => chat('{"ok":true,"word":"pong"}') });
    expect((await o.post("/api/ai/test/kimi").expect(200)).body).toMatchObject({ ok: true, model: "kimi-k9" });
    expect(calls[0].auth).toBe("Bearer sk-kimi-secret-1234");
    await m.get("/api/ai").expect(403);
    await m.put("/api/ai/keys/openai").send({ key: "x" }).expect(403);
    await m.put("/api/ai/routing").send({ order: [] }).expect(403);
    await o.put("/api/ai/routing").send({ order: ["skynet"] }).expect(400);
  });

  it("monthly budget and per-member limit: tracked from real token counts, alerts at 80% and 100% once, pauses AI at the limit", async () => {
    const { shops, o, m } = await hosted();
    process.env.OPENAI_API_KEY = "o";
    process.env.OPENAI_MODEL = "gpt-9";
    const pushes: string[] = [];
    fakeAi({ "api.openai.com": () => chat("Answer.", {}), "ntfy.sh": () => (pushes.push("x"), new Response("ok")) });
    process.env.SMTP_HOST = "test";
    // each answer: 1000 in + 500 out at $2.50/$15 per million = $0.01
    await o.put("/api/ai/budget").send({ monthly: 0.025, perMember: 0.01 }).expect(200);
    await m.post("/api/help/ask").send({ question: "how do I ship" }).expect(200);
    expect(shops.aiSpentThisMonth(2)).toBeCloseTo(0.01, 6);
    // member's own limit reached; the owner isn't limited per member
    expect((await m.post("/api/help/ask").send({ question: "and returns?" }).expect(429)).body.error).toMatch(/this month's AI allowance/);
    expect((await m.get("/api/ai/mine")).body).toMatchObject({ allowance: 0.01 });
    await o.post("/api/help/ask").send({ question: "q1" }).expect(200); // 0.02 -> 80% alert
    await o.post("/api/help/ask").send({ question: "q2" }).expect(200); // 0.03 -> 100% alert
    await o.post("/api/help/ask").send({ question: "q3" }).expect(429); // paused for everyone
    const ov = (await o.get("/api/ai")).body;
    expect(ov.spent.byProvider[0]).toMatchObject({ k: "openai", calls: 3 });
    expect(ov.spent.byTask[0]).toMatchObject({ k: "help" });
    expect(ov.spent.byMember.map((x: { k: string }) => x.k).sort()).toEqual(["mia@x.com", "owner@x.com"]);
    const { outbox } = await import("../server/services/mailer.js");
    const subjects = outbox().map((x) => x.subject);
    expect(subjects.filter((x) => /80% of this month's AI budget/.test(x))).toHaveLength(1);
    expect(subjects.filter((x) => /AI budget used up/.test(x))).toHaveLength(1);
    // the usage chart now shows the tracked cost
    expect((await o.get("/api/admin/usage")).body.weeks.at(-1).aiCost).toBeCloseTo(0.03, 2);
  });
});

describe("public status page", () => {
  it("off by default; when on, anyone sees up/down, 30-day uptime and incident times, never error details", async () => {
    const shops = new Workspaces({ multiuser: true, dataDir: dir });
    const app = express().use(shops.handler());
    const o = request.agent(app);
    await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
    await request(app).get("/api/public-status").expect(404);
    shops.site.prepare("INSERT INTO incidents (service, started_at, ended_at, last_error) VALUES ('ebay', datetime('now','-2 days'), datetime('now','-2 days','+72 minutes'), 'token secret abc123 refused')").run();
    shops.site.prepare("INSERT INTO incidents (service, started_at, last_error) VALUES ('ai', datetime('now','-10 minutes'), 'quota for key sk-123')").run();
    await o.put("/api/public-status/settings").send({ on: true, title: "Flip Co" }).expect(200);
    const r = await request(app).get("/api/public-status").expect(200);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|sk-123|abc123/);
    expect(r.body).toMatchObject({ name: "Flip Co", overall: "degraded" });
    const s = Object.fromEntries(r.body.services.map((x: { key: string }) => [x.key, x]));
    expect(s.ai.state).toBe("down");
    expect(s.ebay).toMatchObject({ state: "ok", uptime30: 99.83 });
    expect(s.app).toMatchObject({ state: "ok", uptime30: 100 });
    expect(r.body.incidents.map((i: { label: string; minutes: number; endedAt: string | null }) => [i.label, i.endedAt === null])).toEqual([["AI writer", true], ["eBay", false]]);
    expect(r.body.incidents[1].minutes).toBe(72);
  });
});

describe("your own sign-in history", () => {
  it("members see their own sign-ins and failed tries, not other people's", async () => {
    const shops = new Workspaces({ multiuser: true, dataDir: dir });
    const app = express().use(shops.handler());
    const o = request.agent(app);
    await o.post("/api/auth/signup").send({ email: "owner@x.com", password: "owner-pass-1" }).expect(200);
    process.env.FLIPDESK_INVITE_CODE = "inv";
    const m = request.agent(app);
    await m.post("/api/auth/signup").send({ email: "mia@x.com", password: "member-pass-1", invite: "inv" }).expect(200);
    await request(app).post("/api/auth/login").send({ email: "mia@x.com", password: "nope-nope-1" }).expect(401);
    await m.post("/api/auth/login").send({ email: "mia@x.com", password: "member-pass-1" }).expect(200);
    await request(app).post("/api/auth/login").send({ email: "owner@x.com", password: "nope-nope-1" }).expect(401);
    const h = (await m.get("/api/devices").expect(200)).body.history as { action: string; detail: string }[];
    expect(h.map((x) => x.action)).toEqual(["signed in", "sign-in failed"]);
    expect(JSON.stringify(h)).not.toMatch(/owner@/);
  });
});

describe("fire drill", () => {
  it("practises a full recovery from the newest backup in a scratch folder, times it, and estimates the real thing", async () => {
    const shops = new Workspaces({ dataDir: dir, mainDb: path.join(dir, "flipdesk.db"), mainUploads: path.join(dir, "uploads"), password: "" });
    const main = shops.get("main")!;
    fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
    for (let i = 1; i <= 3; i++) {
      main.db.prepare("INSERT INTO items (sku, title, price) VALUES (?, ?, 10)").run(`S${i}`, `Item ${i}`);
      const f = path.join(dir, "uploads", `p${i}.jpg`);
      fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      main.db.prepare("INSERT INTO photos (item_id, path, position) VALUES (?, ?, 0)").run(i, f);
    }
    const app = express().use(shops.handler());
    await request(app).post("/api/backups/fire-drill").send({}).expect(400); // no backup yet
    await request(app).post("/api/backups").expect(200);
    const r = (await request(app).post("/api/backups/fire-drill").send({}).expect(200)).body;
    expect(r.ok).toBe(true);
    expect(r.steps.map((s: { name: string }) => s.name)).toEqual(["Unpack the backup (databases and every photo)", "Open every shop with this version", "Open every main screen", "Photos the listings use are all there"]);
    expect(r.shops.find((s: { name: string }) => s.name === "shop")).toMatchObject({ items: 3, photos: 3 });
    expect(r.estimate).toMatch(/^About \d+ minutes?: download/);
    expect((await request(app).get("/api/backups")).body.drill.ok).toBe(true);
    expect(await shops.fireDrillIfDue()).toBeNull(); // done this month

    // a photo missing from the backup is caught
    main.db.prepare("INSERT INTO photos (item_id, path, position) VALUES (1, '/gone/missing.jpg', 1)").run();
    await request(app).post("/api/backups").expect(200);
    const bad = (await request(app).post("/api/backups/fire-drill").send({}).expect(200)).body;
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/1 of 4 photos aren't in the backup/);
  });
});
