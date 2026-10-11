import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/current-user';
import { canManage } from '../../lib/access';
import { db } from '../../lib/db';
import { readSites } from '../../../../packages/domain/src/site-store';
import { DetectionRefresh, ImportForm, SiteSettings } from './forms';
export const dynamic = 'force-dynamic';
export default async function Sites() {
 const user = await currentUser();
 if (!user) redirect('/');
 const sites = await readSites(db,user.id);
 const manage = canManage(user.role);
 return <main className="sites-page"><nav><Link href="/">Home</Link><Link href="/clients">Clients and keywords</Link></nav><h1>Watched sites</h1><p>Sites are shared across the team. Detection previews show discovered links and raw date evidence; they are not a mentions feed.</p>{manage && <><h2>Add one site</h2><ImportForm kind="add"/><details><summary>Bulk paste</summary><ImportForm kind="paste"/></details><details><summary>CSV upload</summary><ImportForm kind="csv"/></details></>}<DetectionRefresh pending={sites.some(site => ['queued','detecting'].includes(site.detection_status))}/>{!sites.length && <p>No watched sites yet.</p>}{sites.map(site => <section key={site.id} id={`site-${site.id}`}><h2>{site.name}</h2><p><a href={site.url} target="_blank" rel="noreferrer">{site.url}</a></p><p>Method: {site.method} · {site.detection_status==='needs_attention' ? 'Needs attention' : site.detection_status} · {site.active ? 'Active' : 'Inactive'}</p><p>Source timezone: {site.source_timezone}{site.detected_at && ` · Last detection: ${new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',dateStyle:'medium',timeStyle:'short'}).format(site.detected_at)} (Dhaka)`}</p>{manage && <SiteSettings site={site}/>}<h3>Latest discovered posts</h3>{site.preview.length>0 ? <ul>{site.preview.map(post => <li key={post.url}><a href={post.url} target="_blank" rel="noreferrer">{post.title}</a>{post.raw_date && <span> · {post.date_kind==='modified' ? 'Modified' : 'Publication evidence'}: {post.raw_date}</span>}</li>)}</ul> : <p>No preview available yet.</p>}{site.detection_status!=='ready' && site.method==='extension' && <p>This site appears to need browser access. Configure a public endpoint or retry later.</p>}{site.endpoints.length>0 && <details><summary>Endpoints</summary><ul>{site.endpoints.map(endpoint => <li key={`${endpoint.kind}:${endpoint.url}`}>{endpoint.kind}: <a href={endpoint.url} target="_blank" rel="noreferrer">{endpoint.url}</a>{endpoint.configured && ' (configured)'}</li>)}</ul></details>}{site.diagnostics.length>0 && <details open={site.detection_status==='needs_attention'}><summary>Detection details</summary><ul>{site.diagnostics.map((message,index) => <li key={index}>{message}</li>)}</ul></details>}</section>)}</main>;
}
