/** Demo data: `npm run seed` (wipes data/flipdesk.db). */
import fs from "node:fs";
import { openDb } from "./db.js";
import { seedDemo } from "./demo.js";

const DB = process.env.FLIPDESK_DB ?? "data/flipdesk.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(DB);
const n = await seedDemo(db, process.env.FLIPDESK_UPLOADS ?? "data/uploads");
console.log(`Seeded ${n} items into ${DB}`);
