/**
 * "What's new" drafts from the code's history: recent updates since the last time you announced one,
 * turned into a short seller-friendly announcement for you to edit and post.
 * History comes from the local git checkout, or from GitHub (FLIPDESK_GITHUB_REPO=owner/repo,
 * plus GITHUB_TOKEN for a private repo) when the server has no .git folder (Docker / Fly).
 */
import { execFileSync } from "node:child_process";
import { z } from "zod/v4";
import { useAi } from "../context.js";
import { AiRefusal, askStructured } from "./llm.js";
import { aiIsLive } from "./ai.js";

export interface Change { sha: string; date: string; subject: string; body: string }

/** Drop the bookkeeping lines at the end of a commit message. */
const clean = (body: string) =>
  body
    .split("\n")
    .filter((l) => !/^(Co-Authored-By|Claude-Session|Signed-off-by):/i.test(l.trim()))
    .join("\n")
    .trim();

/** Changes that matter to sellers (not merges, tests, typos, internal chores). */
export const sellerFacing = (c: Change) => !/^(merge|wip|test|tests|chore|ci|refactor|bump|typo|lint|format)\b/i.test(c.subject) && !/^fix(ed)? (a )?(test|typo|lint)/i.test(c.subject);

function fromGit(limit: number): Change[] | null {
  try {
    const out = execFileSync("git", ["log", `-n${limit}`, "--no-merges", "--date=iso-strict", "--pretty=format:%H%x1f%ad%x1f%s%x1f%b%x1e"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return out
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, date, subject, body] = r.split("\x1f");
        return { sha, date, subject, body: clean(body ?? "") };
      });
  } catch {
    return null;
  }
}

async function fromGitHub(limit: number): Promise<Change[] | null> {
  const repo = process.env.FLIPDESK_GITHUB_REPO;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=${limit}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "FlipDesk", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}${r.status === 404 ? " (private repo? set GITHUB_TOKEN)" : ""}`);
  const list = (await r.json()) as { sha: string; parents: unknown[]; commit: { message: string; author: { date: string } } }[];
  return list
    .filter((c) => c.parents.length < 2)
    .map((c) => {
      const [subject, ...rest] = c.commit.message.split("\n");
      return { sha: c.sha, date: c.commit.author.date, subject, body: clean(rest.join("\n")) };
    });
}

/** Updates newer than `since` (a commit id), newest first. */
export async function recentChanges(since: string | null, limit = 30): Promise<{ changes: Change[]; source: "git" | "github" | null }> {
  let list = fromGit(limit);
  let source: "git" | "github" | null = list ? "git" : null;
  if (!list) {
    list = await fromGitHub(limit);
    source = list ? "github" : null;
  }
  if (!list) return { changes: [], source: null };
  const cut = since ? list.findIndex((c) => c.sha === since || c.sha.startsWith(since)) : -1;
  return { changes: (cut >= 0 ? list.slice(0, cut) : list).filter(sellerFacing), source };
}

const Draft = z.object({
  title: z.string().describe("Short headline for sellers, max 80 characters, e.g. 'New: bundles on your phone'"),
  body: z.string().describe("2-5 bullet lines starting with '• ', plain words, what sellers can now do and where. Max 600 characters."),
  link: z.string().describe("One app path to the most important new thing, like /bundles, or an empty string"),
});

/** Turn updates into an announcement draft (Claude when available, a plain list otherwise). */
export async function draftWhatsNew(changes: Change[]): Promise<{ title: string; body: string; link: string; ai: boolean }> {
  if (!changes.length) return { title: "", body: "", link: "", ai: false };
  if (!aiIsLive()) {
    return {
      title: changes.length === 1 ? `New: ${changes[0].subject}`.slice(0, 80) : "What's new in FlipDesk",
      body: changes
        .slice(0, 6)
        .map((c) => `• ${c.subject}`)
        .join("\n")
        .slice(0, 1000),
      link: "",
      ai: false,
    };
  }
  useAi("whats-new");
  const log = changes
    .slice(0, 25)
    .map((c) => `## ${c.subject}\n${c.body.slice(0, 1500)}`)
    .join("\n\n");
  let d: z.infer<typeof Draft>;
  try {
    d = (await askStructured({ task: "whats-new", system:
      "You write short in-app announcements for FlipDesk, a reseller tool. From the developer change log, pick what sellers will notice and care about (new features, big fixes), skip internal work (tests, docs, refactors, hosting/admin details only the owner sees). Plain words, no jargon, no version numbers or commit ids. App paths you may link: /, /inventory, /items/new, /shoot, /bulk, /bundles, /source, /shipping, /sales, /reports, /tools, /status, /help, /settings, /connections, /billing.",
      text: `Recent updates:\n\n${log}`, effort: "low", maxTokens: 4000 }, Draft)).output;
  } catch (e) {
    if (!(e instanceof AiRefusal)) throw e;
    return { title: "What's new in FlipDesk", body: changes.slice(0, 6).map((c) => `• ${c.subject}`).join("\n"), link: "", ai: false };
  }
  return { title: d.title.slice(0, 120), body: d.body.slice(0, 1000), link: /^\/[\w/-]*$/.test(d.link) ? d.link : "", ai: true };
}
