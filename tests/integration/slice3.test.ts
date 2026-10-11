import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { enqueueArticleLinks, enqueueSitePreviews, processNextArticle, readCurrentMentions, rematchStoredArticles } from '../../packages/domain/src/article-store';
import { siteRequestGate } from '../../packages/domain/src/polite-http';
import type { PageFetcher } from '../../packages/domain/src/safe-http';
import type { ArticleDiscovery } from '../../packages/domain/src/article-collection';

test('slice 3 durable processing, all clients, canonical convergence, provenance, dates, errors and rollback', async()=> {
 const operator=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
 const databaseName=`slice3_test_${crypto.randomUUID().replaceAll('-','')}`;
 await operator.query(`CREATE DATABASE ${databaseName}`);
 const migrationUrl=new URL(process.env.MIGRATION_DATABASE_URL!);migrationUrl.pathname='/'+databaseName;
 const runtimeUrl=new URL(process.env.DATABASE_URL!);runtimeUrl.pathname='/'+databaseName;
 const admin=new Pool({connectionString:migrationUrl.toString()}),runtime=new Pool({connectionString:runtimeUrl.toString(),options:'-c timezone=UTC'});
 try {
  await migrate(admin);await migrate(admin);
  const user=(await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES('slice3@example.com','analyst','active',now()) RETURNING id")).rows[0].id;
  const clients:string[]=[];
  for(const name of ['One','Two','Excluded','Inactive'])clients.push((await runtime.query('INSERT INTO monitor.clients(name,created_by,active) VALUES($1,$2,$3) RETURNING id',[name,user,name!=='Inactive'])).rows[0].id);
  const keyword=(await runtime.query("INSERT INTO monitor.keywords(client_id,term,aliases,created_by) VALUES($1,'ব্র্যান্ড',ARRAY['Brand'],$2) RETURNING id",[clients[0],user])).rows[0].id;
  await runtime.query("INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,'Brand',$2),($3,'Brand',$2),($4,'Brand',$2)",[clients[1],user,clients[2],clients[3]]);
  await runtime.query("UPDATE monitor.keywords SET exclusions=ARRAY['jobs'] WHERE client_id=$1",[clients[2]]);
  await runtime.query("INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,'launch',$2)",[clients[0],user]);
  const site=(await runtime.query("INSERT INTO monitor.watched_sites(name,url,created_by,method,detection_status,detected_at) VALUES('News','https://news.example.com',$1,'rss','ready',now()) RETURNING id",[user])).rows[0].id;
  const now=new Date(),published=new Date(now.getTime()-5*3600000).toISOString();
  const discovery=(url:string,source:ArticleDiscovery['source']='rss',dateEvidence:ArticleDiscovery['dateEvidence']=[],discoveredAt=now):ArticleDiscovery=>({url,source,dateEvidence,discoveredAt});
  const first='https://www.news.example.com/story/amp/?utm_source=feed';
  await runtime.query('UPDATE monitor.watched_sites SET preview=$2::jsonb WHERE id=$1',[site,JSON.stringify([{title:'Brand',url:first,raw_date:published,date_kind:'publication'}])]);
  await enqueueSitePreviews(runtime);await enqueueSitePreviews(runtime);
  assert.equal((await runtime.query('SELECT id FROM monitor.article_candidates')).rowCount,1);
  await enqueueArticleLinks(runtime,site,[discovery('https://m.news.example.com/story?fbclid=x','sitemap',[{raw:published,source:'news-sitemap',observedAt:now}],new Date(now.getTime()-60000))]);
  let fetches=0;
  const html=(canonical:string,date:string|null=published)=>`<html><head><link rel="canonical" href="${canonical}">${date?`<script type="application/ld+json">{"@type":"NewsArticle","headline":"Brand launch","datePublished":"${date}"}</script>`:''}</head><body><article><h1>Brand launch</h1><div class="entry-content"><p>ব্র্যান্ড launched a new service for everyone. This is the full article body with jobs news and enough readable content.</p></div></article></body></html>`;
  const fetcher:PageFetcher=async url=>{
   fetches++;assert.match(url,/^https:\/\/(?:www|m)\.news\.example\.com\/story/);
   // A rediscovery during the fetch must preserve its earlier observation clock.
   await enqueueArticleLinks(runtime,site,[discovery('https://m.news.example.com/story','sitemap',[{raw:published,source:'news-sitemap',observedAt:now}],new Date(now.getTime()-120000))]);
   await new Promise(resolve=>setTimeout(resolve,25));return {url,body:html('/story'),contentType:'text/html'};
  };
  const pair=await Promise.all([processNextArticle(runtime,fetcher),processNextArticle(runtime,fetcher)]);
  assert.ok(pair.some(Boolean));
  while(await processNextArticle(runtime,fetcher)){}
  assert.equal(fetches,1);
  const article=(await runtime.query('SELECT * FROM monitor.articles')).rows[0];
  assert.equal(article.canonical_url,'https://news.example.com/story');
  assert.equal(article.discovered_at.getTime(),now.getTime()-120000);
  assert.equal(article.published_at.toISOString(),published);assert.equal(article.date_confidence,'verified');
  assert.equal((await runtime.query('SELECT id FROM monitor.articles')).rowCount,1);
  assert.equal((await runtime.query('SELECT id FROM monitor.mentions')).rowCount,2);
  const current=await readCurrentMentions(runtime,user,clients[0]);assert.equal(current.length,1);
  assert.deepEqual(current[0].found_by.sort(),['rss','sitemap']);assert.equal(current[0].matches.length,3);
  assert.equal((await readCurrentMentions(runtime,user,clients[1])).length,1);
  assert.equal((await readCurrentMentions(runtime,user,clients[2])).length,0);
  assert.equal((await readCurrentMentions(runtime,user,clients[3])).length,0);
  // Only two rules matched the first client, with evidence from both title and body.
  assert.equal((await runtime.query('SELECT DISTINCT keyword_id FROM monitor.mention_matches mm JOIN monitor.mentions m ON m.id=mm.mention_id WHERE m.client_id=$1',[clients[0]])).rowCount,2);
  // A newly discovered alias claims an already registered alias of the stored canonical URL.
  await runtime.query('INSERT INTO monitor.article_urls(url,article_id) VALUES($1,$2)',['https://news.example.com/registered',article.id]);
  await enqueueArticleLinks(runtime,site,[discovery('https://news.example.com/another')]);
  await processNextArticle(runtime,async url=>({url,body:html('/registered'),contentType:'text/html'}));
  assert.equal((await runtime.query('SELECT id FROM monitor.articles')).rowCount,1);
  assert.equal((await runtime.query("SELECT article_id FROM monitor.article_urls WHERE url='https://news.example.com/another'")).rows[0].article_id,article.id);
  // Old dates, future dates, uncertain bounds and absent verification never qualify.
  for(const [lower,upper,confidence] of [[26,26,'verified'],[-1,-1,'verified'],[25,23,'verified'],[5,5,'unverified']] as const) {
   const anchor=Date.now(),lowerDate=new Date(anchor-lower*3600000),upperDate=new Date(anchor-upper*3600000);
   await runtime.query(`UPDATE monitor.articles SET published_at=$2,publication_lower=$3,publication_upper=$4,date_confidence=$5 WHERE id=$1`,
    [article.id,upperDate,lowerDate,upperDate,confidence]);
   assert.equal((await readCurrentMentions(runtime,user,clients[0])).length,0);
   assert.equal((await runtime.query('SELECT id FROM monitor.mentions WHERE article_id=$1',[article.id])).rowCount,2);
  }
  // Reconcile conflicting new evidence without another fetch, then retain it for review.
  await enqueueArticleLinks(runtime,site,[discovery(first,'rss',[{raw:new Date(now.getTime()-30*3600000).toISOString(),source:'feed',observedAt:now}])]);
  await processNextArticle(runtime,async()=>{throw new Error('Known articles must not be fetched twice');});
  assert.equal((await runtime.query('SELECT date_confidence FROM monitor.articles WHERE id=$1',[article.id])).rows[0].date_confidence,'unverified');
  assert.equal((await readCurrentMentions(runtime,user,clients[0])).length,0);
  // An initially undated article gains a trustworthy feed date on rediscovery.
  const undated='https://news.example.com/undated';
  await enqueueArticleLinks(runtime,site,[discovery(undated)]);
  await processNextArticle(runtime,async url=>({url,body:html('/undated',null),contentType:'text/html'}));
  assert.equal((await runtime.query('SELECT date_confidence FROM monitor.articles WHERE canonical_url=$1',[undated])).rows[0].date_confidence,'unverified');
  await enqueueArticleLinks(runtime,site,[discovery(undated,'rss',[{raw:published,source:'feed',observedAt:now}])]);
  await processNextArticle(runtime,async()=>{throw new Error('Date improvement must not refetch');});
  assert.equal((await runtime.query('SELECT date_confidence FROM monitor.articles WHERE canonical_url=$1',[undated])).rows[0].date_confidence,'verified');
  const undatedId=(await runtime.query('SELECT id FROM monitor.articles WHERE canonical_url=$1',[undated])).rows[0].id;
  // Rule edits use stored bodies; obsolete revisions cannot appear in current results.
  await runtime.query("UPDATE monitor.mentions SET status='reviewed' WHERE article_id=$1 AND client_id=$2",[undatedId,clients[0]]);
  await runtime.query("UPDATE monitor.keywords SET term='Unmatched',aliases='{}',revision=revision+1 WHERE client_id=$1",[clients[0]]);
  assert.equal((await readCurrentMentions(runtime,user,clients[0])).length,0);
  await rematchStoredArticles(runtime);
  assert.equal((await runtime.query('SELECT status FROM monitor.mentions WHERE article_id=$1 AND client_id=$2',[undatedId,clients[0]])).rows[0].status,'reviewed');
  await runtime.query("UPDATE monitor.keywords SET term='Brand',revision=revision+1 WHERE id=$1",[keyword]);await rematchStoredArticles(runtime);
  assert.equal((await readCurrentMentions(runtime,user,clients[0])).length,1);
  // A crash leaves processing work recoverable; bad content is stored with a diagnostic.
  await enqueueArticleLinks(runtime,site,[discovery('https://news.example.com/unreadable')]);
  await runtime.query("UPDATE monitor.article_candidates SET status='processing' WHERE url='https://news.example.com/unreadable'");
  await processNextArticle(runtime,async url=>({url,body:'<h1>Brand</h1><div>No article.</div>',contentType:'text/html'}));
  const unreadable=(await runtime.query("SELECT id,extraction_status FROM monitor.articles WHERE canonical_url='https://news.example.com/unreadable'")).rows[0];
  assert.equal(unreadable.extraction_status,'extraction_failed');assert.equal((await runtime.query('SELECT id FROM monitor.mentions WHERE article_id=$1',[unreadable.id])).rowCount,0);
  await enqueueArticleLinks(runtime,site,[discovery('https://news.example.com/legacy')]);
  await processNextArticle(runtime,async url=>({url,body:`<article><h1>Brand legacy</h1><div class="entry-content">Avwg evsjvq MvB RvZxq nvwmbv cÖavb †k‡` + '`' + `v‡ Avwg evsjvq MvB RvZxq nvwmbv cÖavb †k‡` + '`' + `v‡</div></article>`,contentType:'text/html'}));
  assert.equal((await runtime.query("SELECT extraction_status FROM monitor.articles WHERE canonical_url='https://news.example.com/legacy'")).rows[0].extraction_status,'encoding_problem');
  await enqueueArticleLinks(runtime,site,[discovery('https://news.example.com/failure')]);
  await processNextArticle(runtime,async()=>{throw new Error('Fixture timeout');});
  assert.equal((await runtime.query("SELECT status,error FROM monitor.article_candidates WHERE url='https://news.example.com/failure'")).rows[0].error,'Fixture timeout');
  assert.equal(await processNextArticle(runtime,fetcher),false);
  await admin.query("UPDATE monitor.app_users SET state='disabled' WHERE id=$1",[user]);
  await assert.rejects(readCurrentMentions(runtime,user,clients[0]));
  await assert.rejects(runtime.query('CREATE TABLE monitor.forbidden_slice3(id int)'),{code:'42501'});
  await migrate(admin,true);
  assert.equal((await admin.query("SELECT to_regclass('monitor.articles') AS table")).rows[0].table,null);
  assert.ok((await admin.query("SELECT to_regclass('monitor.watched_sites') AS table")).rows[0].table);
  await migrate(admin);assert.equal((await runtime.query('SELECT id FROM monitor.articles')).rowCount,0);
 }finally{
  await runtime.end();await admin.end();await operator.query(`DROP DATABASE ${databaseName}`);await operator.end();
 }
});

test('site locks serialize publisher host variants across pools, enforce gap and permit unrelated sites',async()=> {
 const first=new Pool({connectionString:process.env.DATABASE_URL}),second=new Pool({connectionString:process.env.DATABASE_URL});
 const signal=new AbortController().signal;
 try {
  const gate1=siteRequestGate(first,35),gate2=siteRequestGate(second,35);
  const release=await gate1('https://www.polite.example.com/story',signal);
  let acquired=false;
  const waiting=gate2('https://m.polite.example.com/story',signal).then(release=>{acquired=true;return release;});
  const unrelated=await gate2('https://other.example.com/story',signal);await unrelated();
  assert.equal(acquired,false);
  const start=Date.now();await release();const release2=await waiting;assert.ok(Date.now()-start>=35);await release2();
  const release3=await gate1('https://polite.example.com/story',signal);
  const aborted=new AbortController();const pending=gate2('https://amp.polite.example.com/story',aborted.signal);aborted.abort();
  await assert.rejects(pending);await release3();
 }finally{await first.end();await second.end();}
});
