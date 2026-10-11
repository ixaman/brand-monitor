import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { scanConfiguredSites } from '../../scripts/scan';
import type { PageFetcher } from '../../packages/domain/src/safe-http';

test('configured listing scans enqueue/drain articles, skip known URLs, and refresh stale diagnostics',async()=>{
 const operator=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
 const databaseName=`scanner_test_${crypto.randomUUID().replaceAll('-','')}`;
 await operator.query(`CREATE DATABASE ${databaseName}`);
 const migrationUrl=new URL(process.env.MIGRATION_DATABASE_URL!);migrationUrl.pathname='/'+databaseName;
 const runtimeUrl=new URL(process.env.DATABASE_URL!);runtimeUrl.pathname='/'+databaseName;
 const admin=new Pool({connectionString:migrationUrl.toString()}),runtime=new Pool({connectionString:runtimeUrl.toString(),options:'-c timezone=UTC'});
 try {
  await migrate(admin);
  const user=(await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES('scanner@example.com','analyst','active',now()) RETURNING id")).rows[0].id;
  const base='https://newage.example.com',feedBase='https://tbs.example.com';
  const listing=(await runtime.query(`INSERT INTO monitor.watched_sites(name,url,listing_url,scan_depth,created_by,method,detection_status,diagnostics)
   VALUES('New Age',$1,$2,1,$3,'listing','ready','["Operator note"]') RETURNING id`,[base,base+'/latest',user])).rows[0].id;
  const feed=(await runtime.query(`INSERT INTO monitor.watched_sites(name,url,listing_url,scan_depth,created_by,method,detection_status)
   VALUES('TBS',$1,$2,0,$3,'rss','ready') RETURNING id`,[feedBase,feedBase+'/latest',user])).rows[0].id;
  // Supplied listing pages are scanned even while detection needs attention.
  const pendingBase='https://pending.example.com';
  const pending=(await runtime.query(`INSERT INTO monitor.watched_sites(name,url,created_by,detection_status)
   VALUES('Pending',$1,$2,'needs_attention') RETURNING id`,[pendingBase,user])).rows[0].id;
  await runtime.query(`INSERT INTO monitor.site_endpoints(site_id,kind,url,configured) VALUES
   ($1,'listing',$2,true),($3,'rss',$4,true),($5,'listing',$6,true)`,[listing,base+'/business',feed,feedBase+'/rss.xml',pending,pendingBase+'/latest']);
  await runtime.query(`INSERT INTO monitor.watched_sites(name,url,listing_url,created_by,active,method,detection_status)
   VALUES('Inactive','https://inactive.example.com','https://inactive.example.com/latest',$1,false,'listing','ready')`,[user]);
  const pages:Record<string,string>={
   [base+'/latest']:'<ul><li><a href="/post/123/current-story">Current story</a></li></ul><a href="/category/news">Section</a><a href="/">Home</a>',
   [base+'/business']:'<a href="/post/456/business-story">Business story</a>',
   [base+'/category/news']:'<a href="/post/789/section-story">Section story</a><a href="/tag/brand">Tag</a>',
   [feedBase+'/rss.xml']:`<rss><channel><item><link>${feedBase}/old-story</link><pubDate>2021-01-01T00:00:00Z</pubDate></item></channel></rss>`,
   [feedBase+'/latest']:'<a href="/post/999/current-story">Current story</a>',
   [pendingBase+'/latest']:'<a href="/post/111/pending-story">Pending story</a>',
  };
  const calls:string[]=[],fetchPage:PageFetcher=async url=>{
   calls.push(url);
   if(url in pages)return {url,body:pages[url],contentType:url.endsWith('.xml')?'application/xml':'text/html'};
   assert.match(new URL(url).pathname,/^\/post\/\d+\//); // Navigation/old feed URLs must never be fetched as articles.
   return {url,body:'<article><h1>Publisher article</h1><p>This article contains a full report about the current developments in Bangladesh. Its main text is long enough for extraction and durable article storage.</p></article>',contentType:'text/html'};
  };
  const first=await scanConfiguredSites(runtime,fetchPage);
  assert.equal(first.exitCode,0);assert.equal(first.sites.length,3);
  assert.ok(first.sites.every(site=>site.status==='ok'));
  assert.deepEqual(first.candidates,[{status:'done',count:5}]);
  assert.ok(calls.includes(base+'/latest') && calls.includes(base+'/business') && calls.includes(base+'/category/news'));
  assert.ok(!calls.some(url=>url.includes('inactive') || url.endsWith('/old-story')));
  const diagnostics=(await runtime.query('SELECT diagnostics FROM monitor.watched_sites WHERE id=$1',[feed])).rows[0].diagnostics;
  assert.ok(diagnostics.some((message:string)=>message.includes('rss.xml: Source is stale')));
  assert.deepEqual((await runtime.query('SELECT diagnostics FROM monitor.watched_sites WHERE id=$1',[listing])).rows[0].diagnostics,['Operator note']);
  const articleCount=(await runtime.query('SELECT count(*)::int AS count FROM monitor.articles')).rows[0].count;
  assert.equal(articleCount,5);
  calls.length=0;
  const second=await scanConfiguredSites(runtime,fetchPage);
  assert.equal(second.exitCode,0);assert.ok(second.sites.every(site=>site.discovered===0));
  assert.equal(calls.length,6); // Every listing root/depth page and the feed are refreshed; known articles are skipped.
  assert.equal((await runtime.query('SELECT count(*)::int AS count FROM monitor.article_candidates')).rows[0].count,5);

  // A fresh feed removes the previous scan's stale details and reconciles known publication evidence without fetching.
  pages[feedBase+'/rss.xml']=`<rss><channel><item><link>${feedBase}/post/999/current-story</link><pubDate>${new Date(Date.now()-3600000).toISOString()}</pubDate></item></channel></rss>`;
  calls.length=0;
  const recovered=await scanConfiguredSites(runtime,fetchPage,undefined,feed);
  assert.equal(recovered.exitCode,0);assert.equal(recovered.sites.length,1);
  assert.deepEqual(calls,[feedBase+'/rss.xml',feedBase+'/latest']);
  assert.deepEqual((await runtime.query('SELECT diagnostics FROM monitor.watched_sites WHERE id=$1',[feed])).rows[0].diagnostics,[]);
  assert.equal((await runtime.query('SELECT count(*)::int AS count FROM monitor.articles')).rows[0].count,5);
  assert.equal((await runtime.query("SELECT date_confidence FROM monitor.articles WHERE canonical_url=$1",[feedBase+'/post/999/current-story'])).rows[0].date_confidence,'verified');
 }finally{
  await runtime.end();await admin.end();await operator.query(`DROP DATABASE ${databaseName}`);await operator.end();
 }
});
