import { resolve } from "node:path";
import { rebuildDatabase } from "../apps/server/src/db/database";

const args = Bun.argv.slice(2);
const confirmed = args.includes("--yes");
const paths = args.filter((argument) => argument !== "--yes");

if (!confirmed || paths.length !== 1 || !paths[0]?.trim() || paths[0] === ":memory:") {
  console.error("Usage: bun scripts/rebuild-database.ts <database-file> --yes");
  console.error("This permanently removes all existing data from the specified Flint SQLite database.");
  process.exit(1);
}

const databasePath = resolve(paths[0]);
const database = rebuildDatabase(databasePath, { confirmed: true });
database.close();
console.log(`Rebuilt Flint database at ${databasePath}`);
