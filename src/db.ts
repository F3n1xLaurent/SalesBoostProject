import { PrismaClient } from '@prisma/client';

// Keep the module tiny so tsx watch restarts cleanly after Prisma client regeneration.
// SQLite permits only one writer. Prisma otherwise creates a CPU-sized pool,
// which lets background schedulers contend with each other for the same file
// and surfaces SQLITE_BUSY as misleading query timeouts.
function runtimeDatabaseUrl(value: string | undefined): string | undefined {
  if (!value?.startsWith('file:')) return value;
  const [path, query = ''] = value.split('?', 2);
  const params = new URLSearchParams(query);
  if (!params.has('connection_limit')) params.set('connection_limit', '1');
  return `${path}?${params.toString()}`;
}

const databaseUrl = runtimeDatabaseUrl(process.env.DATABASE_URL);

export const prisma = new PrismaClient(databaseUrl
  ? { datasources: { db: { url: databaseUrl } } }
  : undefined);
