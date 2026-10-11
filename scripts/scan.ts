import { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { politeFetcher } from '../packages/domain/src/polite-http';
import { collectArticleLinks } from '../packages/domain/src/article-collection';
import type { ArticleDiscovery } from '../packages/domain/src/article-collection';
import type { Endpoint } from '../packages/domain/src/site-detection';
import { enqueueArticleLinks, processNextArticle, rematchStoredArticles } from '../packages/domain/src/article-store';
import { canonicalizeArticleUrl } from '../packages/domain/src/article-urls';

export type ScanSite = { id: string; url: string; method: string; source_timezone?: string; listing_url?:string|null;scan_depth?:number };
export type SiteScanResult = {
 site_id: string;
 url: string;
 status: 'ok' | 'error';
 discovered: number;
 error: string | null;
 diagnostics: string[];
};
export type CandidateTotal = { status: string; count: number };
export type SiteScanDependencies = {
 loadEndpoints: (site: ScanSite) => Promise<Endpoint[]>;
 collectLinks: (site: ScanSite & { endpoints: Endpoint[] }, diagnostics: string[]) => Promise<ArticleDiscovery[]>;
 enqueueLinks: (siteId: string, links: ArticleDiscovery[]) => Promise<void>;
 persistDiagnostics: (siteId: string, diagnostics: string[]) => Promise<void>;
 candidateTotals: () => Promise<CandidateTotal[]>;
};

/** Current site outcomes decide success; retained candidate history is informational. */
export async function runSiteScans(sites: ScanSite[], dependencies: SiteScanDependencies) {
 const results: SiteScanResult[]=[];
 for(const site of sites) {
  const diagnostics:string[]=[];
  const result:SiteScanResult={site_id:site.id,url:site.url,status:'error',discovered:0,error:null,diagnostics};
  try {
   const endpoints=await dependencies.loadEndpoints(site);
   const links=await dependencies.collectLinks({...site,endpoints},diagnostics);
   result.discovered=links.length;
   await dependencies.enqueueLinks(site.id,links);
   await dependencies.persistDiagnostics(site.id,diagnostics);
   result.status='ok';
  } catch(error) {
   result.error=error instanceof Error?error.message:String(error);
  }
  results.push(result);
 }
 let candidates:CandidateTotal[]=[],candidateError:string|null=null;
 try {candidates=await dependencies.candidateTotals();}
 catch(error) {
  if(!results.length)throw error;
  candidateError=error instanceof Error?error.message:String(error);
 }
 const exitCode:0|1=results.length>0 && results.every(site=>site.status==='error')?1:0;
 return {sites:results,candidates,exitCode,...(candidateError!==null?{candidate_error:candidateError}:{})};
}

/** Refresh active source/listing configuration and drain the durable shared queue. */
export async function scanConfiguredSites(db:Pool,fetchPage:Parameters<typeof collectArticleLinks>[1],signal=new AbortController().signal,siteId:string|null=null) {
 const sites=(await db.query<ScanSite>(`SELECT id,url,method,source_timezone,listing_url,scan_depth FROM monitor.watched_sites s
  WHERE active AND ((detection_status='ready' AND method IN ('rss','sitemap','listing')) OR listing_url IS NOT NULL
   OR EXISTS(SELECT 1 FROM monitor.site_endpoints e WHERE e.site_id=s.id AND e.kind='listing'))
  AND ($1::uuid IS NULL OR id=$1)`,[siteId])).rows;
 return runSiteScans(sites,{
  loadEndpoints:async site=>(await db.query<Endpoint>('SELECT kind,url FROM monitor.site_endpoints WHERE site_id=$1',[site.id])).rows,
  collectLinks:async(site,diagnostics)=>{
   const origin=new URL(canonicalizeArticleUrl(site.url)).origin;
   const known=(await db.query<{url:string}>(`SELECT url FROM monitor.article_candidates WHERE site_id=$1
    UNION SELECT url FROM monitor.article_urls WHERE starts_with(url,$2)`,[site.id,origin+'/'])).rows;
   return collectArticleLinks(site,fetchPage,signal,{diagnostics,knownUrls:known.map(row=>row.url)});
  },
  enqueueLinks:(id,links)=>enqueueArticleLinks(db,id,links),
  persistDiagnostics:async(id,diagnostics)=>{
   await db.query(`UPDATE monitor.watched_sites SET diagnostics=(
    SELECT COALESCE(jsonb_agg(DISTINCT item),'[]'::jsonb)
    FROM jsonb_array_elements(diagnostics) item WHERE item #>> '{}' NOT LIKE '[scan] %'
   ) || $2::jsonb WHERE id=$1`,[id,JSON.stringify(diagnostics.map(message=>`[scan] ${message}`))]);
  },
  candidateTotals:async()=>{
   while(!signal.aborted) {
    if(await processNextArticle(db,fetchPage,signal))continue;
    const pending=(await db.query("SELECT count(*)::int AS count FROM monitor.article_candidates d JOIN monitor.watched_sites s ON s.id=d.site_id WHERE d.status IN ('queued','processing') AND s.active")).rows[0].count;
    if(!pending)break;await sleep(200);
   }
   return (await db.query<CandidateTotal>('SELECT status,count(*)::int AS count FROM monitor.article_candidates GROUP BY status ORDER BY status')).rows;
  },
 });
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
 const db=new Pool({connectionString:process.env.DATABASE_URL,options:'-c timezone=UTC'});
 const stop=new AbortController(),interrupt=()=>stop.abort();
 process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 try {
  if(process.argv.includes('--rematch')) {
   console.log(JSON.stringify({rematched:await rematchStoredArticles(db)}));
  } else {
   const siteArg=process.argv.indexOf('--site'),siteId=siteArg>=0?process.argv[siteArg+1]:null;
   if(siteArg>=0 && !/^[0-9a-f-]{36}$/i.test(siteId??''))throw new Error('--site requires a watched-site UUID.');
   const fetchPage=politeFetcher(db,{delayMs:Number(process.env.SITE_REQUEST_DELAY_MS ?? 1000),timeoutMs:Number(process.env.ARTICLE_TIMEOUT_MS ?? 15000)});
   if(process.argv.includes('--retry-errors'))await db.query("UPDATE monitor.article_candidates SET status='queued',error=NULL WHERE status='error' AND ($1::uuid IS NULL OR site_id=$1)",[siteId]);
   const summary=await scanConfiguredSites(db,fetchPage,stop.signal,siteId);
   console.log(JSON.stringify(summary));process.exitCode=summary.exitCode;
  }
 } catch(error) {
  console.error(JSON.stringify({status:'error',error:error instanceof Error?error.message:String(error)}));
  process.exitCode=1;
 } finally {
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  await db.end();
 }
}
