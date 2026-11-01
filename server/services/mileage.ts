/**
 * Mileage log for sourcing / post office / supply runs.
 * Each trip creates a "mileage" expense at your rate (default: IRS standard business rate - update it every January).
 * The IRS wants date, destination, business purpose and miles for each trip; the CSV export has exactly that.
 */
import { getSetting, logActivity, tx, type Db } from "../db.js";

export interface MileageSettings {
  rate?: number; // $ per mile
}

export const DEFAULT_RATE = 0.7; // IRS 2025 standard business rate; set the current year's rate in Settings

export function mileageRate(db: Db) {
  return getSetting<MileageSettings>(db, "mileage", {}).rate ?? DEFAULT_RATE;
}

export function savePlace(db: Db, name: string, roundTripMiles: number) {
  db.prepare("INSERT INTO places (name, round_trip_miles) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET round_trip_miles = excluded.round_trip_miles").run(name.trim(), roundTripMiles);
}

export interface TripInput {
  date?: string;
  place: string;
  purpose?: string;
  miles?: number;
  odometerStart?: number;
  odometerEnd?: number;
  note?: string;
  remember?: boolean; // save the place + miles for one-tap next time
}

export function logTrip(db: Db, t: TripInput) {
  const place = t.place.trim();
  const saved = db.prepare("SELECT round_trip_miles FROM places WHERE name = ?").get(place) as { round_trip_miles: number } | undefined;
  const miles =
    t.miles ?? (t.odometerStart !== undefined && t.odometerEnd !== undefined ? t.odometerEnd - t.odometerStart : saved?.round_trip_miles);
  if (!miles || miles <= 0) throw new Error("Enter the miles (or odometer start and end) for this trip.");
  if (miles > 1000) throw new Error("That's over 1,000 miles - double-check the number.");
  const rate = mileageRate(db);
  const amount = Math.round(miles * rate * 100) / 100;
  const purpose = t.purpose || "sourcing";
  return tx(db, () => {
    const date = t.date ?? new Date().toISOString().slice(0, 10);
    const expenseId = Number(
      db
        .prepare("INSERT INTO expenses (date, category, amount, note) VALUES (?, 'mileage', ?, ?)")
        .run(date, amount, `${Math.round(miles * 10) / 10} mi - ${purpose} - ${place}${t.note ? ` (${t.note})` : ""}`).lastInsertRowid,
    );
    const id = Number(
      db
        .prepare("INSERT INTO trips (date, place, purpose, miles, rate, amount, odometer_start, odometer_end, note, expense_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(date, place, purpose, miles, rate, amount, t.odometerStart ?? null, t.odometerEnd ?? null, t.note ?? "", expenseId).lastInsertRowid,
    );
    if (t.remember && !t.odometerStart) savePlace(db, place, miles);
    logActivity(db, "mileage", `Logged ${Math.round(miles * 10) / 10} mi to ${place} ($${amount.toFixed(2)} deduction)`);
    return { id, miles, rate, amount };
  });
}

export function deleteTrip(db: Db, id: number) {
  const t = db.prepare("SELECT expense_id FROM trips WHERE id = ?").get(id) as { expense_id: number | null } | undefined;
  if (!t) return;
  tx(db, () => {
    db.prepare("DELETE FROM trips WHERE id = ?").run(id);
    if (t.expense_id) db.prepare("DELETE FROM expenses WHERE id = ?").run(t.expense_id);
  });
}

export function mileageSummary(db: Db, year = new Date().getFullYear()) {
  const y = String(year);
  const tot = db.prepare("SELECT COUNT(*) AS trips, COALESCE(SUM(miles),0) AS miles, COALESCE(SUM(amount),0) AS amount FROM trips WHERE strftime('%Y', date) = ?").get(y) as { trips: number; miles: number; amount: number };
  const byPlace = db
    .prepare("SELECT place, COUNT(*) AS trips, ROUND(SUM(miles),1) AS miles, ROUND(SUM(amount),2) AS amount FROM trips WHERE strftime('%Y', date) = ? GROUP BY place ORDER BY amount DESC")
    .all(y);
  return { year, rate: mileageRate(db), ...tot, miles: Math.round(tot.miles * 10) / 10, amount: Math.round(tot.amount * 100) / 100, byPlace };
}
