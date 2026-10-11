import type { Pool } from 'pg';
import { AccessError, NotFoundError, validateId, ValidationError } from './clients';
export { AccessError, NotFoundError, ValidationError };
import { canManage, type Role } from './access';
import type { Mention, Status, Tab } from './mention-view';
export type Filters = { hours: 6 | 12 | 24; older: boolean; tab: Tab; keyword?: string; site?: string; source?: string; status?: Status };
export function parseFilters(params: Record<string,string | undefined>): Filters {
 const hours = params.hours ?? '24', tab = params.tab ?? 'new';
 if (!['6','12','24'].includes(hours) || !['new','all','flagged','unverified'].includes(tab) || (params.older && params.older !== 'true') || (params.status && !['new','reviewed','flagged','ignored'].includes(params.status)) || (params.source && !['rss','sitemap','listing'].includes(params.source))) throw new ValidationError('Invalid mention filters.');
 return { hours:Number(hours) as Filters['hours'],tab:tab as Tab,older:params.older === 'true',keyword:params.keyword ? validateId(params.keyword) : undefined,site:params.site ? validateId(params.site) : undefined,source:params.source || undefined,status:params.status as Status | undefined };
}
async function authorize(pool: Pool,userId: string,write=false) {
 const user = (await pool.query<{role:Role}>("SELECT role FROM monitor.app_users WHERE id=$1 AND state='active'",[validateId(userId)])).rows[0];
 if (!user || (write && !canManage(user.role))) throw new AccessError('Access denied.');
}
export async function mentionWorkspace(pool: Pool,userId: string,clientId: string | undefined,filters: Filters) {
 await authorize(pool,userId);
 const clients = (await pool.query<{id:string;name:string}>('SELECT id,name FROM monitor.clients WHERE active ORDER BY name,id')).rows;
 const selected = clientId ? validateId(clientId) : clients[0]?.id;
 if (selected && !clients.some(client => client.id === selected)) throw new NotFoundError('Active client not found.');
 if (!selected) return {clients,clientId:undefined,keywords:[],sites:[],rows:[] as Mention[],serverTime:Date.now()};
 const keywords = (await pool.query<{id:string;term:string}>('SELECT id,term FROM monitor.keywords WHERE client_id=$1 AND active ORDER BY term,id',[selected])).rows;
 if (filters.keyword && !keywords.some(keyword => keyword.id === filters.keyword)) throw new ValidationError('Keyword does not belong to this client.');
 const sites = (await pool.query<{id:string;name:string}>(`SELECT DISTINCT s.id,s.name FROM monitor.watched_sites s JOIN monitor.articles a ON a.site_id=s.id JOIN monitor.mentions m ON m.article_id=a.id WHERE m.client_id=$1 ORDER BY s.name,s.id`,[selected])).rows;
 const result = (await pool.query<{server_time:number;rows:(Omit<Mention,'matches'> & {matches:(Mention['matches'][number] & {raw_text:string;raw_start:number;raw_end:number})[]})[]}>(`WITH clock AS (SELECT statement_timestamp() AS t), matched AS (
 SELECT m.id,a.id AS article_id,a.title,a.canonical_url AS url,COALESCE(s.name,'Unknown site') AS site,a.published_at,a.discovered_at,a.date_reason,
  a.date_confidence,a.publication_lower,a.publication_upper,
  m.status,ARRAY(SELECT DISTINCT d.source FROM monitor.article_candidates d WHERE d.article_id=a.id ORDER BY d.source) AS sources,
  jsonb_agg(jsonb_build_object('keyword_id',k.id,'keyword',k.term,'matched_term',mm.matched_term,'excerpt',mm.matched_excerpt,'matched_in',mm.matched_in,
   'raw_text',CASE WHEN mm.matched_in='title' THEN a.title ELSE a.body_text END,'raw_start',mm.match_start,'raw_end',mm.match_end) ORDER BY k.term,mm.matched_in) AS matches
 FROM monitor.mentions m JOIN monitor.articles a ON a.id=m.article_id JOIN monitor.clients c ON c.id=m.client_id
 LEFT JOIN monitor.watched_sites s ON s.id=a.site_id CROSS JOIN clock
 JOIN monitor.mention_matches mm ON mm.mention_id=m.id JOIN monitor.keywords k ON k.id=mm.keyword_id AND k.client_id=m.client_id
 WHERE m.client_id=$1 AND c.active AND k.active AND mm.keyword_revision=k.revision AND a.extraction_status='extracted'
 AND ($4::uuid IS NULL OR k.id=$4) AND ($5::uuid IS NULL OR a.site_id=$5)
 AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM monitor.article_candidates d WHERE d.article_id=a.id AND d.source=$6))
 AND (($7::text IS NULL AND m.status<>'ignored') OR m.status=$7)
 AND (a.date_confidence='unverified' OR a.published_at IS NULL OR a.publication_lower IS NULL OR a.publication_upper IS NULL OR
  (a.published_at<=clock.t AND a.publication_lower<=clock.t AND a.publication_upper<=clock.t))
 GROUP BY m.id,a.id,s.name,clock.t), classified AS (
 SELECT matched.*,clock.t,clock.t-make_interval(hours=>$2) AS cutoff,
  (date_confidence='unverified' OR published_at IS NULL OR publication_lower IS NULL OR publication_upper IS NULL OR
   (NOT $3 AND publication_lower<clock.t-make_interval(hours=>$2) AND publication_upper>=clock.t-make_interval(hours=>$2))) AS unverified
 FROM matched CROSS JOIN clock), eligible AS (
 SELECT id,article_id,title,url,site,published_at,discovered_at,date_reason,unverified,
  CASE WHEN unverified THEN discovered_at<=t AND ($3 OR discovered_at>=cutoff)
   ELSE $3 OR publication_lower>=cutoff END AS in_main_feed,
  CASE WHEN $3 THEN NULL WHEN unverified THEN (extract(epoch FROM discovered_at+make_interval(hours=>$2))*1000)::float8
   ELSE (extract(epoch FROM publication_lower+make_interval(hours=>$2))*1000)::float8 END AS expires_at,
  status,sources,matches
 FROM classified WHERE unverified OR $3 OR publication_lower>=cutoff)
 SELECT extract(epoch FROM clock.t)*1000 AS server_time,COALESCE((SELECT jsonb_agg(eligible ORDER BY CASE WHEN unverified THEN discovered_at ELSE published_at END DESC,id) FROM eligible),'[]') AS rows FROM clock`,
 [selected,filters.hours,filters.older,filters.keyword ?? null,filters.site ?? null,filters.source ?? null,filters.status ?? null])).rows[0];
 const rows: Mention[] = result.rows.map(row => ({...row,matches:row.matches.map(match => {
  let left=Math.max(0,match.raw_start-90);
  if (left>0 && /[\uDC00-\uDFFF]/u.test(match.raw_text[left])) left--;
  const {raw_text,raw_start,raw_end,...display}=match;
  return {...display,highlight_start:raw_start-left+(left>0?1:0),highlight_end:raw_end-left+(left>0?1:0)};
 })}));
 return {clients,clientId:selected,keywords,sites,rows,serverTime:Number(result.server_time)};
}
export async function reviewMentions(pool: Pool,userId: string,clientId: string,ids: string[],status: string) {
 validateId(clientId);
 if (!['reviewed','flagged','ignored'].includes(status) || !ids.length || ids.length>500) throw new ValidationError('Select 1–500 mentions and a valid review action.');
 const unique = [...new Set(ids.map(validateId))];
 await authorize(pool,userId,true);
 const connection = await pool.connect();
 try {
  await connection.query('BEGIN');
  const rows = await connection.query('SELECT id FROM monitor.mentions WHERE client_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',[clientId,unique]);
  if (rows.rowCount !== unique.length) throw new NotFoundError('A selected mention does not belong to this client.');
  await connection.query('UPDATE monitor.mentions SET status=$3 WHERE client_id=$1 AND id=ANY($2::uuid[])',[clientId,unique,status]);
  await connection.query('COMMIT');
 } catch(error) { await connection.query('ROLLBACK');throw error; } finally { connection.release(); }
}
