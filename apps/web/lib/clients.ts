import type { Pool } from 'pg';
import { canManage, type Role } from './access';
import { validateClient, validateKeyword, ValidationError } from '../../../packages/domain/src/keywords';
export { ValidationError };
export class AccessError extends Error {}
export class NotFoundError extends Error {}
export function validateId(id: string) {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid ID.');
 return id;
}
export async function clientWorkspace(pool: Pool, userId: string, clientId?: string) {
 await authorize(pool, userId, false);
 const clients = (await pool.query('SELECT * FROM monitor.clients ORDER BY name,id')).rows;
 const selected = clientId ? validateId(clientId) : clients[0]?.id;
 const client = clients.find(row => row.id === selected);
 if (selected && !client) throw new NotFoundError('Client not found.');
 const keywords = client ? (await pool.query('SELECT * FROM monitor.keywords WHERE client_id=$1 ORDER BY term,id', [client.id])).rows : [];
 return { clients, client, keywords };
}
async function authorize(pool: Pool, userId: string, write: boolean) {
 const user = (await pool.query<{ role: Role }>("SELECT role FROM monitor.app_users WHERE id=$1 AND state='active'", [validateId(userId)])).rows[0];
 if (!user || (write && !canManage(user.role))) throw new AccessError('Access denied.');
}
export async function mutateClient(pool: Pool, userId: string, action: 'create' | 'update' | 'delete', id: string, input?: unknown) {
 await authorize(pool, userId, true);
 if (action === 'delete') {
  const result = await pool.query('DELETE FROM monitor.clients WHERE id=$1 RETURNING id', [validateId(id)]);
  if (!result.rowCount) throw new NotFoundError('Client not found.');
  return result.rows[0].id as string;
 }
 const data = validateClient(input);
 const result = action === 'create'
  ? await pool.query('INSERT INTO monitor.clients(name,notes,active,created_by) VALUES($1,$2,$3,$4) RETURNING id', [data.name,data.notes,data.active,userId])
  : await pool.query('UPDATE monitor.clients SET name=$1,notes=$2,active=$3,updated_at=now() WHERE id=$4 RETURNING id', [data.name,data.notes,data.active,validateId(id)]);
 if (!result.rowCount) throw new NotFoundError('Client not found.');
 return result.rows[0].id as string;
}
export async function mutateKeyword(pool: Pool, userId: string, clientId: string, action: 'create' | 'update' | 'delete', id: string, input?: unknown) {
 await authorize(pool, userId, true);
 validateId(clientId);
 if (action === 'delete') {
  const result = await pool.query('DELETE FROM monitor.keywords WHERE id=$1 AND client_id=$2 RETURNING id', [validateId(id),clientId]);
  if (!result.rowCount) throw new NotFoundError('Keyword not found for this client.');
  return;
 }
 const data = validateKeyword(input);
 const values = [data.term,data.aliases,data.exclusions,data.match_type,data.boolean_ast === null ? null : JSON.stringify(data.boolean_ast),data.active,clientId];
 if (action === 'create') {
  const result = await pool.query(`INSERT INTO monitor.keywords(term,aliases,exclusions,match_type,boolean_ast,active,client_id,created_by)
   SELECT $1,$2,$3,$4,$5::jsonb,$6,id,$8 FROM monitor.clients WHERE id=$7 RETURNING id`, [...values,userId]);
  if (!result.rowCount) throw new NotFoundError('Client not found.');
 } else {
  const result = await pool.query(`UPDATE monitor.keywords SET term=$1,aliases=$2,exclusions=$3,match_type=$4,boolean_ast=$5::jsonb,active=$6,
   revision=revision+1,updated_at=now() WHERE client_id=$7 AND id=$8 RETURNING id`, [...values,validateId(id)]);
  if (!result.rowCount) throw new NotFoundError('Keyword not found for this client.');
 }
}
