import { execSync } from "node:child_process";
import pg from "pg";
import { testDbUrl } from "./helpers.js";

/** Create the dedicated test database if needed and apply migrations (never `db push`). */
export default async function setup() {
  const url = testDbUrl();
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  admin.search = "";
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Test database server unreachable (start it with \`docker compose up -d postgres\`): ${(err as Error).message}`);
  }
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  await client.end();
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
