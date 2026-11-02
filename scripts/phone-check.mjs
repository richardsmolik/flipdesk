/**
 * Phone check: opens every screen at iPhone size (390x844) in the sample shop and reports anything wider
 * than the screen (sideways scrolling) and tap targets smaller than 32px. Needs a running server.
 * Usage: node scripts/phone-check.mjs http://localhost:8787 [screenshot-folder]
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const B = process.argv[2] ?? "http://localhost:8787";
const OUT = process.argv[3];
const ROUTES = ["/", "/inbox", "/items/new", "/shoot", "/bulk", "/inventory", "/inventory?view=sold", "/bundles", "/source", "/mileage", "/shipping", "/bins", "/sales", "/reports", "/tools", "/queue", "/status", "/help", "/connections", "/switch", "/settings", "/launch", "/items/1"];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await p.goto(B + "/");
await p.evaluate(() => fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "enter_demo" }) }));
let problems = 0;
for (const r of ROUTES) {
  await p.goto(B + r);
  await p.waitForTimeout(900);
  const res = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [];
    for (const el of document.querySelectorAll("body *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > vw + 1) {
        // only report the outermost offender (skip children of an already-reported element and anything inside a scroll box)
        let scroller = false;
        for (let a = el.parentElement; a; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth) scroller = true;
        if (!scroller && !wide.some((w) => w.el.contains(el))) wide.push({ el, desc: `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 3).join(".") : ""} (${Math.round(rect.right)}px)`, text: (el.textContent || "").trim().slice(0, 40) });
      }
    }
    const small = [...document.querySelectorAll("button, a, input, select")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 24 && getComputedStyle(el).visibility !== "hidden";
    }).length;
    return { scroll: document.documentElement.scrollWidth > vw + 1, sw: document.documentElement.scrollWidth, vw, wide: wide.slice(0, 5).map((w) => `${w.desc} "${w.text}"`), small };
  });
  const bad = res.scroll || res.wide.length;
  if (bad) problems++;
  console.log(`${bad ? "✕" : "✓"} ${r.padEnd(22)} ${res.scroll ? `page ${res.sw}px wide` : "fits"}${res.small ? ` · ${res.small} small tap targets` : ""}`);
  for (const w of res.wide) console.log(`    ↳ ${w}`);
  if (OUT) await p.screenshot({ path: `${OUT}/${r.replace(/[^\w]+/g, "_") || "home"}.png`, fullPage: false });
}
console.log(`\n${problems} screen(s) wider than the phone. ${errors.length ? `Errors: ${[...new Set(errors)].slice(0, 5).join(" | ")}` : "No page errors."}`);
await b.close();
process.exitCode = problems || errors.length ? 1 : 0; // fail CI on sideways scrolling or page errors
