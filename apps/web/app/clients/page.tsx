import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { currentUser } from '../../lib/current-user';
import { canManage } from '../../lib/access';
import { clientWorkspace, NotFoundError, ValidationError } from '../../lib/clients';
import { db } from '../../lib/db';
import { save } from './actions';
export const dynamic = 'force-dynamic';
type Client = { id: string; name: string; notes: string; active: boolean };
type Keyword = { id: string; term: string; aliases: string[]; exclusions: string[]; match_type: string; boolean_ast: unknown; active: boolean; revision: number };
function Identity({ entity, id, clientId }: { entity: string; id?: string; clientId?: string }) {
 return <><input type="hidden" name="entity" value={entity}/><input type="hidden" name="id" value={id ?? ''}/><input type="hidden" name="client_id" value={clientId ?? ''}/></>;
}
function ClientForm({ client }: { client?: Client }) {
 return <form action={save}><Identity entity="client" id={client?.id}/><label>Name<input name="name" required maxLength={200} defaultValue={client?.name}/></label><label>Notes<textarea name="notes" maxLength={10000} defaultValue={client?.notes}/></label><label><input type="checkbox" name="active" defaultChecked={client?.active ?? true}/> Active</label><button name="action" value={client ? 'update' : 'create'}>{client ? 'Save client' : 'Add client'}</button></form>;
}
function KeywordForm({ clientId, keyword }: { clientId: string; keyword?: Keyword }) {
 return <form action={save}><Identity entity="keyword" id={keyword?.id} clientId={clientId}/><label>Term<input name="term" required maxLength={500} defaultValue={keyword?.term}/></label><label>Aliases (one per line)<textarea name="aliases" defaultValue={keyword?.aliases.join('\n')}/></label><label>Exclusions (one per line)<textarea name="exclusions" defaultValue={keyword?.exclusions.join('\n')}/></label><label>Match type<select name="match_type" defaultValue={keyword?.match_type ?? 'exact'}><option value="exact">Exact phrase</option><option value="any">Any literal</option><option value="boolean">Boolean expression</option></select></label><label>Boolean expression JSON (leave empty for exact/any)<textarea name="boolean_ast" defaultValue={keyword?.boolean_ast ? JSON.stringify(keyword.boolean_ast, null, 2) : ''}/></label><label><input type="checkbox" name="active" defaultChecked={keyword?.active ?? true}/> Active</label><button name="action" value={keyword ? 'update' : 'create'}>{keyword ? 'Save keyword' : 'Add keyword'}</button></form>;
}
function DeleteForm({ entity, id, clientId }: { entity: string; id: string; clientId?: string }) {
 return <details><summary>Delete {entity}</summary><p>{entity === 'client' ? 'Deleting this client also deletes all its keywords.' : 'This permanently deletes this keyword.'}</p><form action={save}><Identity entity={entity} id={id} clientId={clientId}/><button name="action" value="delete">Confirm deletion</button></form></details>;
}
export default async function Clients({ searchParams }: { searchParams: Promise<{ client?: string; error?: string }> }) {
 const user = await currentUser();
 if (!user) redirect('/');
 const params = await searchParams;
 let workspace;
 try { workspace = await clientWorkspace(db,user.id,params.client); }
 catch (error) { if (error instanceof NotFoundError || error instanceof ValidationError) notFound(); throw error; }
 const { clients, client, keywords } = workspace;
 const manage = canManage(user.role);
 return <main><Link href="/">Home</Link><h1>Clients and keywords</h1>{params.error && <p role="alert">{params.error}</p>}<nav aria-label="Select client">{clients.map((item: Client) => <Link key={item.id} href={`/clients?client=${item.id}`} aria-current={client?.id === item.id ? 'page' : undefined}>{item.name}{!item.active && ' (inactive)'} </Link>)}</nav>{!clients.length && <p>No clients yet.</p>}{manage && <details><summary>Add client</summary><ClientForm/></details>}{client && <><h2>{client.name}</h2>{manage ? <><ClientForm client={client}/><DeleteForm entity="client" id={client.id}/></> : <p>{client.notes} · {client.active ? 'Active' : 'Inactive'}</p>}<h2>Keywords</h2><p>Aliases are alternatives; exclusions veto matches. Exact uses phrase boundaries; any uses literal substrings. Boolean uses literal, and, or, and not expressions.</p>{manage && <details><summary>Add keyword</summary><KeywordForm clientId={client.id}/><p>Example: <code>{'{"op":"and","args":[{"op":"literal","value":"ব্র্যান্ড"},{"op":"not","arg":{"op":"literal","value":"চাকরি"}}]}'}</code></p></details>}{!keywords.length && <p>No keywords for this client.</p>}{keywords.map((keyword: Keyword) => <section key={keyword.id}><h3>{keyword.term} · revision {keyword.revision} · {keyword.active ? 'Active' : 'Inactive'}</h3>{manage ? <><KeywordForm clientId={client.id} keyword={keyword}/><DeleteForm entity="keyword" id={keyword.id} clientId={client.id}/></> : <><p>{keyword.match_type} · Aliases: {keyword.aliases.join(', ') || 'None'} · Exclusions: {keyword.exclusions.join(', ') || 'None'}</p>{keyword.boolean_ast != null && <pre>{JSON.stringify(keyword.boolean_ast,null,2)}</pre>}</>}</section>)}</>}</main>;
}
