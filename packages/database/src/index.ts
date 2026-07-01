import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(dbUrl: string) {
  const client = postgres(dbUrl);
  return drizzle(client, { schema });
}
