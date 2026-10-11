import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { processNextDetection } from '../../../packages/domain/src/site-store';
import { detectSite } from '../../../packages/domain/src/site-detection';
import { politeFetcher } from '../../../packages/domain/src/polite-http';
import { enqueueSitePreviews, processNextArticle } from '../../../packages/domain/src/article-store';
const db = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
await db.query('SELECT 1');
await redis.ping();
console.log(JSON.stringify({level:'info',message:'Worker ready for site detection and article processing'}));
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
const fetchPage=politeFetcher(db,{delayMs:Number(process.env.SITE_REQUEST_DELAY_MS ?? 1000),timeoutMs:Number(process.env.ARTICLE_TIMEOUT_MS ?? 15000)});
try {
 while (!stop.signal.aborted) {
  try {
   const detected = await processNextDetection(db,input => detectSite(input,fetchPage,{signal:stop.signal}));
   await enqueueSitePreviews(db);
   const processed=await processNextArticle(db,fetchPage,stop.signal);
   if (!processed && !detected) await new Promise(resolve => setTimeout(resolve,1000));
  } catch (error) {
   console.error(JSON.stringify({level:'error',message:'Worker processing failed',error:(error as Error).message}));
   await new Promise(resolve => setTimeout(resolve,1000));
  }
 }
} finally { await redis.quit(); await db.end(); }
