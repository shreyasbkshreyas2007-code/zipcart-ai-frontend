const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("./db");

async function migrate() {
  if (!db.enabled) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const directory = path.join(__dirname, "migrations");
  const filenames = (await fs.readdir(directory))
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort();

  for (const filename of filenames) {
    const existing = await db.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename]
    );
    if (existing.rowCount) continue;

    const sql = await fs.readFile(path.join(directory, filename), "utf8");
    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename]
      );
    });
    console.log(`Applied database migration ${filename}`);
  }
}

if (require.main === module) {
  migrate()
    .catch((error) => {
      console.error("Database migration failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { migrate };
