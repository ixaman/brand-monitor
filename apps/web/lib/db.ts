import { Pool } from 'pg';
const globalDb = globalThis as unknown as { monitorPool?: Pool };
export const db = globalDb.monitorPool ?? new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC -c search_path=monitor,public' });
if (process.env.NODE_ENV !== 'production') globalDb.monitorPool = db;
