import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { enqueueArticleLinks, processNextArticle } from '../../packages/domain/src/article-store';
import { MAX_SITE_CANDIDATES_PER_SCAN } from '../../packages/domain/src/article-candidates';
import type { ArticleDiscovery } from '../../packages/domain/src/article-collection';

test('article queue filters navigation, bounds new identities, skips known listings and consumes newest evidence first',async()=> {
 const operator=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
 const databaseName=`article_queue_test_${crypto.randomUUID().replaceAll('-','')}`;
 await operator.query(`CREATE DATABASE ${databaseName}`);
 const migrationUrl=new URL(process.env.MIGRATION_DATABASE_URL!);migrationUrl.pathname='/'+databaseName;
 const runtimeUrl=new URL(process.env.DATABASE_URL!);runtimeUrl.pathname='/'+databaseName;
 const admin=new Pool({connectionString:migrationUrl.toString()}),runtime=new Pool({connectionString:runtimeUrl.toString(),options:'-c timezone=UTC'});
 try {
  await migrate(admin);
  const user=(await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES('queue@example.com','analyst','active',now()) RETURNING id")).rows[0].id;
  const base='https://queue.example.com';
  const site=(await runtime.query("INSERT INTO monitor.watched_sites(name,url,created_by,method,detection_status) VALUES('Queue publisher',$1,$2,'listing','ready') RETURNING id",[base,user])).rows[0].id;
  const clock=new Date('2026-10-12T06:00:00Z');
  const discovery=(path:string,published:string|null=null,discoveredAt=clock,source:ArticleDiscovery['source']='rss'):ArticleDiscovery=>({
   url:base+path,source,discoveredAt,dateEvidence:published?[{raw:published,source:source==='sitemap'?'news-sitemap':'feed',observedAt:clock}]:[],
  });
  await enqueueArticleLinks(runtime,site,['/','/index.html','/category/national','/category/deeper','/category/section-0','/tag/brand','/archive/2026','/print/123','/search?q=brand','/latest','/page/2'].map(path=>discovery(path)));
  assert.equal((await runtime.query('SELECT id FROM monitor.article_candidates')).rowCount,0);
  const flood=Array.from({length:MAX_SITE_CANDIDATES_PER_SCAN+20},(_,index)=>discovery(`/flood-${index}`,new Date(clock.getTime()-index*1000).toISOString()));
  await enqueueArticleLinks(runtime,site,flood.reverse());
  const accepted=(await runtime.query('SELECT url FROM monitor.article_candidates')).rows.map(row=>row.url);
  assert.equal(accepted.length,MAX_SITE_CANDIDATES_PER_SCAN);
  assert.ok(accepted.includes(`${base}/flood-0`));
  assert.ok(accepted.includes(`${base}/flood-${MAX_SITE_CANDIDATES_PER_SCAN-1}`));
  assert.ok(!accepted.includes(`${base}/flood-${MAX_SITE_CANDIDATES_PER_SCAN}`));
  await enqueueArticleLinks(runtime,site,[discovery('/flood-0',null,clock,'listing')]);
  assert.equal((await runtime.query("SELECT id FROM monitor.article_candidates WHERE source='listing'")).rowCount,0);
  await runtime.query('DELETE FROM monitor.article_candidates');

  const published='2026-10-12T05:00:00';
  await enqueueArticleLinks(runtime,site,[
   discovery('/unknown-older',null,new Date('2026-10-12T05:00:00Z')),
   discovery('/publication-older',`${published}.000001Z`,new Date('2026-10-12T06:00:00Z')),
   discovery('/publication-newest',`${published}.000002Z`,new Date('2026-10-12T04:00:00Z')),
   discovery('/publication-tie-older',`${published}.000002Z`,new Date('2026-10-12T03:00:00Z')),
   discovery('/unknown-newer',null,new Date('2026-10-12T05:30:00Z')),
  ]);
  // PostgreSQL retains discoveries finer than JavaScript Date; they break publication ties.
  await runtime.query("UPDATE monitor.article_candidates SET discovered_at='2026-10-12T04:00:00.000001Z' WHERE url=$1",[`${base}/publication-newest`]);
  await runtime.query("UPDATE monitor.article_candidates SET discovered_at='2026-10-12T04:00:00.000002Z' WHERE url=$1",[`${base}/publication-tie-older`]);
  const processed:string[]=[];
  const fetcher=async(url:string)=> {
   processed.push(new URL(url).pathname);
   return {url,body:'<article><h1>Queue article</h1><p>This is a complete and readable article about local developments. It contains enough text for extraction and stores a reusable publisher identity for the queue regression.</p></article>',contentType:'text/html'};
  };
  while(await processNextArticle(runtime,fetcher)){}
  assert.deepEqual(processed,['/publication-tie-older','/publication-newest','/publication-older','/unknown-newer','/unknown-older']);
  const repeated=discovery('/publication-newest',`${published}.000002Z`,new Date(clock.getTime()+60000));
  repeated.dateEvidence[0].observedAt=repeated.discoveredAt;
  await enqueueArticleLinks(runtime,site,[repeated]);
  assert.equal((await runtime.query('SELECT status FROM monitor.article_candidates WHERE url=$1',[repeated.url])).rows[0].status,'done');
  assert.equal(await processNextArticle(runtime,async()=>{throw new Error('Unchanged evidence must preserve its first clock');}),false);
  const known=(await runtime.query('SELECT id FROM monitor.articles WHERE canonical_url=$1',[`${base}/publication-newest`])).rows[0].id;
  await runtime.query('INSERT INTO monitor.article_urls(url,article_id) VALUES($1,$2)',[`${base}/known-alias`,known]);
  await enqueueArticleLinks(runtime,site,[discovery('/known-alias',null,clock,'listing')]);
  assert.equal((await runtime.query('SELECT id FROM monitor.article_candidates WHERE url=$1',[`${base}/known-alias`])).rowCount,0);
  // Feed provenance is kept without creating work for an already stored article.
  await enqueueArticleLinks(runtime,site,[discovery('/known-alias',null,clock,'sitemap')]);
  const provenance=(await runtime.query('SELECT status,article_id FROM monitor.article_candidates WHERE url=$1',[`${base}/known-alias`])).rows[0];
  assert.equal(provenance.status,'done');assert.equal(provenance.article_id,known);
  assert.equal(await processNextArticle(runtime,async()=>{throw new Error('Known identities must reuse stored articles');}),false);
  // Old bad queue records are diagnosed rather than fetched on the next drain.
  await runtime.query("INSERT INTO monitor.article_candidates(site_id,url,fetch_url,source,discovered_at) VALUES($1,$2,$2,'rss',now())",[site,base+'/category/old']);
  assert.equal(await processNextArticle(runtime,async()=>{throw new Error('Category pages must never be fetched');}),false);
  assert.equal((await runtime.query('SELECT status FROM monitor.article_candidates WHERE url=$1',[base+'/category/old'])).rows[0].status,'error');
 } finally {
  await runtime.end();await admin.end();await operator.query(`DROP DATABASE ${databaseName}`);await operator.end();
 }
});
