/**
 * One switchboard for every AI feature: Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google AI Studio),
 * DeepSeek and Kimi (Moonshot). The owner picks the order in Settings → AI; each request goes to the first
 * provider that's set up (and can see photos, when there are photos) and falls through to the next one if it
 * fails. Claude uses its own API (structured outputs, cached docs, server-side fallback). The other four all
 * speak the OpenAI chat format, so one adapter covers them; their answers are checked against the same schema.
 *
 * Model names change every few months, so none are hard-coded for the others: FlipDesk asks each provider for
 * its model list and picks a sensible one (the owner can choose another). Every call's tokens and estimated
 * cost are reported to the spending tracker.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { reportHealth } from "../health.js";
import { currentWorkspace, type WorkspaceContext } from "../context.js";

export const CLAUDE_MODEL = "claude-opus-5-5";
export type ProviderId = "claude" | "openai" | "gemini" | "deepseek" | "kimi";
export const PROVIDER_IDS: ProviderId[] = ["claude", "openai", "gemini", "kimi", "deepseek"];

interface ProviderInfo {
  name: string;
  keys: string[];
  base?: string;
  baseEnv?: string;
  modelEnv: string;
  /** Plain-words note shown next to it in Settings. */
  note: string;
  /** Default $ per million tokens [input, output]: rough estimates, editable in Settings → AI. */
  price: [number, number];
  /** Accepts json_schema response format (otherwise JSON mode + the schema in the prompt). */
  jsonSchema: boolean;
  signup: string;
}
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: { name: "Claude (Anthropic)", keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], modelEnv: "ANTHROPIC_MODEL", note: "Best at reading photos and following the listing format. The default.", price: [5, 25], jsonSchema: true, signup: "https://console.anthropic.com" },
  openai: { name: "ChatGPT (OpenAI)", keys: ["OPENAI_API_KEY"], base: "https://api.openai.com/v1", baseEnv: "OPENAI_BASE_URL", modelEnv: "OPENAI_MODEL", note: "Strong all-rounder with photos.", price: [2.5, 15], jsonSchema: true, signup: "https://platform.openai.com/api-keys" },
  gemini: { name: "Gemini (Google AI Studio)", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], base: "https://generativelanguage.googleapis.com/v1beta/openai", baseEnv: "GEMINI_BASE_URL", modelEnv: "GEMINI_MODEL", note: "Fast and cheap with photos. On AI Studio's free tier Google may use what you send to improve its products.", price: [1.25, 10], jsonSchema: true, signup: "https://aistudio.google.com/apikey" },
  kimi: { name: "Kimi (Moonshot AI)", keys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"], base: "https://api.moonshot.ai/v1", baseEnv: "MOONSHOT_BASE_URL", modelEnv: "KIMI_MODEL", note: "Low cost; newer Kimi models read photos. Moonshot is based in China: photos and text you send are processed there.", price: [0.6, 2.5], jsonSchema: false, signup: "https://platform.moonshot.ai" },
  deepseek: { name: "DeepSeek", keys: ["DEEPSEEK_API_KEY"], base: "https://api.deepseek.com", baseEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL", note: "Cheapest; best for text (help answers, announcements). Photo support depends on the model. DeepSeek is based in China: what you send is processed there.", price: [0.3, 1.2], jsonSchema: false, signup: "https://platform.deepseek.com/api_keys" },
};

/** Keys pasted in Settings → AI (the server's own environment settings win when both exist). */
let savedKeys: Partial<Record<ProviderId, string>> = {};
export const setAiKeys = (k: Partial<Record<ProviderId, string>>) => void (savedKeys = k);
const envKey = (id: ProviderId) => PROVIDERS[id].keys.map((k) => process.env[k]).find(Boolean) ?? "";
const keyOf = (id: ProviderId) => envKey(id) || savedKeys[id] || "";
export const keySource = (id: ProviderId): "env" | "settings" | null => (envKey(id) ? "env" : savedKeys[id] ? "settings" : null);
export const providerReady = (id: ProviderId) => Boolean(keyOf(id));
export const anyAi = () => PROVIDER_IDS.some(providerReady);
const baseOf = (id: ProviderId) => (process.env[PROVIDERS[id].baseEnv ?? ""] || PROVIDERS[id].base || "").replace(/\/$/, "");

// ---------------- Owner's choices (set by the server from site settings) ----------------

export interface AiRouting {
  /** Try in this order. Providers left out are not used. Empty = every provider that has a key, in the default order. */
  order: ProviderId[];
  /** Chosen model per provider (blank = automatic). */
  models: Partial<Record<ProviderId, string>>;
  /** Optional: a different order for text-only jobs (help answers, announcements), e.g. cheapest first. */
  textOrder?: ProviderId[];
  /** $ per million tokens overrides. */
  prices?: Partial<Record<ProviderId, [number, number]>>;
}
let routing: AiRouting = { order: [], models: {} };
export const setAiRouting = (r: AiRouting) => void (routing = r);
export const getAiRouting = () => routing;

/** Which providers a request would try, in order. */
export function plan(opts: { images?: boolean } = {}): ProviderId[] {
  const list = (!opts.images && routing.textOrder?.length ? routing.textOrder : routing.order.length ? routing.order : PROVIDER_IDS).filter(providerReady);
  return opts.images ? list.filter((id) => !noVision.has(`${id}:${modelFor(id) ?? "auto"}`)) : list;
}

// ---------------- Spending: every call reports here ----------------

export interface AiCall { provider: ProviderId; model: string; task: string; inTokens: number; outTokens: number; cost: number; ws?: WorkspaceContext }
let sink: ((c: AiCall) => void) | null = null;
export const setAiCostSink = (s: ((c: AiCall) => void) | null) => void (sink = s);
export const priceOf = (id: ProviderId): [number, number] => routing.prices?.[id] ?? PROVIDERS[id].price;
function charge(provider: ProviderId, model: string, task: string, inTokens: number, outTokens: number) {
  const [pi, po] = priceOf(provider);
  const cost = (inTokens * pi + outTokens * po) / 1e6;
  try {
    sink?.({ provider, model, task, inTokens, outTokens, cost, ws: currentWorkspace() });
  } catch {
    /* tracking never breaks a request */
  }
  return cost;
}

// ---------------- Models ----------------

const modelCache = new Map<ProviderId, { at: number; ids: string[] }>();
const noVision = new Set<string>();
const modelFor = (id: ProviderId) => routing.models[id] || process.env[PROVIDERS[id].modelEnv] || (id === "claude" ? CLAUDE_MODEL : undefined);

/** The provider's own list of models (cached 6 hours). */
export async function listModels(id: ProviderId, fresh = false): Promise<string[]> {
  if (id === "claude") return [CLAUDE_MODEL];
  const c = modelCache.get(id);
  if (!fresh && c && Date.now() - c.at < 6 * 3600_000) return c.ids;
  const r = await fetch(`${baseOf(id)}/models`, { headers: { Authorization: `Bearer ${keyOf(id)}` } });
  if (!r.ok) throw new Error(`${PROVIDERS[id].name} answered ${r.status} listing models: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { data?: { id: string }[] };
  const ids = (j.data ?? []).map((m) => m.id.replace(/^models\//, ""));
  modelCache.set(id, { at: Date.now(), ids });
  return ids;
}

const version = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? ["0"]).map(Number);
const newer = (a: string, b: string) => {
  const va = version(a);
  const vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
  return a.length - b.length;
};
/** A sensible default from a provider's model list: its newest general chat model (not audio/image/embedding/mini variants). */
export function pickModel(id: ProviderId, ids: string[]): string | null {
  const skip = /(audio|realtime|transcribe|tts|image|embed|search|moderation|instruct|codex|code|live|vision-preview|thinking|reasoner|dall|whisper|babbage|davinci|oss|nano|lite|exp|preview-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})/i;
  const want: Record<Exclude<ProviderId, "claude">, RegExp> = { openai: /^gpt-\d/, gemini: /^gemini-\d/, kimi: /^kimi-k\d/, deepseek: /^deepseek-/ };
  if (id === "claude") return CLAUDE_MODEL;
  let pool = ids.filter((m) => want[id].test(m) && !skip.test(m));
  if (id === "openai") pool = pool.filter((m) => !/mini/.test(m)).length ? pool.filter((m) => !/mini/.test(m)) : pool;
  if (id === "gemini") pool = pool.filter((m) => /pro|flash/.test(m));
  if (!pool.length && id === "kimi") pool = ids.filter((m) => /^kimi-latest|^moonshot-v1-.*vision/.test(m));
  if (!pool.length && id === "deepseek") pool = ids.filter((m) => /chat|flash/.test(m));
  if (!pool.length) return null;
  pool.sort(newer);
  if (id === "gemini") return pool.find((m) => m.startsWith(pool[0].split("-").slice(0, 2).join("-")) && /pro/.test(m)) ?? pool[0];
  return pool[0];
}
async function resolveModel(id: ProviderId) {
  const m = modelFor(id);
  if (m) return m;
  const picked = pickModel(id, await listModels(id));
  if (!picked) throw new Error(`${PROVIDERS[id].name}: no suitable model found. Pick one in Settings → AI.`);
  return picked;
}

// ---------------- Requests ----------------

export interface Img { data: string; mediaType: string }
export interface AskOpts {
  task: string;
  system: string;
  /** Large text that's the same every time (docs): cached by Claude, sent as more system text to others. */
  docs?: string[];
  history?: { role: "user" | "assistant"; content: string }[];
  text: string;
  images?: Img[];
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  /** Use exactly this AI (no fallback): for comparing AIs, e.g. the backtest. */
  only?: ProviderId;
  /** Try this AI first (the usual order after it), e.g. the best AI for this item's category. */
  prefer?: ProviderId;
}
export class AiRefusal extends Error {}

/** JSON Schema an OpenAI-style API accepts: every object closed, every property required. */
export function jsonSchemaFor(schema: z.ZodType) {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  const fix = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o.type === "object" && o.properties) {
      o.additionalProperties = false;
      o.required = Object.keys(o.properties as object);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") Array.isArray(v) ? v.forEach(fix) : fix(v);
  };
  fix(js);
  return js;
}

const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

async function openaiStyle(id: ProviderId, o: AskOpts, schema?: z.ZodType) {
  const model = await resolveModel(id);
  const sys = [o.system, ...(o.docs ?? [])].join("\n\n") + (schema && !PROVIDERS[id].jsonSchema ? `\n\nReply with ONLY a JSON object (no other text) that matches this JSON Schema:\n${JSON.stringify(jsonSchemaFor(schema))}` : "");
  const user = o.images?.length ? [...o.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), { type: "text", text: o.text }] : o.text;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: sys }, ...(o.history ?? []), { role: "user", content: user }],
    [id === "openai" ? "max_completion_tokens" : "max_tokens"]: o.maxTokens ?? 4000,
  };
  if (schema) body.response_format = PROVIDERS[id].jsonSchema ? { type: "json_schema", json_schema: { name: "answer", schema: jsonSchemaFor(schema), strict: id === "openai" } } : { type: "json_object" };
  const r = await fetch(`${baseOf(id)}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(id)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const raw = await r.text();
  if (!r.ok) {
    if (o.images?.length && r.status === 400 && /image|vision|multimodal|image_url/i.test(raw)) noVision.add(`${id}:${modelFor(id) ?? "auto"}`);
    throw new Error(`${PROVIDERS[id].name} answered ${r.status}: ${raw.slice(0, 300)}`);
  }
  const j = JSON.parse(raw) as { model?: string; choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const ch = j.choices?.[0];
  const cost = charge(id, j.model ?? model, o.task, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
  if (ch?.message?.refusal || ch?.finish_reason === "content_filter") throw new AiRefusal(ch?.message?.refusal || "declined");
  const content = ch?.message?.content ?? "";
  if (ch?.finish_reason === "length") throw new Error(`${PROVIDERS[id].name}: the answer was cut off`);
  return { content, model: j.model ?? model, cost };
}

async function claude(o: AskOpts, schema?: z.ZodType) {
  const client = envKey("claude") ? new Anthropic() : new Anthropic({ apiKey: keyOf("claude") });
  const model = modelFor("claude")!;
  const system = o.docs?.length
    ? [{ type: "text" as const, text: `${o.system}\n\n${o.docs[0]}`, cache_control: { type: "ephemeral" as const } }, ...o.docs.slice(1).map((d) => ({ type: "text" as const, text: d }))]
    : o.system;
  const content = o.images?.length
    ? [...o.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType as "image/jpeg", data: i.data } })), { type: "text" as const, text: o.text }]
    : o.text;
  const params = {
    model,
    max_tokens: o.maxTokens ?? 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    system,
    messages: [...(o.history ?? []), { role: "user" as const, content }],
  };
  const r = schema
    ? await client.beta.messages.parse({ ...params, output_config: { effort: o.effort ?? "low", format: betaZodOutputFormat(schema) } } as never)
    : await client.beta.messages.create({ ...params, output_config: { effort: o.effort ?? "low" } } as never);
  const res = r as unknown as { model: string; stop_reason: string; parsed_output?: unknown; content: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  const u = res.usage ?? {};
  const cost = charge("claude", res.model ?? model, o.task, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1, u.output_tokens ?? 0);
  if (res.stop_reason === "refusal") throw new AiRefusal("declined");
  if (res.stop_reason === "max_tokens") throw new Error("Claude: the answer was cut off");
  return { res, model: res.model ?? model, cost };
}

/** Try each provider in turn. Refusals stop (another AI shouldn't be shopped for the same request). */
async function viaProviders<T>(o: AskOpts, run: (id: ProviderId) => Promise<T>) {
  let order = o.only ? (providerReady(o.only) ? [o.only] : []) : plan({ images: Boolean(o.images?.length) });
  if (!o.only && o.prefer && order.includes(o.prefer)) order = [o.prefer, ...order.filter((p) => p !== o.prefer)];
  if (!order.length) throw Object.assign(new Error(o.images?.length ? "No AI that can read photos is set up. Add a key in Settings → AI." : "No AI is set up. Add a key in Settings → AI."), { status: 400 });
  const errors: string[] = [];
  for (const id of order) {
    try {
      const out = await run(id);
      reportHealth("ai", true);
      return { out, provider: id, fellBack: errors };
    } catch (e) {
      if (e instanceof AiRefusal) {
        reportHealth("ai", true);
        throw e;
      }
      errors.push(`${PROVIDERS[id].name}: ${(e as Error).message}`.slice(0, 300));
      console.warn(`[ai] ${o.task}: ${PROVIDERS[id].name} failed, ${order.indexOf(id) < order.length - 1 ? "trying the next one" : "no more to try"}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  reportHealth("ai", false, errors.join(" | ").slice(0, 500));
  throw new Error(errors.length > 1 ? `Every AI failed. ${errors.join(" · ")}` : errors[0]);
}

/** A structured answer (validated against the schema) from the first provider that manages it. */
export async function askStructured<S extends z.ZodType>(o: AskOpts, schema: S): Promise<{ output: z.infer<S>; provider: ProviderId; model: string; fellBack: string[]; cost: number }> {
  const r = await viaProviders(o, async (id) => {
    if (id === "claude") {
      const { res, model, cost } = await claude(o, schema);
      if (!res.parsed_output) throw new Error("Claude: no answer");
      return { output: res.parsed_output as z.infer<S>, model, cost };
    }
    const { content, model, cost } = await openaiStyle(id, o, schema);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(content));
    } catch {
      throw new Error("the answer wasn't valid JSON");
    }
    const ok = schema.safeParse(parsed);
    if (!ok.success) throw new Error(`the answer didn't match the format (${ok.error.issues[0]?.path.join(".")}: ${ok.error.issues[0]?.message})`);
    return { output: ok.data as z.infer<S>, model, cost };
  });
  return { output: r.out.output, model: r.out.model, provider: r.provider, fellBack: r.fellBack, cost: r.out.cost };
}

/** A plain-text answer. */
export async function askText(o: AskOpts): Promise<{ text: string; provider: ProviderId; model: string; fellBack: string[] }> {
  const r = await viaProviders(o, async (id) => {
    if (id === "claude") {
      const { res, model } = await claude(o);
      return { text: res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(), model };
    }
    const { content, model } = await openaiStyle(id, o);
    return { text: content.trim(), model };
  });
  return { text: r.out.text, model: r.out.model, provider: r.provider, fellBack: r.fellBack };
}

/** Settings → AI → Test: a tiny structured request to one provider. */
export async function testProvider(id: ProviderId) {
  const t = performance.now();
  const Pong = z.object({ ok: z.boolean(), word: z.string() });
  const o: AskOpts = { task: "test", system: "You are a connection test.", text: 'Reply with ok=true and word="pong".', maxTokens: 300 };
  const out = id === "claude" ? ((await claude(o, Pong)).res.parsed_output as z.infer<typeof Pong>) : Pong.parse(JSON.parse(stripFences((await openaiStyle(id, o, Pong)).content)));
  return { ok: out.ok === true, ms: Math.round(performance.now() - t), model: await resolveModel(id) };
}
