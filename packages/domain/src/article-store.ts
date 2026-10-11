import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalizeArticleUrl } from './article-urls';
import { extractArticle } from './article-extraction';
import { resolvePublication, publicationTimestamp, type DateEvidence } from './article-dates';
import { normalizeText, detectLegacyEncoding, matchKeyword } from './article-matching';
import type { PageFetcher } from './safe-http';
import type { ArticleDiscovery } from './article-collection';
import { authorizeSites } from './site-store';
import { normalizeSiteUrl } from './sites';
import { articleDiscoveryPublicationMicros, isArticleCandidateUrl, MAX_SITE_CANDIDATES_PER_SCAN, sortArticleDiscoveries } from './article-candidates';

function evidenceFromJson(value: DateEvidence[]): DateEvidence[] {
 return value.map(e=>({...e,observedAt:e.observedAt ? new Date(e.observedAt) : undefined}));
}
export async function enqueueArticleLinks(pool: Pool, siteId: string, discoveries: ArticleDiscovery[]) {
 const connection=await pool.connect();
 try {
  await connection.query('BEGIN');
  await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`article-candidates:${siteId}`]);
  const site=(await connection.query('SELECT url,source_timezone FROM monitor.watched_sites WHERE id=$1',[siteId])).rows[0];
  if(!site) {await connection.query('COMMIT');return;}
  const eligible=sortArticleDiscoveries(discoveries.filter(discovery=>isArticleCandidateUrl(discovery.url,site.url,{listing:discovery.source==='listing'})),site.source_timezone);
  const urls=[...new Set(eligible.map(discovery=>canonicalizeArticleUrl(discovery.url)))];
  const candidateRows=(await connection.query<{url:string;source:string;date_evidence:DateEvidence[]}>('SELECT url,source,date_evidence FROM monitor.article_candidates WHERE site_id=$1 AND url=ANY($2::text[])',[siteId,urls])).rows;
  const candidates=new Set(candidateRows.map(row=>row.url));
  const candidateEvidence=new Map(candidateRows.map(row=>[`${row.url}:${row.source}`,evidenceFromJson(row.date_evidence)]));
  const known=(await connection.query<{url:string;article_id:string;date_evidence:DateEvidence[];discovered_at:Date}>(`SELECT u.url,u.article_id,a.date_evidence,a.discovered_at FROM monitor.article_urls u
   JOIN monitor.articles a ON a.id=u.article_id WHERE u.url=ANY($1::text[])
   UNION SELECT canonical_url,id,date_evidence,discovered_at FROM monitor.articles WHERE canonical_url=ANY($1::text[])`,[urls])).rows;
  const articles=new Map(known.map(article=>[article.url,article]));
  const additions=new Set<string>();
  for (const discovery of eligible) {
   const url=canonicalizeArticleUrl(discovery.url),article=articles.get(url);
   // Listing pages supply discovery only, so known identities require no work.
   if(discovery.source==='listing' && (candidates.has(url) || article)) continue;
   if(!candidates.has(url) && !article && !additions.has(url)) {
    if(additions.size>=MAX_SITE_CANDIDATES_PER_SCAN) continue;
    additions.add(url);
   }
   const previous=[...(candidateEvidence.get(`${url}:${discovery.source}`) ?? []),...(article?evidenceFromJson(article.date_evidence):[])];
   // Identical raw evidence retains its first observation clock on rediscovery.
   const evidence=discovery.dateEvidence.map(e=>({...e,observedAt:previous.find(old=>old.source===e.source && old.raw===e.raw)?.observedAt ?? e.observedAt ?? discovery.discoveredAt}));
   const evidenceKey=(item:DateEvidence)=>`${item.source}:${item.raw}:${item.observedAt?.toISOString() ?? ''}`;
   const stored=new Set(article?evidenceFromJson(article.date_evidence).map(evidenceKey):[]);
   const needsEvidence=article && evidence.some(item=>!stored.has(evidenceKey(item)));
   const needsDiscovery=article && discovery.discoveredAt.getTime()<article.discovered_at.getTime();
   await connection.query(`INSERT INTO monitor.article_candidates(site_id,url,source,discovered_at,date_evidence,fetch_url,status,article_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
   ON CONFLICT(site_id,url,source) DO UPDATE SET discovered_at=LEAST(monitor.article_candidates.discovered_at,excluded.discovered_at),
    date_evidence=(SELECT COALESCE(jsonb_agg(item),'[]') FROM (SELECT DISTINCT item
     FROM jsonb_array_elements(monitor.article_candidates.date_evidence || excluded.date_evidence) item) merged),
    status=CASE WHEN (excluded.article_id IS NOT NULL AND excluded.status='queued') OR EXISTS (SELECT 1 FROM jsonb_array_elements(excluded.date_evidence) added
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(monitor.article_candidates.date_evidence) old
      WHERE old=added)) THEN 'queued' ELSE monitor.article_candidates.status END`,
    [siteId,url,discovery.source,discovery.discoveredAt,JSON.stringify(evidence),normalizeSiteUrl(discovery.url,undefined,true),article && !needsEvidence && !needsDiscovery?'done':'queued',article?.article_id ?? null]);
   candidateEvidence.set(`${url}:${discovery.source}`,[...previous,...evidence]);
  }
  await connection.query('COMMIT');
 } catch(error) {await connection.query('ROLLBACK');throw error;} finally {connection.release();}
}
export async function enqueueSitePreviews(pool: Pool) {
 const sites=(await pool.query("SELECT id,method,preview,detected_at FROM monitor.watched_sites WHERE active AND detection_status='ready'")).rows;
 for(const site of sites) {
  if (!['rss','sitemap','listing'].includes(site.method)) continue;
  const discoveredAt=site.detected_at ?? new Date();
  await enqueueArticleLinks(pool,site.id,site.preview.map((post: {url:string;raw_date:string|null;date_kind:string|null})=> ({
   url:post.url,source:site.method,discoveredAt,
   // A generic sitemap lastmod and unlabelled listing preview time are not publication evidence.
   dateEvidence:post.raw_date && post.date_kind==='publication' && site.method!=='listing'
    ? [{raw:post.raw_date,source:site.method==='rss'?'feed':'news-sitemap',observedAt:discoveredAt}] : []
  })));
 }
}
async function rematch(connection: PoolClient, articleId: string) {
 const article=(await connection.query('SELECT title,body_text,extraction_status FROM monitor.articles WHERE id=$1',[articleId])).rows[0];
 const keywords=(await connection.query(`SELECT k.* FROM monitor.keywords k JOIN monitor.clients c ON c.id=k.client_id WHERE k.active AND c.active`)).rows;
 await connection.query('DELETE FROM monitor.mention_matches WHERE mention_id IN (SELECT id FROM monitor.mentions WHERE article_id=$1)',[articleId]);
 if(article.extraction_status!=='extracted') return;
 for(const keyword of keywords) {
  const matches=matchKeyword({title:article.title,body:article.body_text},keyword);
  if(!matches.length) continue;
  const mention=(await connection.query(`INSERT INTO monitor.mentions(article_id,client_id) VALUES($1,$2)
   ON CONFLICT(article_id,client_id) DO UPDATE SET article_id=excluded.article_id RETURNING id`,[articleId,keyword.client_id])).rows[0];
  for(const match of matches) await connection.query(`INSERT INTO monitor.mention_matches(mention_id,keyword_id,keyword_revision,matched_in,matched_term,matched_excerpt,match_start,match_end)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(mention_id,keyword_id,matched_in) DO NOTHING`,
   [mention.id,keyword.id,keyword.revision,match.matchedIn,match.matchedTerm,match.excerpt,match.start,match.end]);
 }
}
async function reconcilePublication(connection: PoolClient,articleId:string, added:DateEvidence[]) {
 const article=(await connection.query('SELECT date_evidence,source_timezone,discovered_at FROM monitor.articles WHERE id=$1',[articleId])).rows[0];
 const merged=[...new Map([...evidenceFromJson(article.date_evidence),...added].map(item=>[`${item.source}:${item.raw}:${item.observedAt?.toISOString() ?? ''}`,item])).values()];
 const publication=resolvePublication(merged,{observedAt:article.discovered_at,timeZone:article.source_timezone});
 await connection.query(`UPDATE monitor.articles SET published_at=$2,publication_lower=$3,publication_upper=$4,date_confidence=$5,
  date_precision=$6,date_reason=$7,date_evidence=$8::jsonb WHERE id=$1`,[articleId,publicationTimestamp(publication,'published'),
  publicationTimestamp(publication,'lower'),publicationTimestamp(publication,'upper'),publication.confidence,publication.precision,publication.reason,JSON.stringify(publication.evidence)]);
}
type KnownArticle = { id: string; canonical_url: string; date_evidence: DateEvidence[]; discovered_at: Date };
async function mergeKnownArticles(connection: PoolClient, known: KnownArticle[]): Promise<DateEvidence[]> {
 const target=known[0], incoming:DateEvidence[]=[];
 // All article writers hold the same advisory lock. Mention rows are also locked
 // while preserving workflow decisions made independently by each client.
 for(const losing of known.slice(1)) {
  incoming.push(...evidenceFromJson(losing.date_evidence).map(item=>({...item,observedAt:item.observedAt ?? losing.discovered_at})));
  await connection.query('UPDATE monitor.articles SET discovered_at=LEAST(discovered_at,$2) WHERE id=$1',[target.id,losing.discovered_at]);
  await connection.query('UPDATE monitor.article_candidates SET article_id=$1 WHERE article_id=$2',[target.id,losing.id]);
  await connection.query('UPDATE monitor.article_urls SET article_id=$1 WHERE article_id=$2',[target.id,losing.id]);
  await connection.query(`INSERT INTO monitor.article_urls(url,article_id) VALUES($1,$2)
   ON CONFLICT(url) DO UPDATE SET article_id=excluded.article_id`,[losing.canonical_url,target.id]);
  const mentions=(await connection.query('SELECT id,client_id,status FROM monitor.mentions WHERE article_id=$1 ORDER BY client_id FOR UPDATE',[losing.id])).rows;
  for(const mention of mentions) {
   const existing=(await connection.query('SELECT id,status FROM monitor.mentions WHERE article_id=$1 AND client_id=$2 FOR UPDATE',[target.id,mention.client_id])).rows[0];
   if(existing) {
    if(existing.status==='new' && mention.status!=='new')
     await connection.query('UPDATE monitor.mentions SET status=$2 WHERE id=$1',[existing.id,mention.status]);
    await connection.query('DELETE FROM monitor.mentions WHERE id=$1',[mention.id]);
   } else await connection.query('UPDATE monitor.mentions SET article_id=$2 WHERE id=$1',[mention.id,target.id]);
  }
  // URLs, discoveries and client workflow have been reparented. Match evidence is
  // regenerated against the retained canonical article by the normal rematch.
  await connection.query('DELETE FROM monitor.articles WHERE id=$1',[losing.id]);
 }
 return incoming;
}
export async function rematchStoredArticles(pool: Pool) {
 const connection=await pool.connect();
 try {
  await connection.query('BEGIN');
  await connection.query('SELECT pg_advisory_xact_lock(730004)');
  const articles=(await connection.query('SELECT id FROM monitor.articles ORDER BY id')).rows;
  for(const article of articles) await rematch(connection,article.id);
  await connection.query('COMMIT');
  return articles.length;
 } catch(error) {await connection.query('ROLLBACK');throw error;} finally{connection.release();}
}
// Coarse serialization is deliberate for ~100 sites: durable candidates recover after a
// crash and canonical identity is resolved once across all worker processes and clients.
export async function processNextArticle(pool: Pool, fetchPage: PageFetcher, signal=new AbortController().signal): Promise<boolean> {
 const connection=await pool.connect();let locked=false;
 try {
  locked=(await connection.query('SELECT pg_try_advisory_lock(730004) AS locked')).rows[0].locked;
  if(!locked) return false;
  const queued=(await connection.query(`SELECT d.*,s.source_timezone,s.url AS site_url,
   (extract(epoch FROM d.discovered_at)*1000000)::bigint::text AS discovered_micros
   FROM monitor.article_candidates d JOIN monitor.watched_sites s ON s.id=d.site_id
   WHERE d.status IN ('queued','processing') AND s.active`)).rows;
  const ranked=[];
  for(const row of queued) {
   if(!isArticleCandidateUrl(row.fetch_url,row.site_url,{listing:row.source==='listing'})) {
    await connection.query("UPDATE monitor.article_candidates SET status='error',error='URL is not an article candidate.' WHERE id=$1",[row.id]);
    continue;
   }
   ranked.push({row,published:articleDiscoveryPublicationMicros({url:row.url,source:row.source,discoveredAt:row.discovered_at,dateEvidence:evidenceFromJson(row.date_evidence)},row.source_timezone)});
  }
  ranked.sort((a,b)=>a.published!==b.published
   ? a.published===null ? 1 : b.published===null ? -1 : a.published>b.published ? -1 : 1
   : BigInt(a.row.discovered_micros)!==BigInt(b.row.discovered_micros) ? BigInt(a.row.discovered_micros)>BigInt(b.row.discovered_micros) ? -1 : 1
   : a.row.id.localeCompare(b.row.id));
  const candidate=ranked[0]?.row;
  if(!candidate) return false;
  await connection.query("UPDATE monitor.article_candidates SET status='processing',error=NULL WHERE id=$1",[candidate.id]);
  let transaction=false;
  try {
   const existing=(await connection.query('SELECT article_id FROM monitor.article_urls WHERE url=$1',[candidate.url])).rows[0];
   let articleId:string|undefined=existing?.article_id;
   let incomingEvidence:DateEvidence[]=[];
   if(!articleId) {
    signal.throwIfAborted();
    const page=await fetchPage(candidate.fetch_url,signal), observedAt=new Date();
    const extracted=extractArticle(page.body,page.url,{observedAt,timeZone:candidate.source_timezone,feedEvidence:evidenceFromJson(candidate.date_evidence)});
    const encoding=extracted.status==='extracted' && detectLegacyEncoding(extracted.title,extracted.body);
    const publication=resolvePublication(extracted.dateEvidence,{observedAt,timeZone:candidate.source_timezone});
    incomingEvidence=extracted.dateEvidence;
    await connection.query('BEGIN');transaction=true;
    const aliases=[...new Set([candidate.url,canonicalizeArticleUrl(page.url),extracted.canonicalUrl])];
    // The canonical claim may already be a registered alias of another canonical URL.
    const known=(await connection.query<KnownArticle>(`SELECT a.id,a.canonical_url,a.date_evidence,a.discovered_at FROM monitor.articles a
     WHERE a.canonical_url=ANY($1::text[]) OR a.id IN (SELECT article_id FROM monitor.article_urls WHERE url=ANY($1::text[]))
     ORDER BY (a.canonical_url=$2) DESC,a.id FOR UPDATE`,[aliases,extracted.canonicalUrl])).rows;
    if(known.length) {
     articleId=known[0].id;
     incomingEvidence.push(...await mergeKnownArticles(connection,known));
    }
    else {
    const article=(await connection.query(`INSERT INTO monitor.articles(canonical_url,title,body_text,normalized_title,normalized_body,published_at,publication_lower,publication_upper,
     discovered_at,date_confidence,date_precision,date_reason,date_evidence,source_timezone,extraction_status,extraction_reason,site_id,content_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
     ON CONFLICT(canonical_url) DO UPDATE SET discovered_at=LEAST(monitor.articles.discovered_at,excluded.discovered_at) RETURNING id`,
     [extracted.canonicalUrl,extracted.title,extracted.body,normalizeText(extracted.title),normalizeText(extracted.body),
      publicationTimestamp(publication,'published'),publicationTimestamp(publication,'lower'),publicationTimestamp(publication,'upper'),
      candidate.discovered_at,publication.confidence,publication.precision,publication.reason,JSON.stringify(publication.evidence),candidate.source_timezone,
      encoding?'encoding_problem':extracted.status,encoding?'Suspected legacy non-Unicode Bangla text.':extracted.reason,candidate.site_id,
      createHash('sha256').update(normalizeText(extracted.body)).digest('hex')])).rows[0];
    articleId=article.id;
    }
    for(const alias of aliases)
     await connection.query('INSERT INTO monitor.article_urls(url,article_id) VALUES($1,$2) ON CONFLICT(url) DO NOTHING',[alias,articleId]);
   } else {await connection.query('BEGIN');transaction=true;}
   const latest=(await connection.query('SELECT date_evidence,discovered_at FROM monitor.article_candidates WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
   await reconcilePublication(connection,articleId!,[...incomingEvidence,...evidenceFromJson(latest.date_evidence)]);
   await connection.query('UPDATE monitor.articles SET discovered_at=LEAST(discovered_at,$2) WHERE id=$1',[articleId,latest.discovered_at]);
   await rematch(connection,articleId!);
   await connection.query("UPDATE monitor.article_candidates SET status='done',article_id=$2 WHERE id=$1",[candidate.id,articleId]);
   await connection.query('COMMIT');transaction=false;
  } catch(error) {
   if(transaction) await connection.query('ROLLBACK');
   // Shutdown leaves durable work queued; transient errors require an explicit retry command.
   await connection.query('UPDATE monitor.article_candidates SET status=$2,error=$3 WHERE id=$1',[candidate.id,signal.aborted?'queued':'error',(error as Error).message]);
  }
  return true;
 } finally {
  try{if(locked)await connection.query('SELECT pg_advisory_unlock(730004)');}finally{connection.release();}
 }
}

// Slice 4 will use this guarded query. Eligibility expires at read time, without writes.
export async function readCurrentMentions(pool: Pool, userId: string, clientId: string) {
 await authorizeSites(pool,userId);
 return (await pool.query(`WITH clock AS (SELECT statement_timestamp() AS t), classified_articles AS (
  SELECT a.*,clock.t,
   (a.date_confidence='unverified' OR a.published_at IS NULL OR a.publication_lower IS NULL OR a.publication_upper IS NULL OR
    (a.published_at<=clock.t AND a.publication_upper<=clock.t AND a.publication_lower<clock.t-interval '24 hours'
     AND a.publication_upper>=clock.t-interval '24 hours')) AS unverified
  FROM monitor.articles a CROSS JOIN clock)
  SELECT m.id,a.id AS article_id,a.canonical_url,a.title,a.published_at,a.discovered_at,a.date_confidence,a.unverified,
  jsonb_agg(DISTINCT jsonb_build_object('keyword_id',k.id,'excerpt',mm.matched_excerpt,'matched_in',mm.matched_in)) AS matches,
  ARRAY(SELECT DISTINCT d.source FROM monitor.article_candidates d WHERE d.article_id=a.id) AS found_by
  FROM monitor.mentions m JOIN classified_articles a ON a.id=m.article_id JOIN monitor.clients c ON c.id=m.client_id
  JOIN monitor.mention_matches mm ON mm.mention_id=m.id JOIN monitor.keywords k ON k.id=mm.keyword_id AND k.client_id=m.client_id
  WHERE m.client_id=$1 AND c.active AND k.active AND mm.keyword_revision=k.revision AND m.status<>'ignored'
   AND a.extraction_status='extracted' AND (
    (NOT a.unverified AND a.published_at BETWEEN a.t-interval '24 hours' AND a.t
     AND a.publication_lower>=a.t-interval '24 hours' AND a.publication_upper<=a.t)
    OR (a.unverified AND a.discovered_at BETWEEN a.t-interval '24 hours' AND a.t))
  GROUP BY m.id,a.id,a.canonical_url,a.title,a.published_at,a.discovered_at,a.date_confidence,a.unverified
  ORDER BY CASE WHEN a.unverified THEN a.discovered_at ELSE a.published_at END DESC,a.id`,[clientId])).rows;
}
