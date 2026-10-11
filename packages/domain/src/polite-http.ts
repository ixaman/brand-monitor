import type { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSafeFetcher } from './safe-http';

// Session locks cover every HTTP hop, including redirects, across worker processes.
// Keeping the lock during the delay also spaces the next process's request.
export function politeFetcher(pool: Pool, options: { delayMs?: number; timeoutMs?: number } = {}) {
 const timeout=options.timeoutMs ?? 15_000;
 if(!Number.isFinite(timeout) || timeout<=0 || timeout>60000) throw new Error('HTTP timeout must be 1–60000 ms.');
 return createSafeFetcher({timeoutMs:timeout,beforeRequest:siteRequestGate(pool,options.delayMs)});
}
export function siteRequestGate(pool:Pool, delayMs=1000) {
 const delay = delayMs;
 if (!Number.isFinite(delay) || delay < 0 || delay > 60_000) throw new Error('Site delay must be 0–60000 ms.');
 return async (url:string,signal:AbortSignal) => {
  const host = new URL(url).hostname.replace(/^(?:www|m|mobile|amp)\./i,'');
  const connection = await pool.connect();
  let locked = false;
  try {
   while (!locked) {
    signal.throwIfAborted();
    locked = (await connection.query('SELECT pg_try_advisory_lock(730003,hashtext($1)) AS locked',[host])).rows[0].locked;
    if (!locked) await sleep(50,undefined,{signal});
   }
  } catch (error) { connection.release(); throw error; }
  return async () => {
   try {
    if (delay) await sleep(delay);
    await connection.query('SELECT pg_advisory_unlock(730003,hashtext($1))',[host]);
   } finally { connection.release(); }
  };
 };
}
