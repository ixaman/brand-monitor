import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { enqueueArticleLinks, processNextArticle, readCurrentMentions } from '../../packages/domain/src/article-store';
import type { ArticleDiscovery } from '../../packages/domain/src/article-collection';
import type { PageFetcher } from '../../packages/domain/src/safe-http';

test('canonical convergence merges existing articles, provenance and client workflow atomically', async t => {
 const operator=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
 const databaseName=`article_merge_test_${crypto.randomUUID().replaceAll('-','')}`;
 await operator.query(`CREATE DATABASE ${databaseName}`);
 const migrationUrl=new URL(process.env.MIGRATION_DATABASE_URL!);migrationUrl.pathname='/'+databaseName;
 const runtimeUrl=new URL(process.env.DATABASE_URL!);runtimeUrl.pathname='/'+databaseName;
 const admin=new Pool({connectionString:migrationUrl.toString()});
 const runtime=new Pool({connectionString:runtimeUrl.toString(),options:'-c timezone=UTC'});
 try {
  await migrate(admin);
  const user=(await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES('merge@example.com','analyst','active',now()) RETURNING id")).rows[0].id;
  const clients:string[]=[];
  for(const name of ['Adopt reviewed','Keep ignored','Move flagged']) {
   const client=(await runtime.query('INSERT INTO monitor.clients(name,created_by) VALUES($1,$2) RETURNING id',[name,user])).rows[0].id;
   clients.push(client);
   await runtime.query("INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,'Brand',$2)",[client,user]);
  }
  const site=(await runtime.query("INSERT INTO monitor.watched_sites(name,url,created_by,method,detection_status) VALUES('Merge publisher','https://news.example.com',$1,'rss','ready') RETURNING id",[user])).rows[0].id;
  const now=new Date();
  const body=(canonical:string,date:string,label:string)=>`<html><head><link rel="canonical" href="${canonical}"><script type="application/ld+json">{"@type":"NewsArticle","headline":"Brand ${label}","datePublished":"${date}"}</script></head><body><article><h1>Brand ${label}</h1><div class="entry-content"><p>Brand ${label} announces a new community service. This complete article explains the project and its benefits for residents, with enough readable text for verified article extraction.</p></div></article></body></html>`;

  for(const conflicting of [false,true]) await t.test(conflicting?'conflicting publications become date unverified':'consistent publications retain one current article',async()=> {
   const prefix=conflicting?'conflict':'consistent';
   const a=`https://news.example.com/${prefix}-a`,b=`https://news.example.com/${prefix}-b`,c=`https://news.example.com/${prefix}-c`;
   const dateB=new Date(now.getTime()-5*3600000).toISOString();
   const dateA=conflicting?new Date(now.getTime()-8*3600000).toISOString():dateB;
   const discoveredA=new Date(now.getTime()-30_000),discoveredB=new Date(now.getTime()-10_000);
   const discovery=(url:string,date:string|undefined,discoveredAt:Date,source:ArticleDiscovery['source']='rss'):ArticleDiscovery=>({
    url,source,discoveredAt,dateEvidence:date?[{raw:date,source:source==='sitemap'?'news-sitemap':'feed',observedAt:discoveredAt}]:[],
   });
   await enqueueArticleLinks(runtime,site,[discovery(a,dateA,discoveredA)]);
   assert.equal(await processNextArticle(runtime,async url=>({url,body:body(a,dateA,'Alpha'),contentType:'text/html'})),true);
   await enqueueArticleLinks(runtime,site,[discovery(b,dateB,discoveredB,'sitemap')]);
   assert.equal(await processNextArticle(runtime,async url=>({url,body:body(b,dateB,'Beta'),contentType:'text/html'})),true);
   const losing=(await runtime.query('SELECT id FROM monitor.articles WHERE canonical_url=$1',[a])).rows[0].id;
   const retained=(await runtime.query('SELECT id FROM monitor.articles WHERE canonical_url=$1',[b])).rows[0].id;
   const targetWorkflow=(await runtime.query('SELECT id FROM monitor.mentions WHERE article_id=$1 AND client_id=$2',[retained,clients[0]])).rows[0].id;
   const movedWorkflow=(await runtime.query('SELECT id FROM monitor.mentions WHERE article_id=$1 AND client_id=$2',[losing,clients[2]])).rows[0].id;
   await runtime.query("UPDATE monitor.mentions SET status='reviewed' WHERE article_id=$1 AND client_id=ANY($2::uuid[])",[losing,clients.slice(0,2)]);
   await runtime.query("UPDATE monitor.mentions SET status='ignored' WHERE article_id=$1 AND client_id=$2",[retained,clients[1]]);
   await runtime.query("UPDATE monitor.mentions SET status='flagged' WHERE article_id=$1 AND client_id=$2",[losing,clients[2]]);
   // A client workflow that exists only on the losing article must be reparented.
   await runtime.query('DELETE FROM monitor.mentions WHERE article_id=$1 AND client_id=$2',[retained,clients[2]]);
   await enqueueArticleLinks(runtime,site,[discovery(c,undefined,now)]);
   let captures=0;
   // New /c redirects to already stored /a; its rel=canonical now claims /b.
   const converging:PageFetcher=async()=>{captures++;return {url:a,body:body(b,dateB,'Beta'),contentType:'text/html'};};

   if(!conflicting) {
    await admin.query(`CREATE FUNCTION monitor.reject_test_article_delete() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION 'Fixture merge failure'; END $$`);
    await admin.query('CREATE TRIGGER reject_test_article_delete BEFORE DELETE ON monitor.articles FOR EACH ROW EXECUTE FUNCTION monitor.reject_test_article_delete()');
    await processNextArticle(runtime,converging);
    assert.equal((await runtime.query('SELECT id FROM monitor.articles WHERE id=ANY($1::uuid[])',[[losing,retained]])).rowCount,2);
    assert.equal((await runtime.query('SELECT article_id FROM monitor.article_urls WHERE url=$1',[a])).rows[0].article_id,losing);
    assert.equal((await runtime.query('SELECT status FROM monitor.mentions WHERE id=$1',[targetWorkflow])).rows[0].status,'new');
    assert.equal((await runtime.query('SELECT article_id FROM monitor.mentions WHERE id=$1',[movedWorkflow])).rows[0].article_id,losing);
    assert.match((await runtime.query('SELECT error FROM monitor.article_candidates WHERE url=$1',[c])).rows[0].error,/Fixture merge failure/);
    await admin.query('DROP TRIGGER reject_test_article_delete ON monitor.articles');
    await admin.query('DROP FUNCTION monitor.reject_test_article_delete()');
    await runtime.query("UPDATE monitor.article_candidates SET status='queued' WHERE url=$1",[c]);
   }
   assert.equal(await processNextArticle(runtime,converging),true);
   assert.equal(captures,conflicting?1:2);
   const articles=(await runtime.query('SELECT * FROM monitor.articles WHERE canonical_url=ANY($1::text[])',[[a,b,c]])).rows;
   assert.equal(articles.length,1);
   assert.equal(articles[0].id,retained);
   assert.equal(articles[0].canonical_url,b);
   assert.equal(articles[0].title,'Brand Beta');
   assert.equal(articles[0].discovered_at.getTime(),discoveredA.getTime());
   assert.equal(articles[0].date_confidence,conflicting?'unverified':'verified');
   assert.ok(articles[0].date_evidence.some((e: {raw:string;source:string})=>e.raw===dateA && e.source==='feed'));
   assert.ok(articles[0].date_evidence.some((e: {raw:string;source:string})=>e.raw===dateB && e.source==='news-sitemap'));
   assert.equal((await runtime.query('SELECT id FROM monitor.articles WHERE id=$1',[losing])).rowCount,0);
   const aliases=(await runtime.query('SELECT url,article_id FROM monitor.article_urls WHERE url=ANY($1::text[]) ORDER BY url',[[a,b,c]])).rows;
   assert.equal(aliases.length,3);
   assert.ok(aliases.every(alias=>alias.article_id===retained));
   const candidates=(await runtime.query('SELECT status,article_id,source FROM monitor.article_candidates WHERE url=ANY($1::text[])',[[a,b,c]])).rows;
   assert.ok(candidates.every(candidate=>candidate.status==='done' && candidate.article_id===retained));
   assert.deepEqual([...new Set(candidates.map(candidate=>candidate.source))].sort(),['rss','sitemap']);
   const workflow=(await runtime.query('SELECT id,client_id,status FROM monitor.mentions WHERE article_id=$1',[retained])).rows;
   assert.equal(workflow.length,3);
   assert.equal(workflow.find(mention=>mention.client_id===clients[0]).status,'reviewed');
   assert.equal(workflow.find(mention=>mention.client_id===clients[0]).id,targetWorkflow);
   assert.equal(workflow.find(mention=>mention.client_id===clients[1]).status,'ignored');
   assert.equal(workflow.find(mention=>mention.client_id===clients[2]).status,'flagged');
   assert.equal(workflow.find(mention=>mention.client_id===clients[2]).id,movedWorkflow);
   const excerpts=(await runtime.query("SELECT mm.matched_excerpt FROM monitor.mention_matches mm JOIN monitor.mentions m ON m.id=mm.mention_id WHERE m.article_id=$1 AND mm.matched_in='body'",[retained])).rows;
   assert.equal(excerpts.length,3);
   assert.ok(excerpts.every(match=>match.matched_excerpt.includes('Beta') && !match.matched_excerpt.includes('Alpha')));
   const current=await readCurrentMentions(runtime,user,clients[0]);
   assert.equal(current.filter(article=>article.article_id===retained).length,conflicting?0:1);
   if(!conflicting)assert.deepEqual(current.find(article=>article.article_id===retained).found_by.sort(),['rss','sitemap']);
   // Every original identity now reuses the retained article without recapturing it.
   await enqueueArticleLinks(runtime,site,[discovery(a,undefined,now,'sitemap')]);
   await processNextArticle(runtime,async()=>{throw new Error('Merged aliases must not be fetched again');});
   assert.equal((await runtime.query("SELECT status FROM monitor.article_candidates WHERE url=$1 AND source='sitemap'",[a])).rows[0].status,'done');
  });
 } finally {
  await runtime.end();await admin.end();
  await operator.query(`DROP DATABASE ${databaseName}`);await operator.end();
 }
});
