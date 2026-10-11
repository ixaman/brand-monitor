import { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { politeFetcher } from '../packages/domain/src/polite-http';
import { collectArticleLinks } from '../packages/domain/src/article-collection';
import { enqueueArticleLinks, enqueueSitePreviews, processNextArticle, rematchStoredArticles } from '../packages/domain/src/article-store';
const db=new Pool({connectionString:process.env.DATABASE_URL,options:'-c timezone=UTC'});
const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
try {
 if(process.argv.includes('--rematch')) {
  console.log(JSON.stringify({rematched:await rematchStoredArticles(db)}));
 } else {
  const siteArg=process.argv.indexOf('--site'), siteId=siteArg>=0?process.argv[siteArg+1]:null;
  if(siteArg>=0 && !/^[0-9a-f-]{36}$/i.test(siteId??'')) throw new Error('--site requires a watched-site UUID.');
  const fetchPage=politeFetcher(db,{delayMs:Number(process.env.SITE_REQUEST_DELAY_MS ?? 1000),timeoutMs:Number(process.env.ARTICLE_TIMEOUT_MS ?? 15000)});
  if(process.argv.includes('--retry-errors')) await db.query("UPDATE monitor.article_candidates SET status='queued',error=NULL WHERE status='error' AND ($1::uuid IS NULL OR site_id=$1)",[siteId]);
  await enqueueSitePreviews(db);
  const sites=(await db.query("SELECT * FROM monitor.watched_sites WHERE active AND detection_status='ready' AND method IN ('rss','sitemap') AND ($1::uuid IS NULL OR id=$1)",[siteId])).rows;
  for(const site of sites) {
   site.endpoints=(await db.query('SELECT kind,url FROM monitor.site_endpoints WHERE site_id=$1',[site.id])).rows;
   try {
    const links=await collectArticleLinks(site,fetchPage,stop.signal);await enqueueArticleLinks(db,site.id,links);
    console.log(JSON.stringify({site_id:site.id,discovered:links.length}));
   } catch(error) {process.exitCode=1;console.error(JSON.stringify({site_id:site.id,error:(error as Error).message}));}
  }
  while(!stop.signal.aborted) {
   if(await processNextArticle(db,fetchPage,stop.signal)) continue;
   const pending=(await db.query("SELECT count(*)::int AS count FROM monitor.article_candidates d JOIN monitor.watched_sites s ON s.id=d.site_id WHERE d.status IN ('queued','processing') AND s.active")).rows[0].count;
   if(!pending) break;await sleep(200);
  }
  const totals=(await db.query('SELECT status,count(*)::int AS count FROM monitor.article_candidates GROUP BY status ORDER BY status')).rows;
  if(totals.some(row=>row.status==='error' && row.count))process.exitCode=1;
  console.log(JSON.stringify({candidates:totals}));
 }
}finally{await db.end();}
