import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { processNextDetection } from '../../../packages/domain/src/site-store';
import { detectSite } from '../../../packages/domain/src/site-detection';
const db = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
await db.query('SELECT 1');
await redis.ping();
console.log(JSON.stringify({level:'info',message:'Worker ready for site detection'}));
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
 while (!stop.signal.aborted) {
  try {
   const processed = await processNextDetection(db,input => detectSite(input,undefined,{signal:stop.signal}));
   if (!processed) await new Promise(resolve => setTimeout(resolve,1000));
  } catch (error) {
   console.error(JSON.stringify({level:'error',message:'Site detection processing failed',error:(error as Error).message}));
   await new Promise(resolve => setTimeout(resolve,1000));
  }
 }
} finally { await redis.quit(); await db.end(); }
