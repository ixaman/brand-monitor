'use client';
import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { siteAction } from './actions';
import type { WatchedSite } from '../../../../packages/domain/src/site-store';
const initial = {results:[],message:''};
function Results({ state }: { state: typeof initial | Awaited<ReturnType<typeof siteAction>> }) {
 return <>{state.message && <p role="status">{state.message}</p>}{state.results.length>0 && <div className="table-scroll"><table><caption>Import results</caption><thead><tr><th>Line</th><th>Input</th><th>Result</th><th>Reason</th></tr></thead><tbody>{state.results.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.site_id ? <a href={`#site-${row.site_id}`}>{row.input}</a> : row.input}</td><td>{row.status}</td><td>{row.reason}</td></tr>)}</tbody></table></div>}</>;
}
export function ImportForm({ kind }: { kind: 'add' | 'paste' | 'csv' }) {
 const [state,action,pending] = useActionState(siteAction,initial);
 return <form action={action}><input type="hidden" name="action" value={kind}/>{kind==='add' ? <><label>URL (required)<input name="url" required placeholder="example.com"/></label><label>Name (optional)<input name="name" maxLength={200}/></label></> : kind==='paste' ? <><label>Sites (one per line)<textarea name="sites" required rows={10} placeholder={'example.com\nDaily News, news.example.com'}/></label><p>Use a URL or name, URL. Blank lines are ignored.</p></> : <><label>CSV file<input name="file" type="file" accept=".csv,text/csv" required/></label><p>Header: name,url,listing_url. Name and listing_url are optional. Keep each record on one line; quote names containing commas. Maximum 512 KiB / 1000 rows.</p></>}<button disabled={pending}>{pending ? 'Importing…' : kind==='add' ? 'Add site' : kind==='paste' ? 'Import pasted sites' : 'Import CSV'}</button><Results state={state}/></form>;
}
export function DetectionRefresh({ pending }: { pending: boolean }) {
 const router = useRouter();
 useEffect(() => {
  if (!pending) return;
  const timer = setInterval(() => router.refresh(),3000);
  return () => clearInterval(timer);
 },[pending,router]);
 return pending ? <p role="status">Detection is queued or running. Sites are checked one at a time; previews update automatically. The worker must be running.</p> : null;
}
export function SiteSettings({ site }: { site: WatchedSite }) {
 const [state,action,pending] = useActionState(siteAction,initial);
 const configured = (kind: string) => site.endpoints.filter(endpoint => endpoint.configured && endpoint.kind===kind).map(endpoint => endpoint.url).join('\n');
 return <><form action={action}><input type="hidden" name="id" value={site.id}/><button name="action" value="detect" disabled={pending}>Re-run detection</button></form><details><summary>Site settings</summary><form action={action}><input type="hidden" name="id" value={site.id}/><label>Name<input name="name" required maxLength={200} defaultValue={site.name}/></label><label>Listing URL (optional)<input name="listing_url" defaultValue={site.listing_url ?? ''}/></label><label>Source timezone<input name="source_timezone" required defaultValue={site.source_timezone}/></label><label>Listing scan depth<select name="scan_depth" defaultValue={site.scan_depth}><option value="0">0 — only supplied pages</option><option value="1">1 — follow section links</option><option value="2">2 — follow two levels</option></select></label><label>Feed URLs (one per line)<textarea name="feeds" defaultValue={configured('rss')}/></label><label>Sitemap URLs (one per line)<textarea name="sitemaps" defaultValue={configured('sitemap')}/></label><label>Additional listing URLs (one per line)<textarea name="listings" defaultValue={configured('listing')}/></label><label><input type="checkbox" name="active" defaultChecked={site.active}/> Active</label><button name="action" value="configure" disabled={pending}>Save settings and detect</button></form></details><Results state={state}/></>;
}
