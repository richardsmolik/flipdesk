/**
 * "Ask FlipDesk": answers how-to questions from FlipDesk's own docs (README, eBay setup, hosting guide,
 * get-started steps). With an Anthropic key, Claude answers using only those docs (cached between questions,
 * so each answer is cheap). Without one, the best-matching doc sections are shown instead.
 */
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { useAi } from "../context.js";
import { reportHealth } from "../health.js";
import { aiIsLive, MODEL } from "./ai.js";
import { HOW } from "./onboarding.js";

export interface Section { title: string; text: string; source: string }

const DOCS: [string, string][] = [
  ["README.md", "Features"],
  ["docs/EBAY_SETUP.md", "eBay setup guide"],
  ["docs/DEPLOY.md", "Hosting guide"],
];

const PAGES = `App pages: Dashboard (/), Inbox (/inbox), New listing (/items/new), Shoot on phone (/shoot), Bulk upload (/bulk), Inventory (/inventory), Bundles (/bundles), Sourcing mode (/source), Mileage (/mileage), Shipping (/shipping), Bins (/bins), Sales & profit (/sales), Reports (/reports), Leaderboard (/leaderboard), Power tools (/tools), Sync queue (/queue), Status (/status), Marketplaces (/connections), Switch to FlipDesk (/switch), Settings (/settings), Your plan (/billing), Accounts (owner only, /accounts). Keyboard: n = new listing, / = search, g then a letter to jump, ? = all shortcuts.`;

let cache: { sections: Section[]; corpus: string } | null = null;

export function docs() {
  if (cache) return cache;
  const sections: Section[] = [];
  const parts: string[] = [PAGES];
  for (const [file, source] of DOCS) {
    if (!fs.existsSync(file)) continue;
    const md = fs.readFileSync(file, "utf8");
    parts.push(`<doc name="${source}">\n${md}\n</doc>`);
    let title = source;
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join("\n").trim();
      if (text) sections.push({ title, text, source });
      buf = [];
    };
    for (const line of md.split("\n")) {
      const h = line.match(/^#{1,3}\s+(.*)/);
      const row = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|\s*$/); // feature table rows are their own sections
      if (h) (flush(), (title = h[1]));
      else if (row) sections.push({ title: row[1], text: row[2], source });
      else buf.push(line);
    }
    flush();
  }
  const steps = Object.entries(HOW).map(([k, s]) => `${k}: ${s.join(" ")}`);
  parts.push(`<doc name="Get started steps">\n${steps.join("\n")}\n</doc>`);
  for (const [k, s] of Object.entries(HOW)) sections.push({ title: `Get started: ${k}`, text: s.map((x, i) => `${i + 1}. ${x}`).join("\n"), source: "Get started" });
  cache = { sections, corpus: parts.join("\n\n") };
  return cache;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ing|es|s)$/, "")) ?? [];
const STOP = new Set(["the", "and", "for", "how", "can", "you", "what", "does", "with", "this", "that", "are", "why", "not", "get", "use", "from", "into", "when", "where", "there", "have", "want", "need"]);

/** No-AI fallback: the doc sections that share the most words with the question. */
export function searchDocs(q: string, limit = 3): Section[] {
  const qw = new Set(words(q));
  if (!qw.size) return [];
  return docs()
    .sections.map((s) => {
      const tw = words(s.title);
      const bw = words(s.text);
      let score = 0;
      for (const w of qw) score += (tw.includes(w) ? 6 : 0) + Math.min(3, bw.filter((x) => x === w).length); // a matching heading beats a passing mention
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.s, text: x.s.text.slice(0, 900) }));
}

const SYSTEM = `You are the built-in help for FlipDesk, a reseller tool (crosslisting to eBay, Poshmark, Mercari and more; AI listing writer; inventory, shipping, profit).
Answer the seller's question using ONLY the FlipDesk documentation below. Be short and practical: numbered steps when there are steps, and name the exact page or button (e.g. "Settings → Weekly summary"). Link pages as markdown links to their app path, like [Shipping](/shipping).
If the docs don't cover it, say so in one sentence and suggest "💬 Send feedback" in the sidebar. Never invent features, settings or prices. Plain words, no jargon.`;

export interface HelpTurn { role: "user" | "assistant"; content: string }

export async function askHelp(question: string, history: HelpTurn[] = [], page = "") {
  const sources = searchDocs(question);
  if (!aiIsLive()) return { answer: null as string | null, sources, demo: true };
  useAi("help"); // counts against the person's daily AI allowance
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
    { role: "user", content: `${page ? `(I'm on the page ${page})\n` : ""}${question}` },
  ];
  try {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" }, // quick how-to answers
      // The docs are the same for every question: cache them so follow-ups cost a fraction.
      system: [{ type: "text", text: `${SYSTEM}\n\n${docs().corpus}`, cache_control: { type: "ephemeral" } }],
      messages,
    });
    reportHealth("ai", true);
    if (r.stop_reason === "refusal") return { answer: "I can't help with that one. Try rephrasing, or use 💬 Send feedback.", sources, demo: false };
    const answer = r.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { answer: answer || "I couldn't find that in the docs.", sources, demo: false };
  } catch (e) {
    reportHealth("ai", false, (e as Error).message);
    throw e;
  }
}
