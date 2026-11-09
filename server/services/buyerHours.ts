/**
 * Send edits when buyers are browsing. From your own sales (the hour of day each sold, in your time zone)
 * FlipDesk finds the 8 quietest hours in a row; edits made then wait and go out when the quiet hours end.
 * With fewer than 20 sales it uses 11pm-7am.
 */
import type { Db } from "../db.js";
import { getSetting } from "../db.js";
import { timezoneOf } from "./goals.js";

const MIN_SALES = 20;
const QUIET_LEN = 8;

export function localHour(d: Date, tz: string) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d));
  return Number.isFinite(h) ? h % 24 : d.getUTCHours();
}

export const buyerHoursOn = (db: Db) => Boolean(getSetting<{ buyerHours?: boolean }>(db, "autoPush", {}).buyerHours);

export function buyerHours(db: Db) {
  const tz = timezoneOf(db);
  const rows = db.prepare("SELECT sold_at FROM sales WHERE sold_at >= datetime('now','-365 days')").all() as { sold_at: string }[];
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const r of rows) byHour[localHour(new Date(r.sold_at.includes("T") ? r.sold_at : r.sold_at.replace(" ", "T") + "Z"), tz)]++;
  const learned = rows.length >= MIN_SALES;
  let quietStart = 23;
  if (learned) {
    let best = Infinity;
    for (let s = 0; s < 24; s++) {
      let n = 0;
      for (let k = 0; k < QUIET_LEN; k++) n += byHour[(s + k) % 24];
      // ties: prefer the window closest to overnight
      const night = Math.abs(((s + QUIET_LEN / 2) % 24) - 3);
      if (n < best || (n === best && night < Math.abs(((quietStart + QUIET_LEN / 2) % 24) - 3))) (best = n), (quietStart = s);
    }
  }
  const quietEnd = (quietStart + QUIET_LEN) % 24;
  const busiest = learned ? byHour.indexOf(Math.max(...byHour)) : null;
  return { timezone: tz, learned, sales: rows.length, needed: MIN_SALES, quietStart, quietEnd, busiestHour: busiest, byHour };
}

const inQuiet = (h: number, start: number, end: number) => (start < end ? h >= start && h < end : h >= start || h < end);

/** When an edit made at `from` should go out: right then, or when the quiet hours end. */
export function nextBuyerTime(db: Db, from = new Date()) {
  const b = buyerHours(db);
  if (!inQuiet(localHour(from, b.timezone), b.quietStart, b.quietEnd)) return from;
  let t = new Date(Math.ceil(from.getTime() / 900_000) * 900_000); // step in 15 minutes (works for half-hour time zones)
  for (let i = 0; i < 100 && inQuiet(localHour(t, b.timezone), b.quietStart, b.quietEnd); i++) t = new Date(t.getTime() + 900_000);
  return t;
}

export const hourLabel = (h: number) => (h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`);
