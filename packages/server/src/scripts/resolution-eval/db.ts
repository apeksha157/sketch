import pg from "pg";

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = "5432";

export interface DbTarget {
  spec: string;
  connectionString: string;
  databaseName: string;
}

export function isConnectionString(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function connectionStringForDbArg(spec: string, options: { readOnly?: boolean } = {}): string {
  const url = isConnectionString(spec)
    ? new URL(spec)
    : new URL(
        `postgres://${encodeURIComponent(process.env.USER ?? "")}@${DEFAULT_HOST}:${DEFAULT_PORT}/${encodeURIComponent(spec)}`,
      );
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "disable");
  if (options.readOnly) url.searchParams.set("options", "-c default_transaction_read_only=on");
  return url.toString();
}

export function dbTargetFromArg(spec: string, options: { readOnly?: boolean } = {}): DbTarget {
  const connectionString = connectionStringForDbArg(spec, options);
  const url = new URL(connectionString);
  return { spec, connectionString, databaseName: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}

export function adminConnectionStringFor(spec: string): string {
  const url = new URL(connectionStringForDbArg(spec));
  url.pathname = "/postgres";
  url.searchParams.delete("options");
  return url.toString();
}

export function connectionStringForDatabaseLike(
  spec: string,
  databaseName: string,
  options: { readOnly?: boolean } = {},
): string {
  const url = new URL(connectionStringForDbArg(spec, options));
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

export function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function createClient(spec: string, options: { readOnly?: boolean } = {}): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: connectionStringForDbArg(spec, options) });
  await client.connect();
  return client;
}

export async function withClient<T>(
  spec: string,
  options: { readOnly?: boolean },
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await createClient(spec, options);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
