/**
 * File a GitHub issue on your FlipDesk repo (FLIPDESK_GITHUB_REPO=owner/repo, GITHUB_TOKEN with "Issues: write").
 * Used to send problem reports to whoever fixes FlipDesk, with your OK each time.
 */
export const githubIssuesReady = () => Boolean(process.env.FLIPDESK_GITHUB_REPO && process.env.GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(process.env.FLIPDESK_GITHUB_REPO));

export async function createIssue(title: string, body: string) {
  if (!githubIssuesReady()) throw Object.assign(new Error("Set FLIPDESK_GITHUB_REPO and GITHUB_TOKEN (with permission to create issues) on the server, or download the report and send it yourself."), { status: 400 });
  const r = await fetch(`https://api.github.com/repos/${process.env.FLIPDESK_GITHUB_REPO}/issues`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "FlipDesk", "Content-Type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 250), body: body.slice(0, 64_000) }),
  });
  const j = (await r.json().catch(() => ({}))) as { html_url?: string; message?: string };
  if (!r.ok || !j.html_url) throw Object.assign(new Error(`GitHub: ${j.message ?? r.status}`), { status: 502 });
  return j.html_url;
}

/** A problem report as a readable issue: summary first, the full report as JSON below (for scripts/replay.ts). */
export function problemIssue(report: { error: string; marketplace: string; mode: string; version: string; at: string; job: { type: string }; exchanges: unknown[] }, note = "") {
  const json = JSON.stringify(report, null, 1);
  return {
    title: `[Problem report] ${report.marketplace} ${report.job.type} failed: ${report.error}`.slice(0, 200),
    body: [
      `**What failed:** ${report.marketplace} ${report.job.type}`,
      `**Error:** ${report.error}`,
      `**When:** ${report.at} · **Version:** ${report.version} · **Mode:** ${report.mode} · **Recorded requests:** ${report.exchanges.length}`,
      note ? `**Note from the seller:** ${note}` : "",
      "",
      "Reproduce: save the JSON below as `report.json`, then `npx tsx scripts/replay.ts report.json`.",
      "",
      "<details><summary>Problem report (no tokens, notes, bins or buyer details)</summary>",
      "",
      "```json",
      json.length > 55_000 ? json.slice(0, 55_000) + "\n…(cut)" : json,
      "```",
      "</details>",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}
