import type { Pool } from 'pg';
import { parseSiteImport, siteInput, validateTimezone, normalizeSiteUrl, type ImportRow, type SiteInput } from './sites';
import { detectSite, type DetectionInput, type DetectionResult, type Endpoint, type PreviewPost } from './site-detection';
import { ValidationError } from './keywords';
export class SiteAccessError extends Error {}
export class SiteNotFoundError extends Error {}
export { ValidationError };
export type ImportResult = { line: number; input: string; status: 'Added' | 'Skipped (duplicate)' | 'Invalid'; reason: string; site_id?: string; url?: string };
export type WatchedSite = DetectionInput & { id: string; name: string; source_timezone: string; active: boolean; method: string; detection_status: string; detection_revision: number; preview: PreviewPost[]; diagnostics: string[]; detected_at: Date | null };
export async function authorizeSites(pool: Pool, userId: string, write = false) {
 const user = (await pool.query("SELECT role FROM monitor.app_users WHERE id=$1 AND state='active'",[userId])).rows[0];
 if (!user || (write && !['admin','analyst'].includes(user.role))) throw new SiteAccessError('Access denied.');
}
export async function readSites(pool: Pool, userId: string): Promise<WatchedSite[]> {
 await authorizeSites(pool,userId);
 const sites = (await pool.query('SELECT * FROM monitor.watched_sites ORDER BY created_at,id')).rows;
 const endpoints = (await pool.query('SELECT site_id,kind,url,configured FROM monitor.site_endpoints ORDER BY kind,url')).rows;
 return sites.map(site => ({...site,endpoints:endpoints.filter(endpoint => endpoint.site_id===site.id)}));
}
export async function importSiteRows(pool: Pool, userId: string, rows: ImportRow[]): Promise<ImportResult[]> {
 await authorizeSites(pool,userId,true);
 const results: ImportResult[] = [];
 for (const row of rows) {
  if (!row.site || row.error) { results.push({line:row.line,input:row.input,status:'Invalid',reason:row.error ?? 'Invalid site.'}); continue; }
  // Recheck permission on each write, including during a long import.
  await authorizeSites(pool,userId,true);
  const {name,url,listing_url} = row.site;
  const result = await pool.query(`INSERT INTO monitor.watched_sites(name,url,listing_url,created_by) VALUES($1,$2,$3,$4)
   ON CONFLICT(url) DO NOTHING RETURNING id`,[name,url,listing_url,userId]);
  if (result.rowCount) results.push({line:row.line,input:row.input,status:'Added',reason:'Saved; detection queued.',site_id:result.rows[0].id,url});
  else {
   const existing = (await pool.query('SELECT id FROM monitor.watched_sites WHERE url=$1',[url])).rows[0];
   results.push({line:row.line,input:row.input,status:'Skipped (duplicate)',reason:'Already saved or repeated in this import.',site_id:existing?.id,url});
  }
 }
 return results;
}
export async function importSites(pool: Pool, userId: string, text: string, mode: 'paste' | 'csv') {
 await authorizeSites(pool,userId,true);
 return importSiteRows(pool,userId,parseSiteImport(text,mode));
}
export async function addSite(pool: Pool, userId: string, name: string, url: string, listing = '') {
 await authorizeSites(pool,userId,true);
 let site: SiteInput;
 try { site = siteInput(name,url,listing); }
 catch (error) { return [{line:1,input:url,status:'Invalid' as const,reason:(error as Error).message}]; }
 return importSiteRows(pool,userId,[{line:1,input:url,site}]);
}
function siteId(id: string) {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid site ID.');
 return id;
}
export async function requestDetection(pool: Pool, userId: string, id: string) {
 await authorizeSites(pool,userId,true);
 siteId(id);
 const result = await pool.query(`UPDATE monitor.watched_sites SET detection_status='queued',detection_revision=detection_revision+1,detection_requested_at=now(),updated_at=now() WHERE id=$1 RETURNING id`,[id]);
 if (!result.rowCount) throw new SiteNotFoundError('Site not found.');
}
export async function configureSite(pool: Pool, userId: string, id: string, input: { name: string; source_timezone: string; scan_depth: number; active: boolean; listing_url: string; feeds: string[]; sitemaps: string[]; listings: string[] }) {
 await authorizeSites(pool,userId,true);
 siteId(id);
 const site = (await pool.query('SELECT url FROM monitor.watched_sites WHERE id=$1',[id])).rows[0];
 if (!site) throw new SiteNotFoundError('Site not found.');
 const data = siteInput(input.name,site.url,input.listing_url);
 const zone = validateTimezone(input.source_timezone.trim());
 if (!Number.isInteger(input.scan_depth) || input.scan_depth < 0 || input.scan_depth > 2) throw new ValidationError('Scan depth must be 0, 1 or 2.');
 const endpoints: Endpoint[] = [];
 for (const [kind,values] of [['rss',input.feeds],['sitemap',input.sitemaps],['listing',input.listings]] as const) {
  if (values.length>5) throw new ValidationError('Use at most five endpoints per method.');
  for (const url of [...new Set(values.map(url => normalizeSiteUrl(url)))]) endpoints.push({kind,url,configured:true});
 }
 const connection = await pool.connect();
 try {
  await connection.query('BEGIN');
  const updated = await connection.query(`UPDATE monitor.watched_sites SET name=$2,listing_url=$3,source_timezone=$4,scan_depth=$5,active=$6,
   detection_status='queued',detection_revision=detection_revision+1,detection_requested_at=now(),updated_at=now() WHERE id=$1 RETURNING id`,[id,data.name,data.listing_url,zone,input.scan_depth,input.active]);
  if (!updated.rowCount) throw new SiteNotFoundError('Site not found.');
  await connection.query('DELETE FROM monitor.site_endpoints WHERE site_id=$1',[id]);
  for (const endpoint of endpoints) await connection.query('INSERT INTO monitor.site_endpoints(site_id,kind,url,configured) VALUES($1,$2,$3,true)',[id,endpoint.kind,endpoint.url]);
  await connection.query('COMMIT');
 } catch (error) { await connection.query('ROLLBACK'); throw error; }
 finally { connection.release(); }
}
// A session advisory lock serializes discovery across worker processes. Persisted queued/detecting
// rows recover after a crash; a revision fence prevents an old result overwriting a new request.
export async function processNextDetection(pool: Pool, detect: (input: DetectionInput) => Promise<DetectionResult> = detectSite, delayMs = 750): Promise<boolean> {
 const connection = await pool.connect();
 let locked = false;
 try {
  locked = (await connection.query('SELECT pg_try_advisory_lock(730002) AS locked')).rows[0].locked;
  if (!locked) return false;
  const site = (await connection.query("SELECT * FROM monitor.watched_sites WHERE detection_status IN ('queued','detecting') ORDER BY detection_requested_at,id LIMIT 1")).rows[0];
  if (!site) return false;
  const endpoints = (await connection.query('SELECT kind,url,configured FROM monitor.site_endpoints WHERE site_id=$1',[site.id])).rows;
  await connection.query("UPDATE monitor.watched_sites SET detection_status='detecting' WHERE id=$1 AND detection_revision=$2",[site.id,site.detection_revision]);
  let result: DetectionResult;
  try { result = await detect({...site,endpoints}); }
  catch (error) { result = {method:'pending',status:'needs_attention',endpoints:[],preview:[],diagnostics:[(error as Error).message || 'Detection failed.']}; }
  await connection.query('BEGIN');
  const update = await connection.query(`UPDATE monitor.watched_sites SET method=$3,detection_status=$4,preview=$5::jsonb,diagnostics=$6::jsonb,detected_at=now(),updated_at=now()
   WHERE id=$1 AND detection_revision=$2 RETURNING id`,[site.id,site.detection_revision,result.method,result.status,JSON.stringify(result.preview),JSON.stringify(result.diagnostics)]);
  if (update.rowCount) {
   await connection.query('DELETE FROM monitor.site_endpoints WHERE site_id=$1 AND NOT configured',[site.id]);
   await connection.query('UPDATE monitor.site_endpoints SET is_primary=false WHERE site_id=$1',[site.id]);
   for (let index=0; index<result.endpoints.length; index++) {
    const endpoint = result.endpoints[index];
    await connection.query(`INSERT INTO monitor.site_endpoints(site_id,kind,url,is_primary) VALUES($1,$2,$3,$4)
     ON CONFLICT(site_id,kind,url) DO UPDATE SET is_primary=excluded.is_primary`,[site.id,endpoint.kind,endpoint.url,index===0]);
   }
  }
  await connection.query('COMMIT');
  // Hold the global lock during the gap so another process cannot bypass the delay.
  if (delayMs>0) await new Promise(resolve => setTimeout(resolve,delayMs));
  return true;
 } catch (error) { await connection.query('ROLLBACK'); throw error; }
 finally {
  try { if (locked) await connection.query('SELECT pg_advisory_unlock(730002)'); }
  finally { connection.release(); }
 }
}
