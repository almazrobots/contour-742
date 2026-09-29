// Explicit archival operation after migrations, before bulk reprocessing.
// Capture timestamps are not processing timestamps. Never starts ML or modifies old results.
import "../entry-migrate.ts";
import { config } from "../config.ts";
import { openDb } from "../db.ts";
import { preserveHistoricalResults } from "../services/file-result-snapshots.ts";

if (process.argv.slice(2).join(" ") !== "--capture" || config.readonly) {
  console.error("Historical capture requires --capture on a writable deployment");
  process.exit(64);
}
const db = await openDb(config.databaseUrl, { mode: "verify", purpose: "migrate" });
try {
  const summary = await preserveHistoricalResults(db);
  console.log(JSON.stringify({ operation: "historical-result-capture", ...summary, processing_started: false }));
} finally {
  await db.close();
}
