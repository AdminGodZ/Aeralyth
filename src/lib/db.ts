import { Pool, type QueryResultRow } from "pg";

let pool: Pool | null = null;

const localDatabaseUrl =
  "postgres://aeralyth:aeralyth@127.0.0.1:5432/aeralyth";

function getConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (process.env.NODE_ENV !== "production") {
    return localDatabaseUrl;
  }

  throw new Error("DATABASE_URL is required for Aeralyth database access.");
}

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: getConnectionString() });
  }

  return pool;
}

export function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
) {
  return getPool().query<T>(text, params);
}
