import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
export async function migrate(pool: Pool, down = false) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(730001)");
  await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = (await client.query("SELECT 1 FROM public.schema_migrations WHERE version = '000_slice0'")).rowCount;
  if (down && applied) {
   await client.query(await readFile(new URL('../db/migrations/000_slice0.down.sql', import.meta.url), 'utf8'));
   await client.query("DELETE FROM public.schema_migrations WHERE version = '000_slice0'");
  } else if (!down && !applied) {
   await client.query(await readFile(new URL('../db/migrations/000_slice0.up.sql', import.meta.url), 'utf8'));
   await client.query("INSERT INTO public.schema_migrations(version) VALUES ('000_slice0')");
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
