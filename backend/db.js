require("dotenv").config();

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      ...(process.env.PG_SSL === "true"
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
    })
  : null;

async function query(text, values) {
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  return pool.query(text, values);
}

async function transaction(run) {
  if (!pool) throw new Error("DATABASE_URL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  close,
  enabled: Boolean(pool),
  pool,
  query,
  transaction,
};
