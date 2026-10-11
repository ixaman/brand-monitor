import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
export async function migrate(pool: Pool, down = false) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(730001)");
  await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const versions = (await readdir(new URL('../db/migrations/', import.meta.url)))
   .filter(name => name.endsWith('.up.sql')).map(name => name.slice(0, -7)).sort();
  const applied = new Set((await client.query<{ version: string }>('SELECT version FROM public.schema_migrations')).rows.map(row => row.version));
  const pending = down ? versions.filter(version => applied.has(version)).slice(-1) : versions.filter(version => !applied.has(version));
  for (const version of pending) {
   await client.query(await readFile(new URL(`../db/migrations/${version}.${down ? 'down' : 'up'}.sql`, import.meta.url), 'utf8'));
   if (down) await client.query('DELETE FROM public.schema_migrations WHERE version=$1', [version]);
   else await client.query('INSERT INTO public.schema_migrations(version) VALUES($1)', [version]);
  }
  if (!down && process.env.RUNTIME_DB_PASSWORD) {
   const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'monitor_runtime'");
   const password = process.env.RUNTIME_DB_PASSWORD.replaceAll("'", "''");
   await client.query(`${role.rowCount ? 'ALTER' : 'CREATE'} ROLE monitor_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
   await client.query('GRANT USAGE ON SCHEMA monitor TO monitor_runtime');
   await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA monitor TO monitor_runtime');
   await client.query('REVOKE INSERT, UPDATE, DELETE ON monitor.app_users FROM monitor_runtime');
  }
  await client.query('COMMIT');
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}
if (process.argv[1]?.endsWith('migrate.ts')) {
 const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
 try { await migrate(pool, process.argv[2] === 'down'); console.log('Migration complete'); }
 finally { await pool.end(); }
}
