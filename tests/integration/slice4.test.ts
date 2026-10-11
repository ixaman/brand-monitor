import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { mentionWorkspace, reviewMentions, parseFilters, AccessError, NotFoundError } from '../../apps/web/lib/mentions';
import { tabCounts, highlightParts } from '../../apps/web/lib/mention-view';
import { enqueueArticleLinks } from '../../packages/domain/src/article-store';
test('slice 4 publication boundaries, client/filter scope, original highlighting, counts and atomic authorized workflow',async()=>{
 const operator=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
 const name=`slice4_test_${crypto.randomUUID().replaceAll('-','')}`;
 await operator.query(`CREATE DATABASE ${name}`);
 const adminUrl=new URL(process.env.MIGRATION_DATABASE_URL!);adminUrl.pathname='/'+name;
 const runtimeUrl=new URL(process.env.DATABASE_URL!);runtimeUrl.pathname='/'+name;
 const admin=new Pool({connectionString:adminUrl.toString()}),runtime=new Pool({connectionString:runtimeUrl.toString()});
 try {
  await migrate(admin);
  const analyst=(await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES('analyst@example.com','analyst','active',now()) RETURNING id")).rows[0].id;
  const viewer=(await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES('viewer@example.com','viewer','active',now()) RETURNING id")).rows[0].id;
  const client=(await runtime.query("INSERT INTO monitor.clients(name,created_by) VALUES('One',$1) RETURNING id",[analyst])).rows[0].id;
  const other=(await runtime.query("INSERT INTO monitor.clients(name,created_by) VALUES('Two',$1) RETURNING id",[analyst])).rows[0].id;
  const keyword=(await runtime.query("INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,'ব্র্যান্ড',$2) RETURNING id",[client,analyst])).rows[0].id;
  const otherKeyword=(await runtime.query("INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,'Other',$2) RETURNING id",[other,analyst])).rows[0].id;
  const site=(await runtime.query("INSERT INTO monitor.watched_sites(name,url,created_by) VALUES('News','https://news.example.com',$1) RETURNING id",[analyst])).rows[0].id;
  const ids:Record<string,string>={};const articles:Record<string,string>={};
  // Use real database publication instants; the cutoff is reevaluated on every read.
  for(const [label,age,confidence,status,scope] of [
   ['recent',5,'verified','new',client],['twelve',10,'verified','flagged',client],['day',23,'verified','reviewed',client],
   ['old',25,'verified','new',client],['future',-1,'verified','new',client],['unknown',0,'unverified','new',client],
   ['ignored',2,'verified','ignored',client],['other',1,'verified','new',other],['coarse',23,'verified','new',client]
  ] as const) {
   const body='😀'.repeat(45)+'😀 '+'ব্রা\u200bন্ড'+' news';
   const article=(await runtime.query(`INSERT INTO monitor.articles(canonical_url,title,body_text,normalized_title,normalized_body,published_at,publication_lower,publication_upper,discovered_at,date_confidence,source_timezone,extraction_status,site_id,content_hash)
    VALUES($1,'Brand news',$2,'Brand news',$2,statement_timestamp()-make_interval(hours=>$3),statement_timestamp()-make_interval(hours=>$3),statement_timestamp()-make_interval(hours=>$3),statement_timestamp(),$4,'Asia/Dhaka','extracted',$5,$1) RETURNING id`,[`https://news.example.com/${label}`,body,age,confidence,site])).rows[0].id;
   const mention=(await runtime.query('INSERT INTO monitor.mentions(article_id,client_id,status) VALUES($1,$2,$3) RETURNING id',[article,scope,status])).rows[0].id;
   ids[label]=mention;articles[label]=article;
   await runtime.query(`INSERT INTO monitor.mention_matches(mention_id,keyword_id,keyword_revision,matched_in,matched_term,matched_excerpt,match_start,match_end) VALUES($1,$2,1,'body','ব্র্যান্ড',$3,93,101)`,[mention,scope===client?keyword:otherKeyword,'…'+body.slice(2)]);
   await runtime.query("INSERT INTO monitor.article_candidates(site_id,url,fetch_url,source,discovered_at,status,article_id) VALUES($1,$2,$2,'rss',now(),'done',$3)",[site,`https://news.example.com/${label}`,article]);
  }
  // A crossing publication interval is unresolved; its recent first discovery
  // can include it in the main feed without claiming a verified publish time.
  await runtime.query("UPDATE monitor.articles SET publication_lower=statement_timestamp()-interval '25 hours' WHERE id=$1",[articles.coarse]);
  const read=(params:Record<string,string>={},chosen=client)=>mentionWorkspace(runtime,viewer,chosen,parseFilters(params));
  let workspace=await read();
  assert.deepEqual(workspace.rows.filter(row=>!row.unverified).map(row=>row.id).sort(),[ids.recent,ids.twelve,ids.day].sort());
  assert.deepEqual(tabCounts(workspace.rows),{new:3,all:5,flagged:1,unverified:2});
  assert.ok(!workspace.rows.some(row=>row.id===ids.old || row.id===ids.future || row.id===ids.other || row.id===ids.ignored));
  const matched=workspace.rows.find(row=>row.id===ids.recent)!.matches[0];
  assert.equal(highlightParts(matched)[1],'ব্রা\u200bন্ড');
  assert.equal(workspace.rows.find(row=>row.id===ids.recent)!.sources[0],'rss');
  for(const label of ['unknown','coarse']) {
   const unresolved=workspace.rows.find(row=>row.id===ids[label])!;
   assert.equal(unresolved.unverified,true);
   assert.equal(unresolved.in_main_feed,true);
   assert.ok(unresolved.expires_at!==null && unresolved.expires_at>workspace.serverTime);
   assert.ok(unresolved.discovered_at);
  }
  assert.equal((await read({hours:'6'})).rows.filter(row=>!row.unverified).length,1);
  assert.equal((await read({hours:'12'})).rows.filter(row=>!row.unverified).length,2);
  assert.equal((await read({older:'true'})).rows.filter(row=>!row.unverified).length,5);
  assert.equal((await read({older:'true'})).rows.some(row=>row.id===ids.future),false);
  assert.equal((await read({status:'ignored'})).rows[0].id,ids.ignored);
  assert.equal((await read({status:'reviewed'})).rows[0].id,ids.day);
  assert.equal((await read({source:'sitemap'})).rows.length,0);
  assert.equal((await read({site:crypto.randomUUID()})).rows.length,0);
  assert.equal((await read({keyword},client)).rows.length,5);
  await assert.rejects(read({keyword:otherKeyword}));
  assert.deepEqual((await read({},other)).rows.map(row=>row.id),[ids.other]);
  // Several keywords and title/body evidence remain one article/client card.
  const extraKeyword=(await runtime.query("INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,'Brand',$2) RETURNING id",[client,analyst])).rows[0].id;
  await runtime.query(`INSERT INTO monitor.mention_matches(mention_id,keyword_id,keyword_revision,matched_in,matched_term,matched_excerpt,match_start,match_end)
   VALUES($1,$2,1,'title','Brand','Brand news',0,5),($1,$3,1,'title','ব্র্যান্ড','Brand news',0,5)`,[ids.recent,extraKeyword,keyword]);
  const grouped=await read();
  assert.equal(grouped.rows.filter(row=>row.article_id===articles.recent).length,1);
  assert.equal(grouped.rows.find(row=>row.id===ids.recent)!.matches.length,3);
  assert.equal(tabCounts(grouped.rows).new,3);
  assert.equal(highlightParts(grouped.rows.find(row=>row.id===ids.recent)!.matches.find(match=>match.keyword_id===extraKeyword)!)[1],'Brand');
  await runtime.query('DELETE FROM monitor.keywords WHERE id=$1',[extraKeyword]);
  // Different keyword revisions, inactive rules/clients and incomplete extraction cannot leak.
  await runtime.query('UPDATE monitor.keywords SET revision=2 WHERE id=$1',[keyword]);assert.equal((await read()).rows.length,0);
  await runtime.query('UPDATE monitor.keywords SET revision=1,active=false WHERE id=$1',[keyword]);assert.equal((await read()).rows.length,0);
  await runtime.query('UPDATE monitor.keywords SET active=true WHERE id=$1',[keyword]);
  await runtime.query("UPDATE monitor.articles SET extraction_status='extraction_failed' WHERE id=$1",[articles.recent]);assert.equal((await read()).rows.some(row=>row.id===ids.recent),false);
  await runtime.query("UPDATE monitor.articles SET extraction_status='extracted' WHERE id=$1",[articles.recent]);
  // Freeze only the query clock inside this fixture transaction; exercise the
  // actual dashboard predicate at PostgreSQL's full microsecond precision.
  const connection=await runtime.connect();
  try {
   await connection.query('BEGIN');
   const frozenPool={query:(sql:string,values?:unknown[])=>connection.query(sql.replaceAll('statement_timestamp()','transaction_timestamp()'),values)} as unknown as Pool;
   for(const [delta,expected] of [['0 microseconds',true],['-1 microseconds',false],['1 microseconds',true]] as const) {
    await connection.query(`UPDATE monitor.articles SET published_at=transaction_timestamp()-interval '24 hours'+$2::interval,
     publication_lower=transaction_timestamp()-interval '24 hours'+$2::interval,publication_upper=transaction_timestamp()-interval '24 hours'+$2::interval WHERE id=$1`,[articles.recent,delta]);
    const boundary=await mentionWorkspace(frozenPool,viewer,client,parseFilters({}));
    assert.equal(boundary.rows.some(row=>row.id===ids.recent && !row.unverified),expected);
   }
   // Unverified dates use first discovery at full PostgreSQL precision, even
   // when a guessed publication timestamp is much newer than discovery.
   await connection.query("UPDATE monitor.articles SET published_at=transaction_timestamp()+interval '2 days' WHERE id=$1",[articles.unknown]);
   for(const hours of [6,12,24]) {
    for(const [delta,expected] of [['0 microseconds',true],['-1 microseconds',false],['1 microseconds',true]] as const) {
     await connection.query(`UPDATE monitor.articles SET discovered_at=transaction_timestamp()-make_interval(hours=>$2)+$3::interval WHERE id=$1`,[articles.unknown,hours,delta]);
     const boundary=await mentionWorkspace(frozenPool,viewer,client,parseFilters({hours:String(hours)}));
     const row=boundary.rows.find(row=>row.id===ids.unknown)!;
     assert.equal(row.unverified,true);
     assert.equal(row.in_main_feed,expected);
     assert.equal(row.expires_at!>=boundary.serverTime,expected);
     assert.equal(tabCounts(boundary.rows).unverified>=1,true);
    }
   }
   await connection.query("UPDATE monitor.articles SET discovered_at=transaction_timestamp()+interval '1 microsecond' WHERE id=$1",[articles.unknown]);
   const futureDiscovery=await mentionWorkspace(frozenPool,viewer,client,parseFilters({}));
   assert.equal(futureDiscovery.rows.find(row=>row.id===ids.unknown)!.in_main_feed,false);
   const futureHistory=await mentionWorkspace(frozenPool,viewer,client,parseFilters({older:'true'}));
   assert.equal(futureHistory.rows.find(row=>row.id===ids.unknown)!.in_main_feed,false);
   await connection.query("UPDATE monitor.articles SET discovered_at=transaction_timestamp()-interval '25 hours' WHERE id=$1",[articles.unknown]);
   const unresolvedHistory=await mentionWorkspace(frozenPool,viewer,client,parseFilters({}));
   assert.equal(unresolvedHistory.rows.find(row=>row.id===ids.unknown)!.in_main_feed,false);
   assert.ok(unresolvedHistory.rows.findIndex(row=>row.id===ids.unknown)>unresolvedHistory.rows.findIndex(row=>row.id===ids.recent));
   const explicitHistory=await mentionWorkspace(frozenPool,viewer,client,parseFilters({older:'true'}));
   assert.equal(explicitHistory.rows.find(row=>row.id===ids.unknown)!.in_main_feed,true);
   assert.equal(explicitHistory.rows.find(row=>row.id===ids.unknown)!.expires_at,null);
   assert.equal(explicitHistory.rows.find(row=>row.id===ids.old)!.in_main_feed,true);
   assert.equal(explicitHistory.rows.find(row=>row.id===ids.old)!.expires_at,null);
   await connection.query('ROLLBACK');
  } finally {connection.release();}
  // Subsequent reads expire a still-stored mention without rewriting its review state.
  await runtime.query("UPDATE monitor.articles SET published_at=now()-interval '24 hours 1 microsecond',publication_lower=now()-interval '24 hours 1 microsecond',publication_upper=now()-interval '24 hours 1 microsecond' WHERE id=$1",[articles.recent]);
  assert.equal((await read()).rows.some(row=>row.id===ids.recent),false);
  // Rediscovering an unresolved article never refreshes its first-discovery
  // clock or promotes its guessed recent publication into the main feed.
  await runtime.query("UPDATE monitor.articles SET discovered_at=now()-interval '25 hours',published_at=now() WHERE id=$1",[articles.unknown]);
  await runtime.query("UPDATE monitor.article_candidates SET discovered_at=now()-interval '25 hours' WHERE article_id=$1",[articles.unknown]);
  const firstClock=(await runtime.query('SELECT discovered_at::text AS first FROM monitor.articles WHERE id=$1',[articles.unknown])).rows[0].first;
  const candidateClock=(await runtime.query('SELECT discovered_at::text AS first FROM monitor.article_candidates WHERE article_id=$1',[articles.unknown])).rows[0].first;
  await enqueueArticleLinks(runtime,site,[{url:'https://news.example.com/unknown',source:'rss',discoveredAt:new Date(),dateEvidence:[]}]);
  assert.equal((await runtime.query('SELECT discovered_at::text AS first FROM monitor.articles WHERE id=$1',[articles.unknown])).rows[0].first,firstClock);
  assert.equal((await runtime.query('SELECT discovered_at::text AS first FROM monitor.article_candidates WHERE article_id=$1',[articles.unknown])).rows[0].first,candidateClock);
  const rediscovered=(await read()).rows.find(row=>row.id===ids.unknown)!;
  assert.equal(rediscovered.unverified,true);
  assert.equal(rediscovered.in_main_feed,false);
  await assert.rejects(reviewMentions(runtime,viewer,client,[ids.day],'reviewed'),AccessError);
  await assert.rejects(reviewMentions(runtime,analyst,client,[ids.day,ids.other],'ignored'),NotFoundError);
  assert.equal((await runtime.query('SELECT status FROM monitor.mentions WHERE id=$1',[ids.day])).rows[0].status,'reviewed');
  for(const status of ['reviewed','flagged','ignored']) {
   await reviewMentions(runtime,analyst,client,[ids.day,ids.twelve],status);
   assert.deepEqual((await runtime.query('SELECT status FROM monitor.mentions WHERE id=ANY($1::uuid[])',[ [ids.day,ids.twelve] ])).rows.map(row=>row.status),[status,status]);
  }
  await assert.rejects(reviewMentions(runtime,analyst,client,[],'reviewed'));
  await assert.rejects(reviewMentions(runtime,analyst,client,[ids.day],'invalid'));
  await admin.query("UPDATE monitor.app_users SET state='disabled' WHERE id=$1",[analyst]);
  await assert.rejects(reviewMentions(runtime,analyst,client,[ids.day],'reviewed'),AccessError);
  await admin.query("UPDATE monitor.app_users SET state='disabled' WHERE id=$1",[viewer]);await assert.rejects(read(),AccessError);
  await runtime.query('UPDATE monitor.clients SET active=false WHERE id=$1',[client]);
  await admin.query("UPDATE monitor.app_users SET state='active' WHERE id=$1",[viewer]);await assert.rejects(read(),NotFoundError);
 } finally {await runtime.end();await admin.end();await operator.query(`DROP DATABASE ${name}`);await operator.end();}
});
