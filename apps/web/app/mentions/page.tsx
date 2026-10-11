import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { currentUser } from '../../lib/current-user';
import { db } from '../../lib/db';
import { canManage } from '../../lib/access';
import { mentionWorkspace, parseFilters } from '../../lib/mentions';
import { NotFoundError, ValidationError } from '../../lib/clients';
import type { Tab } from '../../lib/mention-view';
import { Feed } from './feed';
export const dynamic='force-dynamic';
export default async function Mentions({searchParams}:{searchParams:Promise<Record<string,string | string[] | undefined>>}) {
 const user=await currentUser();if(!user) redirect('/');
 const raw=await searchParams;
 const params=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,typeof value==='string'?value:undefined]));
 let filters,workspace;
 try {filters=parseFilters(params);workspace=await mentionWorkspace(db,user.id,params.client,filters);}
 catch(error){if(error instanceof ValidationError || error instanceof NotFoundError) notFound();throw error;}
 const href=(change:Record<string,string>)=>{const query=new URLSearchParams();Object.entries({...params,client:workspace.clientId,...change}).forEach(([key,value])=>{if(value)query.set(key,value);});return `/mentions?${query}`;};
 return <main className="mentions-page"><Link href="/">Home</Link><h1>Mentions</h1>
 {!workspace.clientId?<p>No active clients. <Link href="/clients">Add or activate a client and its keywords</Link>, then scan a watched site.</p>:<>
 <form action="/mentions">
 <label>Client<select name="client" defaultValue={workspace.clientId}>{workspace.clients.map(client=><option key={client.id} value={client.id}>{client.name}</option>)}</select></label><button>Select client</button></form>
 <form action="/mentions" className="mention-filters"><input type="hidden" name="client" value={workspace.clientId}/>
 <label>Keyword<select name="keyword" defaultValue={filters.keyword ?? ''}><option value="">All keywords</option>{workspace.keywords.map(keyword=><option key={keyword.id} value={keyword.id}>{keyword.term}</option>)}</select></label>
 <label>Site<select name="site" defaultValue={filters.site ?? ''}><option value="">All sites</option>{workspace.sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
 <label>Source<select name="source" defaultValue={filters.source ?? ''}><option value="">All sources</option>{['rss','sitemap','listing'].map(source=><option key={source}>{source}</option>)}</select></label>
 <label>Status<select name="status" defaultValue={filters.status ?? ''}><option value="">All except ignored</option>{['new','reviewed','flagged','ignored'].map(status=><option key={status}>{status}</option>)}</select></label>
 <input type="hidden" name="tab" value={filters.tab}/><input type="hidden" name="hours" value={filters.hours}/>
 <label><input type="checkbox" name="older" value="true" defaultChecked={filters.older}/> Show older</label><button>Apply filters</button>
 </form><nav aria-label="Time window">{[6,12,24].map(hours=><Link key={hours} href={href({hours:String(hours)})} aria-current={filters.hours===hours?'page':undefined}>Last {hours}h</Link>)}<Link href={`/mentions?client=${workspace.clientId}&tab=all`}>Clear filters</Link></nav>
 <p>{filters.older?'History is enabled.':'Verified articles use their publication time; items marked Date not verified use their first discovery time.'} Times shown in Asia/Dhaka. Counts reflect current filters.</p>
 <Feed rows={workspace.rows} serverTime={workspace.serverTime} clientId={workspace.clientId} filters={filters} manage={canManage(user.role)} links={Object.fromEntries((['new','all','flagged','unverified'] as const).map(tab=>[tab,href({tab})])) as Record<Tab,string>}/>
 </>}</main>;
}
