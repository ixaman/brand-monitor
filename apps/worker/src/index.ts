import { Pool } from 'pg';
import { RedisConnection } from 'bullmq';
import { Redis } from 'ioredis';
const db = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
const client = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const redis = new RedisConnection(client);
await db.query('SELECT 1');
await client.ping();
console.log(JSON.stringify({ level: 'info', message: 'Worker ready; no slice 0 jobs registered' }));
const heartbeat = setInterval(() => {}, 60_000);
async function shutdown() { clearInterval(heartbeat); await redis.close(); await db.end(); }
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
