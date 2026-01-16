const minLength = 16;
const weakValues = new Set([
  "password",
  "secretpassword",
  "postgres",
  "admin",
  "root"
]);

function fail(msg) {
  console.error(`[check-env] ${msg}`);
  process.exit(1);
}

const databaseUrl = (process.env.DATABASE_URL || "").trim();
const pgPassword = (process.env.POSTGRES_PASSWORD || "").trim();

// If DATABASE_URL is set, we assume it contains credentials and skip POSTGRES_PASSWORD check.
if (!databaseUrl) {
  if (pgPassword) {
    const lower = pgPassword.toLowerCase();
    if (pgPassword.length < minLength) {
      fail(`POSTGRES_PASSWORD is too short (min ${minLength} chars).`);
    }
    if (weakValues.has(lower)) {
      fail("POSTGRES_PASSWORD is too weak (common/default password).");
    }
  }
}
